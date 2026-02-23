import type { Plan, SubTransaction, ChildResult, ExecutionResult } from "./types"
import type { Task } from "../task/Task"
import type { SafetyGate, SafetyCheckResult } from "@roo-code/types"
import delay from "delay"
import * as vscode from "vscode"
import * as path from "path"

export class PlanExecutor {
	private parentBaseCommit: string | undefined
	private parentTxId: string | undefined

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

		// Limit maximum number of sub-transactions to prevent excessive API calls
		const MAX_SUB_TRANSACTIONS = 10
		if (plan.subTransactions.length > MAX_SUB_TRANSACTIONS) {
			provider.log(
				`[PlanExecutor] Plan has ${plan.subTransactions.length} sub-transactions, limiting to ${MAX_SUB_TRANSACTIONS} to prevent excessive API calls`,
			)
			plan.subTransactions = plan.subTransactions.slice(0, MAX_SUB_TRANSACTIONS)
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

		// E2E mode: Execute subtasks sequentially to avoid overwhelming extension host
		const isE2EMode = !!(process.env.TEST_TORTURE_REPO || process.env.TEST_TORTURE_REPO_WORKSPACE)
		if (isE2EMode) {
			provider.log(`[PlanExecutor] E2E mode detected - executing subtasks sequentially`)
		}

		// Track shared worktree for sequential chains (consecutive single-task dependency groups).
		// Sequential tasks reuse the same worktree so each task sees the previous task's files
		// without a merge round-trip. Parallel groups still get isolated worktrees.
		let chainWorktree: { path: string; firstSubTxId: string; lastChild: Task } | undefined

		// 3. Execute each group; consecutive single-task groups share a worktree (chain)
		for (let gi = 0; gi < executionGroups.length; gi++) {
			const group = executionGroups[gi]
			const groupChildTasks: Task[] = []
			try {
				// --- Sequential chain: single-task groups share a worktree ---
				if (group.length === 1) {
					const subTx = group[0]
					provider.log(`[PlanExecutor] Sequential: Starting subtask ${subTx.id}`)

					// Determine the worktree path BEFORE spawning the task.
					// Chain continuations reuse the existing worktree; the first
					// task in a chain gets a fresh one from Control-Plane.
					let worktreePath: string | undefined
					let worktreeTxId: string | undefined

					if (chainWorktree) {
						// Reuse the shared worktree from the previous task
						worktreePath = chainWorktree.path
						worktreeTxId = chainWorktree.lastChild.transactionalTxId
						provider.log(
							`[PlanExecutor] Sequential chain: ${subTx.id} reusing worktree from ${chainWorktree.firstSubTxId}`,
						)
					} else {
						// First in chain — pre-create a fresh worktree
						const wt = await this.createSubTxWorktree(subTx.id, parentTxId)
						if (wt) {
							worktreePath = wt.path
							worktreeTxId = wt.txId
						}
					}

					// Build worktree paths map so spawnChildTasks injects the path
					// into the prompt and sets the cwd in the constructor.
					const worktreePaths = new Map<string, string>()
					if (worktreePath) {
						worktreePaths.set(subTx.id, worktreePath)
					}

					const childTasks = await this.parentTask.spawnChildTasks({
						subTransactions: [subTx],
						worktreePaths: worktreePaths.size > 0 ? worktreePaths : undefined,
					})
					if (childTasks.length === 0) {
						provider.log(`[PlanExecutor] Sequential: No child spawned for ${subTx.id}`)
						failedSubTransactions.push(subTx.id)
						// Flush chain on spawn failure
						if (chainWorktree) {
							try {
								await this.mergeChainWorktree(chainWorktree.firstSubTxId, parentTxId)
							} catch {}
							chainWorktree = undefined
						}
						continue
					}
					const child = childTasks[0]
					groupChildTasks.push(child)

					// Set transactional properties on the child (these are only
					// checked during tool execution, well after the task starts).
					if (worktreePath) {
						child.worktreePath = worktreePath
						child.transactionalTxId = worktreeTxId
						child.skipTransactionalWrites = true
					}

					// Wait for completion
					const childRefs = new Map<string, Task>([[child.taskId, child]])
					const results = await this.parentTask.waitForChildren([child.taskId], childRefs)
					const result = results.get(child.taskId)

					if (!result?.success) {
						provider.log(`[PlanExecutor] Sequential: Subtask ${subTx.id} failed: ${result?.error}`)
						failedSubTransactions.push(subTx.id)
						this.parentTask.removeChildTaskId(child.taskId)
						chainWorktree = undefined // Discard chain on failure
						continue
					}

					provider.log(`[PlanExecutor] Sequential: Subtask ${subTx.id} completed successfully`)

					// Run safety check
					const safetyResult = await this.runSafetyChecks(
						[subTx],
						new Map([[subTx.id, result]]),
						[child],
						parentTxId,
					)
					const gate = safetyResult.get(subTx.id)
					if (gate && !gate.ok) {
						provider.log(`[PlanExecutor] Sequential: Safety gate failed for ${subTx.id}`)
						failedSubTransactions.push(subTx.id)
						await this.rollbackFailedSubTransactions([subTx], new Map([[subTx.id, result]]), parentTxId)
						chainWorktree = undefined
						continue
					}

					// Auto-commit work in the shared worktree
					await this.autoCommitWorktree(child)

					// Check if chain continues (next group is also single-task)
					const nextGroup = gi + 1 < executionGroups.length ? executionGroups[gi + 1] : undefined
					const chainContinues = nextGroup && nextGroup.length === 1

					if (chainContinues) {
						// Chain continues — defer merge, next task will reuse this worktree
						chainWorktree = {
							path: child.cwd || child.worktreePath || "",
							firstSubTxId: chainWorktree?.firstSubTxId || subTx.id,
							lastChild: child,
						}
						this.parentTask.removeChildTaskId(child.taskId)
						provider.log(`[PlanExecutor] Sequential chain: deferring merge for ${subTx.id}`)
					} else {
						// Chain ends — merge the shared worktree into parent
						const mergeId = chainWorktree?.firstSubTxId || subTx.id
						await this.mergeChainWorktree(mergeId, parentTxId)
						chainWorktree = undefined
						this.parentTask.removeChildTaskId(child.taskId)
					}
					continue
				}

				// --- Multi-task group (parallel or E2E sequential) ---
				// Flush any active sequential chain before starting parallel execution
				if (chainWorktree) {
					await this.mergeChainWorktree(chainWorktree.firstSubTxId, parentTxId)
					chainWorktree = undefined
				}

				if (isE2EMode) {
					// E2E mode: process multi-task group one at a time
					for (const subTx of group) {
						provider.log(`[PlanExecutor] E2E: Starting subtask ${subTx.id}`)

						// Pre-create worktree BEFORE spawning the task
						const wt = await this.createSubTxWorktree(subTx.id, parentTxId)
						const worktreePaths = new Map<string, string>()
						if (wt) {
							worktreePaths.set(subTx.id, wt.path)
						}

						const childTasks = await this.parentTask.spawnChildTasks({
							subTransactions: [subTx],
							worktreePaths: worktreePaths.size > 0 ? worktreePaths : undefined,
						})
						if (childTasks.length === 0) {
							provider.log(`[PlanExecutor] E2E: No child spawned for ${subTx.id}`)
							failedSubTransactions.push(subTx.id)
							continue
						}
						const child = childTasks[0]
						groupChildTasks.push(child)

						// Set transactional properties (checked during tool execution)
						if (wt) {
							child.worktreePath = wt.path
							child.transactionalTxId = wt.txId
							child.skipTransactionalWrites = true
						}

						const childRefs = new Map<string, Task>([[child.taskId, child]])
						const results = await this.parentTask.waitForChildren([child.taskId], childRefs)
						const result = results.get(child.taskId)

						if (!result?.success) {
							provider.log(`[PlanExecutor] E2E: Subtask ${subTx.id} failed: ${result?.error}`)
							failedSubTransactions.push(subTx.id)
							this.parentTask.removeChildTaskId(child.taskId)
						} else {
							provider.log(`[PlanExecutor] E2E: Subtask ${subTx.id} completed successfully`)
							const safetyResult = await this.runSafetyChecks(
								[subTx],
								new Map([[subTx.id, result]]),
								[child],
								parentTxId,
							)
							const gate = safetyResult.get(subTx.id)
							if (gate && !gate.ok) {
								provider.log(`[PlanExecutor] E2E: Safety gate failed for ${subTx.id}`)
								failedSubTransactions.push(subTx.id)
								await this.rollbackFailedSubTransactions(
									[subTx],
									new Map([[subTx.id, result]]),
									parentTxId,
								)
							} else {
								await this.autoCommitWorktree(child)
								await this.mergeWorktrees(
									[subTx],
									new Map([[subTx.id, result]]),
									parentTxId,
									safetyResult,
								)
								this.parentTask.removeChildTaskId(child.taskId)
							}
						}
					}
					continue
				}

				// Pre-create ALL worktrees for this parallel group BEFORE spawning any tasks
				const worktreePaths = new Map<string, string>()
				const worktreeInfos = new Map<string, { path: string; txId: string }>()
				await Promise.all(
					group.map(async (subTx) => {
						const wt = await this.createSubTxWorktree(subTx.id, parentTxId)
						if (wt) {
							worktreePaths.set(subTx.id, wt.path)
							worktreeInfos.set(subTx.id, wt)
						}
					}),
				)

				// Spawn all tasks in this group (parallel mode)
				const childTasks = await this.parentTask.spawnChildTasks({
					subTransactions: group,
					worktreePaths: worktreePaths.size > 0 ? worktreePaths : undefined,
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

				// Set transactional properties on each child (checked during tool execution)
				for (const child of childTasks) {
					const subTxId = child.subTransactionId || childToSubTxMap.get(child.taskId)
					if (subTxId) {
						const wt = worktreeInfos.get(subTxId)
						if (wt) {
							child.worktreePath = wt.path
							child.transactionalTxId = wt.txId
							child.skipTransactionalWrites = true
						}
					}
				}

				// Wait for only the children in this group — pass direct references
				// to avoid clineStack lookup race (finishSubTask pops children).
				const groupChildIds = childTasks.map((t) => t.taskId)
				const childRefs = new Map<string, Task>(childTasks.map((t) => [t.taskId, t]))
				const taskResults = await this.parentTask.waitForChildren(groupChildIds, childRefs)

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

				// Auto-commit worktrees for successful children only, then merge into parent.
				// Failed children are skipped - mergeWorktrees will also skip them.
				for (const child of groupChildTasks) {
					const subTxId = child.subTransactionId || childToSubTxMap.get(child.taskId)
					const result = subTxId ? results.get(subTxId) : undefined
					if (result?.success) {
						await this.autoCommitWorktree(child)
					}
				}
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

				// E2E mode: If error is due to blocked Task#ask in child, abort parent immediately
				const isE2EMode = !!(process.env.TEST_TORTURE_REPO || process.env.TEST_TORTURE_REPO_WORKSPACE)
				if (isE2EMode && errorMessage.includes("Blocked Task#ask in e2e mode")) {
					provider.log(
						`[PlanExecutor] E2E mode: Child blocked Task#ask detected - Aborting parent task ${this.parentTask.taskId}`,
					)
					// Abort the parent task immediately
					await this.parentTask.abortTask()
					// Re-throw to propagate the error
					throw error
				}

				// Clean up failed children from tracking
				for (const child of groupChildTasks) {
					this.parentTask.removeChildTaskId(child.taskId)
				}
				// Track failures but don't clean up parent transaction yet - allow subsequent groups to execute
				// Parent transaction will be cleaned up at the end if there are any failures
				chainWorktree = undefined // Discard chain on error
			}
		}

		// Flush any remaining sequential chain worktree after the loop
		if (chainWorktree) {
			try {
				await this.mergeChainWorktree(chainWorktree.firstSubTxId, parentTxId)
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err)
				provider.log(`[PlanExecutor] Failed to merge final chain worktree: ${errMsg}`)
			}
			chainWorktree = undefined
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

		// Debug: check context availability
		console.log(`[PlanExecutor#beginParentTransaction] Provider available: ${!!provider}`)
		console.log(`[PlanExecutor#beginParentTransaction] Context available: ${!!provider?.context}`)
		console.log(`[PlanExecutor#beginParentTransaction] GlobalState available: ${!!provider?.context?.globalState}`)

		// Wait for cpPort to be set (handles race with extension activation)
		// This gives the extension IIFE up to 5 seconds to complete
		let cpPort: number | undefined
		for (let i = 0; i < 10; i++) {
			cpPort = provider?.context?.globalState.get<number>("roo.cpPort")
			console.log(`[PlanExecutor#beginParentTransaction] Attempt ${i + 1}: cpPort = ${cpPort}`)
			if (cpPort) break
			await new Promise((r) => setTimeout(r, 500))
			provider?.log(`[PlanExecutor] Waiting for Control-Plane port (attempt ${i + 1}/10)...`)
		}

		if (!cpPort) {
			provider?.log(`[PlanExecutor] Control-Plane port not found after waiting`)
			return undefined
		}

		try {
			// Use HEAD as base instead of a specific branch name
			// This works regardless of whether the repo uses 'main' or 'master'
			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/begin`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-actor-id": "human",
				},
				body: JSON.stringify({
					isolation: "hybrid",
					base: "HEAD",
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

			// Store base commit and tx ID for cleanup/merge on failure or completion
			this.parentBaseCommit = baseCommit
			this.parentTxId = txId

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
	 * Auto-commit any uncommitted changes in a child's worktree before merge.
	 * This ensures git merge can see all the child's file edits.
	 */
	private async autoCommitWorktree(child: Task): Promise<void> {
		if (!child.cwd) return
		try {
			const simpleGit = (await import("simple-git")).default
			const git = simpleGit(child.cwd, { binary: "git" })
			await git.add(["-A"])
			await git.commit("Auto-commit before merge", { "--allow-empty": null })
		} catch {
			// Ignore — might already be clean
		}
	}

	/**
	 * Merge parent transaction worktree changes back to workspace.
	 * Called after all sub-transactions succeed and are merged into the parent.
	 */
	async mergeParentToWorkspace(): Promise<void> {
		const provider = this.parentTask.providerRef.deref()
		const workspaceDir = this.parentTask.cwd
		const parentWt = this.parentTask.worktreePath
		if (!workspaceDir || !parentWt) {
			provider?.log("[PlanExecutor] Cannot merge to workspace: missing paths")
			return
		}
		try {
			const simpleGit = (await import("simple-git")).default
			const wsGit = simpleGit(workspaceDir, { binary: "git" })

			// Commit any uncommitted workspace changes so git merge won't refuse to run
			try {
				await wsGit.add(["-A"])
				await wsGit.commit("Pre-merge: snapshot workspace state", { "--allow-empty": null })
			} catch {
				// Ignore - workspace may already be clean
			}

			// Proper three-way merge of the parent transaction branch into workspace.
			// Uses the branch name rather than a SHA so git can find the common ancestor.
			const branch = `tx/${this.parentTxId}`
			await wsGit.merge([branch, "--no-ff", "-m", "Planner: merge all sub-transaction changes"])

			provider?.log(`[PlanExecutor] Merged branch ${branch} → workspace`)
		} catch (err: any) {
			provider?.log(`[PlanExecutor] Failed to merge parent worktree to workspace: ${err.message || err}`)
			throw err
		}
	}

	/**
	 * Pre-create a Control-Plane worktree for a sub-transaction BEFORE spawning
	 * the child task.  Returns the worktree path so it can be passed into the
	 * Task constructor (guaranteeing the correct cwd from the first tool call).
	 */
	private async createSubTxWorktree(
		subTxId: string,
		parentTxId: string,
	): Promise<{ path: string; txId: string } | undefined> {
		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort) {
			return undefined
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
			if (data.worktree_path) {
				const compositeTxId = `${parentTxId}_sub_${subTxId}`
				provider?.log(`[PlanExecutor] Pre-created worktree for ${subTxId}: ${data.worktree_path}`)
				return { path: data.worktree_path, txId: compositeTxId }
			}
			return undefined
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			provider?.log(`[PlanExecutor] Failed to pre-create worktree for ${subTxId}: ${errorMessage}`)
			return undefined
		}
	}

	/**
	 * Assign a Control-Plane worktree to a child task
	 * @deprecated Use createSubTxWorktree + worktreePaths map instead
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

			// CRITICAL: Update the child task's cwd and diffViewProvider.cwd to the worktree path.
			// This ensures file writes go to the subtask's worktree, not the workspace root.
			// The worktree will later be merged into the parent transaction via the merge endpoint.
			if (data.worktree_path) {
				childTask.cwd = data.worktree_path
				if (childTask.diffViewProvider) {
					childTask.diffViewProvider.cwd = data.worktree_path
				}
				// Composite tx_id routes DiffViewProvider writes to this sub-tx's
				// CP worktree instead of the parent transaction's worktree.
				childTask.transactionalTxId = `${parentTxId}_sub_${subTxId}`
				// Skip CP shell routing — commands run locally at cwd (the worktree)
				childTask.skipTransactionalWrites = true
				provider?.log(
					`[PlanExecutor] Subtask ${subTxId} cwd updated to worktree: ${data.worktree_path}, txId: ${childTask.transactionalTxId}`,
				)
			}
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

		// Run safety checks for each sub-transaction by calling CP /safety-gate.
		// safetyChecks are literal shell commands generated by the planner.
		for (const subTx of group) {
			if (!subTx.safetyChecks || subTx.safetyChecks.length === 0) {
				safetyResults.set(subTx.id, { ok: true, results: [] })
				continue
			}

			if (!cpPort) {
				provider?.log(`[PlanExecutor] CRITICAL: No CP port - cannot run safety checks for ${subTx.id}`)
				safetyResults.set(subTx.id, { ok: false, results: [], failedAt: "NO_CP_PORT" })
				continue
			}

			try {
				const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/sub-tx/${subTx.id}/safety-gate`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Actor-Id": "human" },
					body: JSON.stringify({ checks: subTx.safetyChecks }),
					signal: AbortSignal.timeout(300_000), // 5 min per sub-tx gate
				})
				if (!res.ok) {
					const text = await res.text()
					provider?.log(`[PlanExecutor] Safety-gate HTTP error for ${subTx.id}: ${text}`)
					safetyResults.set(subTx.id, { ok: false, results: [], failedAt: `HTTP_${res.status}` })
				} else {
					const gate = await res.json()
					provider?.log(
						`[PlanExecutor] Safety gate for ${subTx.id}: ${gate.ok ? "PASSED" : `FAILED at ${gate.failedAt}`}`,
					)
					safetyResults.set(subTx.id, gate)
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				provider?.log(`[PlanExecutor] Safety-gate error for ${subTx.id}: ${msg}`)
				safetyResults.set(subTx.id, { ok: false, results: [], failedAt: `ERROR: ${msg}` })
			}
		}

		return safetyResults
	}

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
	 * Merge a sequential chain's shared worktree into the parent transaction.
	 * The chain's first sub-tx owns the git branch; all subsequent tasks in the
	 * chain committed to that same branch, so one merge captures all their work.
	 */
	private async mergeChainWorktree(firstSubTxId: string, parentTxId: string): Promise<void> {
		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort) {
			return
		}

