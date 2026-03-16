import type { Task } from "../task/Task"
import type { SubTransaction } from "@roo-code/types"
import { getCheckpointService } from "./index"
import { getWorkspacePath } from "../../utils/path"
import crypto from "crypto"
import * as vscode from "vscode"

/**
 * SubTransactionManager
 *
 * Manages the lifecycle of sub-transactions - semantic units of atomicity.
 * Each sub-transaction represents a contiguous sequence of agent actions
 * whose effects are either fully committed or fully rolled back.
 */
export class SubTransactionManager {
	constructor(private task: Task) {}

	private isStrictMode(): boolean {
		const cfg = vscode.workspace.getConfiguration()
		return cfg.get<boolean>("roo.experimental.txStrictMode") ?? true
	}

	/**
	 * Create a new sub-transaction
	 *
	 * @param baseCommit - The commit hash at the start of this sub-transaction
	 * @param safetyChecks - Optional safety checks to run before commit
	 * @returns The created sub-transaction
	 */
	async createSubTransaction(baseCommit: string, safetyChecks?: string[]): Promise<SubTransaction> {
		const subTxn: SubTransaction = {
			id: crypto.randomUUID(),
			baseCommit,
			status: "PENDING",
			safetyChecks,
			createdAt: Date.now(),
		}

		this.task.subTransactions.push(subTxn)
		this.task.currentSubTransaction = subTxn

		const provider = this.task.providerRef.deref()
		provider?.log(`[SubTransactionManager] Created sub-transaction ${subTxn.id} at checkpoint ${baseCommit}`)

		this.task.taskLogger?.logSubTxCreated(subTxn.id, baseCommit)

		return subTxn
	}

	/**
	 * Commit a sub-transaction
	 *
	 * Runs safety checks via Control-Plane, sets endCommit, and marks as committed.
	 * This corresponds to commit point C_i in the transaction model.
	 *
	 * CRITICAL: Safety checks MUST be evaluated at commit points.
	 * A sub-transaction may be committed iff all safety predicates pass.
	 *
	 * @param subTxn - The sub-transaction to commit
	 */
	async commitSubTransaction(subTxn: SubTransaction): Promise<void> {
		if (subTxn.status !== "PENDING" && subTxn.status !== "RUNNING") {
			throw new Error(`Cannot commit sub-transaction ${subTxn.id}: status is ${subTxn.status}`)
		}

		const provider = this.task.providerRef.deref()

		// P2 FIX: Run safety checks via Control-Plane's /safety-gate endpoint
		// Safety gates are enforced - if checks fail, commit is blocked
		if ((subTxn.safetyChecks && subTxn.safetyChecks.length > 0) || subTxn.safetyClause) {
			provider?.log(`[SubTransactionManager] Running safety checks for sub-transaction ${subTxn.id}`)

			const safetyGate = await this.runSafetyGate(subTxn)

			if (!safetyGate.ok) {
				// R7 FIX: Safety failure MUST trigger rollback, not just throw.
				// Previously this threw an exception without rolling back to the
				// prior commit point, violating R7.
				subTxn.safetyGate = safetyGate

				provider?.log(
					`[SubTransactionManager] Commit BLOCKED for ${subTxn.id} - safety gate failed at: ${safetyGate.failedAt}`,
				)

				this.task.taskLogger?.logSafetyGate(subTxn.id, false, subTxn.safetyChecks ?? [])

				// Rollback to baseCommit (restores system state, preserves agent state)
				await this.abortSubTransaction(subTxn, {
					kind: "SAFETY_FAIL",
					message: `Safety checks failed at: ${safetyGate.failedAt}`,
				})

				throw new Error(
					`Cannot commit sub-transaction ${subTxn.id}: safety checks failed at ${safetyGate.failedAt}. Rolled back to ${subTxn.baseCommit}.`,
				)
			}

			subTxn.safetyGate = safetyGate
			provider?.log(`[SubTransactionManager] Safety gate PASSED for ${subTxn.id}`)
			this.task.taskLogger?.logSafetyGate(subTxn.id, true, subTxn.safetyChecks ?? [])
		}

		// R4/R5 FIX: Run progress gate (test monotonicity) via Control-Plane.
		// Spec R5: commit only if Safety AND Progress are satisfied.
		// The safety gate above checked Safety; now check Progress.
		const progressOk = await this.runProgressGate(subTxn)
		if (!progressOk) {
			provider?.log(
				`[SubTransactionManager] Commit BLOCKED for ${subTxn.id} - progress gate failed (test regression)`,
			)

			// R7: Rollback on progress failure
			await this.abortSubTransaction(subTxn, {
				kind: "SAFETY_FAIL",
				message: "Progress gate failed: test count decreased (monotonicity violation)",
			})

			throw new Error(
				`Cannot commit sub-transaction ${subTxn.id}: progress gate failed. Rolled back to ${subTxn.baseCommit}.`,
			)
		}

		// Get current HEAD as endCommit
		const service = await getCheckpointService(this.task)
		if (!service) {
			throw new Error("Checkpoint service not available")
		}

		const simpleGit = (await import("simple-git")).default
		const workspaceDir = this.task.cwd || getWorkspacePath()
		if (!workspaceDir) {
			throw new Error("Workspace directory not found")
		}

		const git = simpleGit(workspaceDir, { binary: "git" })
		const currentHead = await git.revparse(["HEAD"])

		subTxn.endCommit = currentHead
		subTxn.status = "COMMITTED"
		subTxn.endedAt = Date.now()

		provider?.log(`[SubTransactionManager] Committed sub-transaction ${subTxn.id} at checkpoint ${currentHead}`)

		this.task.taskLogger?.logSubTxEvent(subTxn.id, "committed", currentHead)

		// Clear current sub-transaction
		this.task.currentSubTransaction = undefined
	}

