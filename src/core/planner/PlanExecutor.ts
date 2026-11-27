import type { Clause } from "@roo-code/types"

import type { Plan, SubTransaction, ExecutionResult } from "./types"
import type { Task } from "../task/Task"

import {
	ControlPlaneUnavailableError,
	cpErrorMessage,
	getCpPort,
	isControlPlaneUnavailableError,
} from "../control-plane/client"
import * as cpTx from "../control-plane/tx"
import { detectProjectCommands } from "../checkpoints/QualityGate"

/** A pre-created sub-transaction worktree. `txId` is the `<parent>_sub_<rel>` id addressing it. */
export interface SubTxWorktree {
	path: string
	txId: string
}

const MAX_SUB_TRANSACTIONS = 10

/**
 * Executes a plan inside the parent task's transaction.
 *
 * Every dependency group runs the same pipeline (E2E mode is the same path
 * with concurrency 1):
 *
 *   begin worktrees → spawn children → wait → safety gate → merge-pipeline
 *   → progress checkpoint on the parent
 *
 * Any failure (worktree creation, runtime, safety gate, merge rejection,
 * progress violation) fails the group; remaining groups are skipped, every
 * sub-transaction is rolled back and the parent is reset to its base. The
 * caller (Task) then aborts the transaction and reports the failures.
 */
export class PlanExecutor {
	private parentBaseCommit: string | undefined
	private parentTxId: string | undefined
	private port: number | undefined
	private warnedNoDefaultClause = false

	constructor(private parentTask: Task) {}

	private log(msg: string) {
		this.parentTask.providerRef.deref()?.log(`[PlanExecutor] ${msg}`)
	}

	async executePlan(plan: Plan): Promise<ExecutionResult> {
		const provider = this.parentTask.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}

		if (!plan.subTransactions || plan.subTransactions.length === 0) {
			this.log("Plan has no sub-transactions")
			return { success: true, parentTxId: undefined }
		}

		if (plan.subTransactions.length > MAX_SUB_TRANSACTIONS) {
			this.log(
				`Plan has ${plan.subTransactions.length} sub-transactions, limiting to ${MAX_SUB_TRANSACTIONS} to prevent excessive API calls`,
			)
			plan.subTransactions = plan.subTransactions.slice(0, MAX_SUB_TRANSACTIONS)
		}

		// The plan runs inside the parent task's own transaction.
		const parentTxId = this.parentTask.txId
		if (!parentTxId) {
			throw new ControlPlaneUnavailableError(
				"Planner execution requires the parent task's Control-Plane transaction",
			)
		}
		const port = getCpPort(provider.context)
		if (!port) {
			throw new ControlPlaneUnavailableError("Planner execution requires the Control-Plane, which is unavailable")
		}
		this.parentTxId = parentTxId
		this.parentBaseCommit = this.parentTask.txBaseCommit
		this.port = port
		this.parentTask.worktreePath = this.parentTask.cwd

		await this.persistPlan(parentTxId, plan)

		const isE2EMode = !!(process.env.TEST_TORTURE_REPO || process.env.TEST_TORTURE_REPO_WORKSPACE)
		const concurrency = isE2EMode ? 1 : Number.POSITIVE_INFINITY
		const failures = new Map<string, string>()
		const durations: number[] = []
		const wallStart = Date.now()

		const groups = this.groupByDependencies(plan.subTransactions)
		for (const group of groups) {
			if (failures.size > 0) {
				// Fail fast: never run a later group on top of a failed one.
				for (const stx of group) {
					if (!failures.has(stx.id)) failures.set(stx.id, "SKIPPED: an earlier group failed")
				}
				continue
			}
			try {
				await this.executeGroup(group, failures, durations, concurrency)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				this.log(`Error executing group: ${errorMessage}`)

				if (isE2EMode && errorMessage.includes("Blocked Task#ask in e2e mode")) {
					await this.parentTask.abortTask()
					throw error
				}
				if (isControlPlaneUnavailableError(error)) {
					await this.rollbackAllSubTransactions(plan, parentTxId)
					throw error
				}
				for (const stx of group) {
					if (!failures.has(stx.id)) failures.set(stx.id, `ERROR: ${errorMessage}`)
				}
				await this.rollbackFailedSubTransactions(
					group.map((s) => s.id),
					"RUNTIME_ERROR",
				)
			}
		}

		if (failures.size > 0) {
			await this.rollbackAllSubTransactions(plan, parentTxId)
			await this.cleanupParentTransaction(parentTxId)
		}

		const wallClockMs = Date.now() - wallStart
		await this.recordExecutionMetrics(
			parentTxId,
			isE2EMode ? "serial" : "parallel",
			plan.subTransactions.length,
			durations.reduce((a, b) => a + b, 0),
			wallClockMs,
		)