		try {
			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/sub-tx/${firstSubTxId}/merge`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify({}),
			})

			if (!res.ok) {
				const errorText = await res.text()
				provider?.log(`[PlanExecutor] Chain merge failed for ${firstSubTxId}: ${errorText}`)
			} else {
				provider?.log(`[PlanExecutor] Sequential chain merged via ${firstSubTxId}`)
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			provider?.log(`[PlanExecutor] Chain merge error for ${firstSubTxId}: ${errorMessage}`)
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
	 * Rollback ALL sub-transactions from a plan (used when planner fails catastrophically)
	 * This ensures all worktrees are cleaned up even if execution didn't complete
	 */
	async rollbackAllSubTransactions(plan: Plan, parentTxId: string): Promise<void> {
		const provider = this.parentTask.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")

		if (!cpPort || !plan.subTransactions || plan.subTransactions.length === 0) {
			return
		}

		provider?.log(
			`[PlanExecutor] Rolling back all ${plan.subTransactions.length} sub-transactions due to planner failure`,
		)

		// Rollback all sub-transactions in parallel (faster cleanup)
		await Promise.all(
			plan.subTransactions.map(async (subTx) => {
				try {
					const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/sub-tx/${subTx.id}/rollback`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Actor-Id": "human",
						},
						body: JSON.stringify({
							reason: "Planner mode failed - cleaning up all sub-transactions",
							failureKind: "RUNTIME_ERROR",
						}),
					})

					// 404 is OK - sub-transaction may not have been created yet
					if (!res.ok && res.status !== 404) {
						const errorText = await res.text()
						provider?.log(`[PlanExecutor] Failed to rollback ${subTx.id}: ${errorText}`)
					} else {
						provider?.log(`[PlanExecutor] Rolled back sub-transaction ${subTx.id}`)
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					provider?.log(`[PlanExecutor] Error rolling back ${subTx.id}: ${errorMessage}`)
					// Continue with other rollbacks even if one fails
				}
			}),
		)
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