	/**
	 * Run safety checks via Control-Plane's /safety-gate endpoint
	 *
	 * P2 FIX: This implements the safety gate call that was previously a TODO.
	 * Safety gates are REQUIRED for sub-transactions with safetyChecks defined.
	 *
	 * @param subTxn - The sub-transaction to run safety checks for
	 * @returns SafetyGate result with ok status and check results
	 */
	private async runSafetyGate(subTxn: SubTransaction): Promise<{
		ok: boolean
		results: Array<{
			cmd: string
			exitCode: number
			durationMs: number
			stdoutTail: string
			stderrTail: string
		}>
		failedAt?: string
	}> {
		const provider = this.task.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")
		const parentTxId = provider?.context?.globalState.get<string>("roo.current_tx_id")

		// If Control-Plane is not available, we cannot run safety checks
		// This is a design invariant - fail fast rather than skip checks
		if (!cpPort) {
			provider?.log("[SubTransactionManager] CRITICAL: Control-Plane not available for safety gate")
			return {
				ok: false,
				results: [],
				failedAt: "CONTROL_PLANE_UNAVAILABLE",
			}
		}

		if (!parentTxId) {
			provider?.log("[SubTransactionManager] CRITICAL: No parent transaction ID for safety gate")
			return {
				ok: false,
				results: [],
				failedAt: "NO_PARENT_TX_ID",
			}
		}

		try {
			const requestBody = subTxn.safetyClause ? { clause: subTxn.safetyClause } : { checks: subTxn.safetyChecks }
			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/sub-tx/${subTxn.id}/safety-gate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify(requestBody),
				signal: AbortSignal.timeout(15_000),
			})

			if (!res.ok) {
				const errorText = await res.text()
				provider?.log(`[SubTransactionManager] Safety-gate HTTP error: ${errorText}`)
				return {
					ok: false,
					results: [],
					failedAt: `HTTP_ERROR: ${res.status}`,
				}
			}

