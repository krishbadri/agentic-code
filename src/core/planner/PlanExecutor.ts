import type { Plan, SubTransaction, ChildResult, ExecutionResult } from "./types"
import type { Task } from "../task/Task"
import type { SafetyGate, SafetyCheckResult } from "@agentic-code/types"
import delay from "delay"
import * as vscode from "vscode"
import * as path from "path"

export class PlanExecutor {
	private parentBaseCommit: string | undefined

	constructor(private parentTask: Task) {}

	async executePlan(plan: Plan): Promise<ExecutionResult> {
		const provider = this.parentTask.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}

		// Validate plan has sub-transactions
		if (!plan.subTransactions || plan.subTransactions.length === 0) {
			provider.log("[PlanExecutor] Plan has no sub-transactions")
			return { success: true, parentTxId: undefined }
		}

		// 1. Create Control-Plane transaction for parent
		// CRITICAL: Control-Plane is REQUIRED for planner mode
		// Without it, we cannot provide safety checks, rollback, or audit trail
		const parentTxId = await this.beginParentTransaction()
		if (!parentTxId) {
			// P0 FIX: Fail fast - do NOT fall back to unsafe sequential execution
			const errorMessage =
				"Planner execution requires Control-Plane. " +
				"Falling back to unsafe sequential mode is disabled. " +
				"Please ensure Control-Plane is running (check 'roo.cpPort' in VS Code settings)."
			provider.log(`[PlanExecutor] CRITICAL: ${errorMessage}`)
			throw new Error(errorMessage)
		}

		// P1 FIX: Persist the plan for auditability
		// Plans must survive restarts and be queryable
		await this.persistPlan(parentTxId, plan)

		// Start timing for parallel execution metrics
		const parallelStartTime = Date.now()

		// 2. Group sub-transactions by dependency level (for parallel execution)
		const executionGroups = this.groupByDependencies(plan.subTransactions)

		const failedSubTransactions: string[] = []

		// 3. Execute each group sequentially, but tasks within group run in parallel
		for (const group of executionGroups) {
			const groupChildTasks: Task[] = []
			try {
				// Spawn all tasks in this group
				const childTasks = await this.parentTask.spawnChildTasks({
					subTransactions: group,
				})
				groupChildTasks.push(...childTasks)

				// Check if any children spawned
				if (childTasks.length === 0) {
					provider.log(
						`[PlanExecutor] Warning: No children spawned for group: ${group.map((stx) => stx.id).join(", ")}`,
					)
					failedSubTransactions.push(...group.map((stx) => stx.id))
					continue // Skip to next group
				}

				// Store mapping of child task ID to sub-transaction ID
				const childToSubTxMap = new Map<string, string>()
				childTasks.forEach((child) => {
					if (child.subTransactionId) {
						childToSubTxMap.set(child.taskId, child.subTransactionId)
					}
				})

				// Each child gets its own Control-Plane worktree
				await Promise.all(
					childTasks.map(async (child) => {
						const subTxId = child.subTransactionId || childToSubTxMap.get(child.taskId)
						if (subTxId) {
							await this.assignWorktree(child, subTxId, parentTxId)
						}
					}),
				)

				// Wait for only the children in this group
				const groupChildIds = childTasks.map((t) => t.taskId)
				const taskResults = await this.parentTask.waitForChildren(groupChildIds)

				// Convert results map from task ID keys to sub-transaction ID keys
				const results = new Map<string, ChildResult>()
				for (const [taskId, result] of taskResults) {
					const subTxId = childToSubTxMap.get(taskId)
					if (subTxId) {
						results.set(subTxId, result)
					} else {
						provider.log(
							`[PlanExecutor] Warning: No sub-transaction ID found for task ${taskId}, using task ID as fallback`,
						)
						results.set(taskId, result) // Fallback to task ID
					}
				}

				// Clean up failed children from parent's tracking
				for (const [taskId, result] of taskResults) {
					if (!result.success) {
						this.parentTask.removeChildTaskId(taskId)
					}
				}

				// Run safety checks for this group via Control-Plane safety-gate
				const safetyResults = await this.runSafetyChecks(group, results, childTasks, parentTxId)

				// Check if any safety gates failed
				const failedGates: string[] = []
				for (const [subTxId, gate] of safetyResults) {
					if (!gate.ok) {
						failedGates.push(subTxId)
						provider.log(`[PlanExecutor] Safety gate FAILED for ${subTxId}: ${gate.failedAt}`)
					}
				}

				if (failedGates.length > 0) {
					// Rollback failed sub-transactions
					await this.rollbackFailedSubTransactions(group, results, parentTxId)
					failedSubTransactions.push(...failedGates)
					// Don't clean up parent transaction yet - allow subsequent groups to execute
					// Parent transaction will be cleaned up at the end if there are any failures
					throw new Error(`Safety checks failed for: ${failedGates.join(", ")}`)
				}

				// Merge successful worktrees into parent, passing safety gate results
				await this.mergeWorktrees(group, results, parentTxId, safetyResults)

				// Clean up successful children from tracking
				for (const child of groupChildTasks) {
					const subTxId = child.subTransactionId || childToSubTxMap.get(child.taskId)
					if (subTxId && results.get(subTxId)?.success) {
						this.parentTask.removeChildTaskId(child.taskId)
					}
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`[PlanExecutor] Error executing group: ${errorMessage}`)
				// Clean up failed children from tracking
				for (const child of groupChildTasks) {
					this.parentTask.removeChildTaskId(child.taskId)
				}
				// Track failures but don't clean up parent transaction yet - allow subsequent groups to execute
				// Parent transaction will be cleaned up at the end if there are any failures
			}
		}