		const failed = [...failures.keys()]
		return {
			success: failed.length === 0,
			parentTxId,
			failedSubTransactions: failed.length > 0 ? failed : undefined,
			failures: failed.length > 0 ? failed.map((id) => ({ subTxId: id, reason: failures.get(id)! })) : undefined,
		}
	}

	/** One dependency group through the full pipeline. Records failures in `failures`. */
	private async executeGroup(
		group: SubTransaction[],
		failures: Map<string, string>,
		durations: number[],
		concurrency: number,
	): Promise<void> {
		// 1. Begin a worktree for every sub-transaction. No worktree → never spawned.
		const worktrees = new Map<string, SubTxWorktree>()
		await Promise.all(
			group.map(async (stx) => {
				try {
					worktrees.set(stx.id, await this.createSubTxWorktree(stx))
				} catch (error) {
					if (isControlPlaneUnavailableError(error)) throw error
					failures.set(
						stx.id,
						`WORKTREE_CREATE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}),
		)

		// 2./3. Spawn and wait (concurrency 1 in E2E mode).
		const runnable = group.filter((stx) => worktrees.has(stx.id))
		const children = new Map<string, Task>()
		const succeeded: SubTransaction[] = []

		const runBatch = async (batch: SubTransaction[]) => {
			const start = Date.now()
			const spawned = await this.parentTask.spawnChildTasks({ subTransactions: batch, worktrees })
			for (const child of spawned) {
				if (child.subTransactionId) children.set(child.subTransactionId, child)
			}
			await Promise.all(
				batch.map(async (stx) => {
					const child = children.get(stx.id)
					if (!child) {
						failures.set(stx.id, "SPAWN_FAILED: child task was not created")
						return
					}
					const results = await this.parentTask.waitForChildren(
						[child.taskId],
						new Map([[child.taskId, child]]),
					)
					const result = results.get(child.taskId)
					const durationMs = Date.now() - start
					durations.push(durationMs)
					if (result?.success) {
						succeeded.push(stx)
					} else {
						failures.set(stx.id, `RUNTIME_FAILED: ${result?.error ?? "task failed or was aborted"}`)
					}
				}),
			)
		}

		try {
			if (concurrency <= 1) {
				for (const stx of runnable) await runBatch([stx])
			} else if (runnable.length > 0) {
				await runBatch(runnable)
			}

			// Commit each child's work in its worktree so the merge sees it.
			for (const stx of succeeded) {
				const child = children.get(stx.id)
				if (child) await this.autoCommitWorktree(child)
			}

			// 4. Safety gate (default clause when the LLM gave none).
			const gated: SubTransaction[] = []
			for (const stx of succeeded) {
				const gate = await this.runSafetyGate(stx)
				if (gate.ok) gated.push(stx)
				else failures.set(stx.id, `SAFETY_GATE_FAILED: ${gate.reason}`)
			}

			// Roll back everything in this group that failed so far.
			const failedNow = group.map((s) => s.id).filter((id) => failures.has(id) && worktrees.has(id))
			if (failedNow.length > 0) await this.rollbackFailedSubTransactions(failedNow, "RUNTIME_ERROR")

			// 5. Merge through the pipeline; every non-merged entry is a failure.
			if (gated.length > 0) {
				const merged = await this.mergeWorktrees(gated, failures)

				// 6. Progress checkpoint on the parent after a merged group (R4/R5/R7).
				if (merged.length > 0) {
					const res = await cpTx.checkpoint(this.port!, this.parentTxId!, { reason: "plan-group" })
					if (!res.ok) {
						const reason =
							res.status === 403
								? `PROGRESS_VIOLATION: ${cpErrorMessage(res)}`
								: `CHECKPOINT_FAILED: ${cpErrorMessage(res)}`
						for (const id of merged) failures.set(id, reason)
					}
				}
			}
		} finally {
			for (const child of children.values()) this.parentTask.removeChildTaskId(child.taskId)
		}
	}

	/**
	 * Group sub-transactions by dependency level using topological sort
	 */
	groupByDependencies(subTxs: SubTransaction[]): SubTransaction[][] {
		const groups: SubTransaction[][] = []
		const processed = new Set<string>()

		while (processed.size < subTxs.length) {
			const currentLevel = subTxs.filter((stx) => {
				if (processed.has(stx.id)) return false
				if (!stx.dependsOn || stx.dependsOn.length === 0) return true
				return stx.dependsOn.every((dep) => processed.has(dep))
			})

			if (currentLevel.length === 0) {
				// Circular or missing dependency - add remaining items as one last group
				const remaining = subTxs.filter((stx) => !processed.has(stx.id))
				if (remaining.length > 0) {
					this.log(
						`Warning: Circular dependency or missing dependency detected. Remaining sub-transactions: ${remaining.map((stx) => stx.id).join(", ")}`,
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
	 * Commit any uncommitted changes in a child's worktree before merge.
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
	 * Pre-create the CP worktree for a sub-transaction BEFORE spawning the child,
	 * sending its planning metadata. Throws on failure.
	 */
	private async createSubTxWorktree(stx: SubTransaction): Promise<SubTxWorktree> {
		const parentTxId = this.parentTxId!
		const res = await cpTx.subTxBegin(this.port!, parentTxId, stx.id, {
			base: parentTxId,
			title: stx.title,
			description: stx.description,
			agentType: stx.agentType,
			prompt: stx.prompt,
			dependsOn: stx.dependsOn,
			safetyChecks: stx.safetyChecks,
		})
		if (!res.ok) throw new Error(cpErrorMessage(res))
		if (!res.data?.worktree_path) throw new Error("Control-Plane returned no worktree_path")
		this.log(`Pre-created worktree for ${stx.id}: ${res.data.worktree_path}`)
		return { path: res.data.worktree_path, txId: `${parentTxId}_sub_${stx.id}` }
	}

	/** The clause used when the planner gave no checks: compile, else test; undefined if neither is known. */
	private defaultSafetyClause(): Clause | undefined {
		const { compileCommand, testCommand } = detectProjectCommands(this.parentTask.cwd)
		if (compileCommand) return { type: "cmd_exits_0", cmd: compileCommand }
		if (testCommand) return { type: "cmd_exits_0", cmd: testCommand }
		return undefined
	}

	/**
	 * Run the CP safety gate for one sub-transaction (fail-closed). A planner
	 * clause and checks are sent together (the CP evaluates both).
	 */
	private async runSafetyGate(stx: SubTransaction): Promise<{ ok: boolean; reason?: string }> {
		const body: { checks?: string[]; clause?: Clause } = {}
		if (stx.safetyChecks && stx.safetyChecks.length > 0) body.checks = stx.safetyChecks
		if (stx.safetyClause) body.clause = stx.safetyClause
		if (!body.checks && !body.clause) {
			const clause = this.defaultSafetyClause()
			if (!clause) {
				if (!this.warnedNoDefaultClause) {
					this.warnedNoDefaultClause = true
					await this.parentTask.say(
						"text",
						"⚠ No safety checks were planned and no compile/test command was detected; sub-transactions are merged without a safety gate.",
					)
				}
				return { ok: true }
			}
			body.clause = clause
		}

		const res = await cpTx.subTxSafetyGate(this.port!, this.parentTxId!, stx.id, body)
		if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${cpErrorMessage(res)}` }
		const gate = res.data
		this.log(`Safety gate for ${stx.id}: ${gate.ok ? "PASSED" : `FAILED at ${gate.failedAt}`}`)
		if (gate.ok) return { ok: true }
		return { ok: false, reason: String(gate.reason ?? gate.error ?? gate.failedAt ?? "safety gate failed") }
	}

	/** Persist the generated plan to the CP for auditability (best effort). */
	private async persistPlan(parentTxId: string, plan: Plan): Promise<void> {
		try {
			const res = await cpTx.persistPlan(this.port!, parentTxId, {
				title: plan.title,
				summary: plan.summary,
				plan_json: plan,
				sub_tx_count: plan.subTransactions?.length ?? 0,
			})
			if (!res.ok) this.log(`Warning: Failed to persist plan: ${cpErrorMessage(res)}`)
		} catch (error) {
			if (isControlPlaneUnavailableError(error)) throw error
			this.log(`Warning: Could not persist plan: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * Merge gated sub-transactions through the CP merge-pipeline. Every id the
	 * pipeline did not merge (rolled_back_ids, failed_ids, or missing) is a
	 * failure; there is no individual-merge fallback. Returns the merged ids.
	 */
	private async mergeWorktrees(gated: SubTransaction[], failures: Map<string, string>): Promise<string[]> {
		const ids = gated.map((s) => s.id)
		const dependsOn: Record<string, string[]> = {}
		for (const stx of gated) {
			if (stx.dependsOn?.length) dependsOn[stx.id] = stx.dependsOn
		}

		const res = await cpTx.mergePipeline(this.port!, this.parentTxId!, {
			sub_tx_ids: ids,
			...(Object.keys(dependsOn).length > 0 ? { depends_on: dependsOn } : {}),
		})
		if (!res.ok) {
			const reason = `MERGE_PIPELINE_ERROR: ${cpErrorMessage(res)}`
			for (const id of ids) failures.set(id, reason)
			await this.rollbackFailedSubTransactions(ids, "MERGE_CONFLICT")
			return []
		}

		const pipeline = res.data
		const rel = (id: string | undefined) => (id ? id.split(":").pop()! : "")
		const byId = new Map<string, cpTx.MergePipelineResult>()
		for (const r of pipeline.results ?? []) byId.set(rel(r.subTxId ?? r.sub_tx_id), r)
		const mergedIds = new Set((pipeline.merged_ids ?? []).map(rel))
		for (const r of pipeline.results ?? []) {
			if (r.status === "merged" || (r.status === undefined && r.merged))
				mergedIds.add(rel(r.subTxId ?? r.sub_tx_id))
		}
		const notMerged = new Set([...(pipeline.rolled_back_ids ?? []), ...(pipeline.failed_ids ?? [])].map(rel))

		const merged: string[] = []
		for (const id of ids) {
			const r = byId.get(id)
			if (mergedIds.has(id) && !notMerged.has(id)) {
				merged.push(id)
				continue
			}
			const conflictsWith = Array.isArray(r?.conflicts_with) ? r?.conflicts_with.join(", ") : r?.conflicts_with
			const reason =
				`${(r?.status ?? "failed").toUpperCase()}: ${r?.reason ?? r?.error ?? "not merged by merge-pipeline"}` +
				(conflictsWith ? ` (conflicts with ${conflictsWith})` : "")
			failures.set(id, reason)
		}
		this.log(
			`merge-pipeline: merged [${merged.join(", ")}], not merged [${ids.filter((i) => !merged.includes(i)).join(", ")}]`,
		)
		return merged
	}

	/** Reset the parent worktree to its base commit (idempotent, best effort). */
	private async cleanupParentTransaction(parentTxId: string | undefined): Promise<void> {
		if (!parentTxId || !this.parentBaseCommit || !this.port) return
		try {
			const res = await cpTx.rollback(this.port, parentTxId, this.parentBaseCommit)
			if (!res.ok) this.log(`Failed to rollback parent transaction: ${cpErrorMessage(res)}`)
		} catch (error) {
			this.log(`Failed to rollback parent transaction: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/** Roll back the given sub-transactions (runtime failures, failed gates, merge rejections). */
	private async rollbackFailedSubTransactions(ids: string[], kind: string): Promise<void> {
		const parentTxId = this.parentTxId
		if (!parentTxId || !this.port) return
		for (const id of ids) {
			try {
				const res = await cpTx.subTxRollback(this.port, parentTxId, id, {
					reason: `sub-transaction failed (${kind})`,
					failureKind: kind,
				})
				if (!res.ok && res.status !== 404) this.log(`Failed to rollback ${id}: ${cpErrorMessage(res)}`)
			} catch (error) {
				this.log(`Failed to rollback ${id}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}

	/**
	 * Roll back ALL sub-transactions of a plan (planner failure). 404s are fine:
	 * a sub-transaction may never have been created.
	 */
	async rollbackAllSubTransactions(plan: Plan, parentTxId: string): Promise<void> {
		const port = this.port ?? getCpPort(this.parentTask.providerRef.deref()?.context)
		if (!port || !plan.subTransactions || plan.subTransactions.length === 0) return
		this.log(`Rolling back all ${plan.subTransactions.length} sub-transactions`)
		await Promise.all(
			plan.subTransactions.map(async (stx) => {
				try {
					const res = await cpTx.subTxRollback(port, parentTxId, stx.id, {
						reason: "Planner failed - cleaning up all sub-transactions",
						failureKind: "RUNTIME_ERROR",
					})
					if (!res.ok && res.status !== 404) this.log(`Failed to rollback ${stx.id}: ${cpErrorMessage(res)}`)
				} catch (error) {
					this.log(`Error rolling back ${stx.id}: ${error instanceof Error ? error.message : String(error)}`)
				}
			}),
		)
	}

	/**
	 * Record execution metrics: `total_duration_ms` is the SUM of child run
	 * times, `wall_clock_ms` the elapsed time (their ratio estimates speedup).
	 */
	private async recordExecutionMetrics(
		parentTxId: string,
		executionMode: "parallel" | "serial",
		subTxCount: number,
		totalDurationMs: number,
		wallClockMs: number,
	): Promise<void> {
		if (!this.port) return
		try {
			await cpTx.metricExecution(this.port, parentTxId, {
				execution_mode: executionMode,
				sub_tx_count: subTxCount,
				total_duration_ms: totalDurationMs,
				wall_clock_ms: wallClockMs,
			})
			this.log(
				`Recorded execution metrics: ${executionMode}, ${subTxCount} sub-txns, Σ ${totalDurationMs}ms / wall ${wallClockMs}ms`,
			)
		} catch {
			// best effort
		}
	}
}