			return await res.json()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			provider?.log(`[SubTransactionManager] Safety-gate error: ${errorMessage}`)
			return {
				ok: false,
				results: [],
				failedAt: `ERROR: ${errorMessage}`,
			}
		}
	}

	/**
	 * R4/R5: Run progress gate via Control-Plane's /tx/:tx_id/checkpoint endpoint.
	 *
	 * The progress oracle checks that passing test count is monotonically
	 * non-decreasing (R33 default). Returns true if progress is satisfied
	 * or if CP is unavailable (non-fatal).
	 */
	private async runProgressGate(subTxn: SubTransaction): Promise<boolean> {
		const provider = this.task.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")
		const txId = provider?.context?.globalState.get<string>("roo.current_tx_id")

		if (!cpPort || !txId) {
			if (this.isStrictMode()) {
				provider?.log(`[SubTransactionManager] CRITICAL: CP unavailable, blocking commit (strict mode)`)
				return false
			}
			provider?.log(`[SubTransactionManager] DEGRADED_MODE: CP unavailable, allowing commit`)
			return true
		}

		try {
			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${txId}/checkpoint`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify({
					reason: "auto",
				}),
				signal: AbortSignal.timeout(120_000), // tests can be slow
			})

			if (res.ok) {
				provider?.log(`[SubTransactionManager] Progress gate PASSED for ${subTxn.id}`)
				return true
			}

			const body = await res.json().catch(() => ({}))
			const code = (body as any).code
			if (code === "PROGRESS_VIOLATION") {
				provider?.log(`[SubTransactionManager] Progress gate FAILED for ${subTxn.id}: test count decreased`)
				return false
			}

			// Other HTTP errors — log but don't block (ambiguous server error, not a gate decision)
			provider?.log(`[SubTransactionManager] Progress gate returned HTTP ${res.status} (non-fatal)`)
			return true
		} catch (error) {
			// CP unreachable mid-fetch
			if (this.isStrictMode()) {
				provider?.log(
					`[SubTransactionManager] CRITICAL: CP unreachable during progress gate, blocking commit (strict mode): ${error instanceof Error ? error.message : String(error)}`,
				)
				return false
			}
			provider?.log(
				`[SubTransactionManager] DEGRADED_MODE: CP unreachable during progress gate, allowing commit: ${error instanceof Error ? error.message : String(error)}`,
			)
			return true
		}
	}

	/**
	 * Abort a sub-transaction
	 *
	 * Rolls back to baseCommit and marks as aborted.
	 * This corresponds to rolling back to C_{i-1} on failure.
	 *
	 * @param subTxn - The sub-transaction to abort
	 * @param reason - Optional reason for the abort
	 */
	async abortSubTransaction(
		subTxn: SubTransaction,
		reason?: { kind: "MERGE_CONFLICT" | "SAFETY_FAIL" | "RUNTIME_ERROR" | "TIMEOUT"; message: string },
	): Promise<void> {
		if (subTxn.status !== "PENDING" && subTxn.status !== "RUNNING") {
			throw new Error(`Cannot abort sub-transaction ${subTxn.id}: status is ${subTxn.status}`)
		}

		const provider = this.task.providerRef.deref()
		provider?.log(
			`[SubTransactionManager] Aborting sub-transaction ${subTxn.id}, rolling back to ${subTxn.baseCommit}`,
		)

		// Rollback to baseCommit (system state only, agent state preserved)
		if (subTxn.baseCommit) {
			const service = await getCheckpointService(this.task)
			if (!service) {
				throw new Error("Checkpoint service not available")
			}

			// Restore system state to baseCommit
			await service.restoreCheckpoint(subTxn.baseCommit)
		}

		subTxn.status = "ABORTED"
		subTxn.endedAt = Date.now()
		if (reason) {
			subTxn.failure = reason
		}

		provider?.log(`[SubTransactionManager] Aborted sub-transaction ${subTxn.id}`)

		this.task.taskLogger?.logSubTxEvent(subTxn.id, "aborted")

		// Clear current sub-transaction
		this.task.currentSubTransaction = undefined
	}

	/**
	 * Get the current active sub-transaction
	 *
	 * @returns The current sub-transaction, or undefined if none
	 */
	getCurrentSubTransaction(): SubTransaction | undefined {
		return this.task.currentSubTransaction
	}
}