		// If execution failed completely, clean up parent transaction
		if (failedSubTransactions.length > 0 && parentTxId) {
			await this.cleanupParentTransaction(parentTxId)
		}

		// Record execution metrics for parallel speedup analysis
		const wallClockMs = Date.now() - parallelStartTime
		await this.recordExecutionMetrics(parentTxId, "parallel", plan.subTransactions.length, wallClockMs)

		return {
			success: failedSubTransactions.length === 0,
			parentTxId,
			failedSubTransactions: failedSubTransactions.length > 0 ? failedSubTransactions : undefined,
		}
	}

	/**
	 * Sequential execution is DISABLED for planner mode.
	 *
	 * Design constraints (non-negotiable):
	 * - Do not silently degrade to unsafe execution
	 * - Fail fast is always preferred over best-effort
	 * - Safety + rollback + auditability are invariants
	 *
	 * This method exists only for documentation purposes and always throws.
	 * @deprecated Sequential fallback is disabled - use Control-Plane
	 */
	private async executePlanSequential(_plan: Plan): Promise<ExecutionResult> {
		// P0 FIX: This method should NEVER be called
		// It violates core safety guarantees:
		// 1. No safety checks are executed
		// 2. No rollback mechanism exists
		// 3. No audit trail is produced
		throw new Error(
			"CRITICAL: Sequential fallback for planner mode is disabled. " +
				"Planner execution requires Control-Plane for: " +
				"(1) safety checks, (2) rollback, (3) audit trail. " +
				"This is a design invariant - do not remove this check.",
		)
	}

	/**
	 * Begin a parent transaction in Control-Plane
	 */
	private async beginParentTransaction(): Promise<string | undefined> {
		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort) {
			return undefined
		}

		try {
			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/begin`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify({
					isolation: "hybrid",
					base: "main",
				}),
			})

			if (!res.ok) {
				throw new Error(`Failed to begin transaction: ${res.status}`)
			}

			const data = await res.json()
			const txId = data.tx_id
			const baseCommit = data.base_commit

			// Store transaction ID in global state
			await provider?.context?.globalState.update("roo.current_tx_id", txId)
			this.parentTask.worktreePath = data.worktree_path

			// Store base commit for cleanup on failure
			this.parentBaseCommit = baseCommit

			return txId
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			provider?.log(`[PlanExecutor] Failed to begin parent transaction: ${errorMessage}`)
			return undefined
		}
	}

	/**
	 * Group sub-transactions by dependency level using topological sort
	 */
	groupByDependencies(subTxs: SubTransaction[]): SubTransaction[][] {
		const groups: SubTransaction[][] = []
		const processed = new Set<string>()
		const subTxMap = new Map<string, SubTransaction>()

		// Create map for quick lookup
		for (const subTx of subTxs) {
			subTxMap.set(subTx.id, subTx)
		}

		// Topological sort: process levels until all are processed
		while (processed.size < subTxs.length) {
			const currentLevel = subTxs.filter((stx) => {
				// Already processed
				if (processed.has(stx.id)) {
					return false
				}

				// No dependencies, or all dependencies are processed
				if (!stx.dependsOn || stx.dependsOn.length === 0) {
					return true
				}

				return stx.dependsOn.every((dep) => processed.has(dep))
			})

			if (currentLevel.length === 0) {
				// Circular dependency or missing dependency - add remaining items
				const remaining = subTxs.filter((stx) => !processed.has(stx.id))
				if (remaining.length > 0) {
					const provider = this.parentTask.providerRef.deref()
					provider?.log(
						`[PlanExecutor] Warning: Circular dependency or missing dependency detected. Remaining sub-transactions: ${remaining.map((stx) => stx.id).join(", ")}`,
					)
					groups.push(remaining)
					remaining.forEach((stx) => processed.add(stx.id))
				}
				break
			}

			groups.push(currentLevel)
			currentLevel.forEach((stx) => processed.add(stx.id))
		}

		return groups
	}

	/**
	 * Assign a Control-Plane worktree to a child task
	 */
	private async assignWorktree(childTask: Task, subTxId: string, parentTxId: string): Promise<void> {
		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort) {
			return
		}

		try {
			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/sub-tx/${subTxId}/begin`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify({
					base: parentTxId,
				}),
			})

			if (!res.ok) {
				const errorText = await res.text()
				throw new Error(`Failed to create sub-transaction worktree: ${errorText}`)
			}

			const data = await res.json()
			childTask.worktreePath = data.worktree_path
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			provider?.log(`[PlanExecutor] Failed to assign worktree to ${subTxId}: ${errorMessage}`)
			// Don't throw - allow task to continue without worktree isolation
		}
	}

	/**
	 * Run safety checks for a group of sub-transactions via Control-Plane safety-gate
	 *
	 * This is a CRITICAL gate - if safetyChecks are defined and they fail,
	 * the sub-transaction CANNOT be merged.
	 *
	 * @returns Map of sub-transaction ID to SafetyGate result
	 */
	private async runSafetyChecks(
		group: SubTransaction[],
		results: Map<string, ChildResult>,
		childTasks: Task[],
		parentTxId: string,
	): Promise<Map<string, SafetyGate>> {
		const safetyResults = new Map<string, SafetyGate>()
		const provider = this.parentTask.providerRef.deref()

		if (!provider) {
			// No provider - mark all with checks as failed
			for (const subTx of group) {
				if (subTx.safetyChecks?.length) {
					safetyResults.set(subTx.id, {
						ok: false,
						results: [],
						failedAt: "NO_PROVIDER",
					})
				} else {
					safetyResults.set(subTx.id, { ok: true, results: [] })
				}
			}
			return safetyResults
		}

		const cpPort = provider.context?.globalState.get<number>("roo.cpPort")

		// Run safety checks for each sub-transaction in the group
		for (const subTx of group) {
			// If no safety checks defined, auto-pass
			if (!subTx.safetyChecks || subTx.safetyChecks.length === 0) {
				safetyResults.set(subTx.id, { ok: true, results: [] })
				continue
			}

			const result = results.get(subTx.id)
			if (!result || !result.success) {
				// Skip safety checks for failed tasks - they won't be merged anyway
				safetyResults.set(subTx.id, {
					ok: false,
					results: [],
					failedAt: "TASK_FAILED",
				})
				continue
			}

			// Use Control-Plane safety-gate endpoint
			// P0 FIX: Control-Plane is REQUIRED - no fallback to legacy unsafe behavior
			if (!cpPort) {
				// This should never happen because executePlan() already checks for Control-Plane
				throw new Error(
					"CRITICAL: Control-Plane not available during safety checks. " +
						"This indicates a programming error - executePlan() should have already failed.",
				)
			}

			try {
				provider.log(
					`[PlanExecutor] Calling safety-gate for ${subTx.id} with checks: ${subTx.safetyChecks.join(", ")}`,
				)

				const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/sub-tx/${subTx.id}/safety-gate`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Actor-Id": "human",
					},
					body: JSON.stringify({ checks: subTx.safetyChecks }),
				})

				if (!res.ok) {
					const errorText = await res.text()
					provider.log(`[PlanExecutor] Safety-gate HTTP error for ${subTx.id}: ${errorText}`)
					safetyResults.set(subTx.id, {
						ok: false,
						results: [],
						failedAt: `HTTP_ERROR: ${res.status}`,
					})
					continue
				}

				const gate = (await res.json()) as SafetyGate
				safetyResults.set(subTx.id, gate)

				if (gate.ok) {
					provider.log(`[PlanExecutor] Safety gate PASSED for ${subTx.id}`)
				} else {
					provider.log(`[PlanExecutor] Safety gate FAILED for ${subTx.id} at: ${gate.failedAt}`)
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`[PlanExecutor] Safety-gate error for ${subTx.id}: ${errorMessage}`)
				safetyResults.set(subTx.id, {
					ok: false,
					results: [],
					failedAt: `ERROR: ${errorMessage}`,
				})
			}
		}

		return safetyResults
	}

	// Legacy safety check method REMOVED (P0 fix)
	// All safety checks MUST go through Control-Plane's /safety-gate endpoint
	// This ensures: enforcement, auditability, and consistent behavior

	/**
	 * P1 FIX: Persist the generated plan to Control-Plane
	 *
	 * Plans must survive restarts and be queryable for:
	 * - Auditability: "What plan was executed?"
	 * - Reproducibility: "Can we re-execute this plan?"
	 * - Correlation: "Which sub-transactions came from this plan?"
	 */
	private async persistPlan(parentTxId: string, plan: Plan): Promise<void> {
		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort) {
			provider?.log("[PlanExecutor] Warning: Cannot persist plan - no Control-Plane port")
			return
		}

		try {
			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/plan`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify({
					title: plan.title,
					summary: plan.summary,
					plan_json: plan,
					sub_tx_count: plan.subTransactions?.length ?? 0,
				}),
			})

			if (!res.ok) {
				const errorText = await res.text()
				provider?.log(`[PlanExecutor] Warning: Failed to persist plan: ${errorText}`)
			} else {
				provider?.log(`[PlanExecutor] Plan persisted for transaction ${parentTxId}`)
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			provider?.log(`[PlanExecutor] Warning: Could not persist plan: ${errorMessage}`)
			// Don't throw - plan persistence is important but shouldn't block execution
		}
	}

	/**
	 * Merge successful sub-transaction worktrees into parent
	 *
	 * CRITICAL: The merge endpoint REQUIRES a passing SafetyGate if safetyChecks were defined.
	 * This ensures that untested code cannot be merged.
	 */
	private async mergeWorktrees(
		group: SubTransaction[],
		results: Map<string, ChildResult>,
		parentTxId: string,
		safetyResults: Map<string, SafetyGate>,
	): Promise<void> {
		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort) {
			return
		}

		// Merge each successful sub-transaction
		for (const subTx of group) {
			const result = results.get(subTx.id)
			if (!result || !result.success) {
				continue
			}

			// Get the safety gate result for this sub-transaction
			const safetyGate = safetyResults.get(subTx.id)

			// CRITICAL: Do not attempt merge if safety gate failed
			if (safetyGate && !safetyGate.ok) {
				provider?.log(`[PlanExecutor] Skipping merge for ${subTx.id} - safety gate failed`)
				continue
			}

			try {
				const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/sub-tx/${subTx.id}/merge`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Actor-Id": "human",
					},
					body: JSON.stringify({
						// Pass the safety gate result to the merge endpoint
						// The endpoint will verify this matches what it expects
						safetyGate: safetyGate,
					}),
				})

				if (!res.ok) {
					const errorText = await res.text()
					// Check for safety gate enforcement
					if (res.status === 403) {
						provider?.log(
							`[PlanExecutor] Merge BLOCKED for ${subTx.id} - safety gate enforcement: ${errorText}`,
						)
					} else {
						throw new Error(`Failed to merge sub-transaction: ${errorText}`)
					}
					continue
				}

				provider?.log(`[PlanExecutor] Successfully merged sub-transaction ${subTx.id}`)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider?.log(`[PlanExecutor] Failed to merge ${subTx.id}: ${errorMessage}`)
				// Continue with other merges even if one fails
			}
		}
	}

	/**
	 * Clean up parent transaction on failure
	 * This method is idempotent - safe to call multiple times
	 */
	private async cleanupParentTransaction(parentTxId: string | undefined): Promise<void> {
		if (!parentTxId) return

		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort) return

		// Check if transaction still exists (idempotent cleanup)
		const currentTxId = provider?.context?.globalState.get<string>("roo.current_tx_id")
		if (currentTxId !== parentTxId) {
			// Transaction already cleaned up or changed
			return
		}

		try {
			// Rollback parent transaction to base commit if we have it
			if (this.parentBaseCommit) {
				const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/rollback`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Actor-Id": "human" },
					body: JSON.stringify({ hash: this.parentBaseCommit }),
				})

				if (!res.ok) {
					const errorText = await res.text()
					provider?.log(`[PlanExecutor] Failed to rollback parent transaction: ${errorText}`)
				}
			}

			// Clear transaction ID from global state
			await provider?.context?.globalState.update("roo.current_tx_id", undefined)
			provider?.log(`[PlanExecutor] Cleaned up parent transaction ${parentTxId}`)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			provider?.log(`[PlanExecutor] Failed to cleanup parent transaction: ${errorMessage}`)
		}
	}

	/**
	 * Rollback failed sub-transactions
	 */
	private async rollbackFailedSubTransactions(
		group: SubTransaction[],
		results: Map<string, ChildResult>,
		parentTxId: string,
	): Promise<void> {
		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort) {
			return
		}

		// Rollback each failed sub-transaction
		for (const subTx of group) {
			const result = results.get(subTx.id)
			if (result && !result.success) {
				try {
					const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/sub-tx/${subTx.id}/rollback`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Actor-Id": "human",
						},
					})

					if (!res.ok) {
						const errorText = await res.text()
						throw new Error(`Failed to rollback sub-transaction: ${errorText}`)
					}

					provider?.log(`[PlanExecutor] Successfully rolled back sub-transaction ${subTx.id}`)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					provider?.log(`[PlanExecutor] Failed to rollback ${subTx.id}: ${errorMessage}`)
				}
			}
		}
	}

	/**
	 * Record execution metrics for parallel vs serial comparison
	 */
	private async recordExecutionMetrics(
		parentTxId: string,
		executionMode: "parallel" | "serial",
		subTxCount: number,
		wallClockMs: number,
	): Promise<void> {
		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort) {
			return
		}

		try {
			await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/metric/execution`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify({
					execution_mode: executionMode,
					sub_tx_count: subTxCount,
					total_duration_ms: wallClockMs, // In parallel mode, wall clock ≈ total
					wall_clock_ms: wallClockMs,
				}),
			})
			provider?.log(
				`[PlanExecutor] Recorded execution metrics: ${executionMode}, ${subTxCount} sub-txns, ${wallClockMs}ms`,
			)
		} catch {
			// Ignore metrics errors - they're best-effort
		}
	}
}
