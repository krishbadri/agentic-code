import type { Task } from "../task/Task"
import type { SubTransaction } from "@roo-code/types"
import { getCheckpointService } from "./index"
import { getWorkspacePath } from "../../utils/path"
import crypto from "crypto"

/**
 * SubTransactionManager
 *
 * Manages the lifecycle of sub-transactions - semantic units of atomicity.
 * Each sub-transaction represents a contiguous sequence of agent actions
 * whose effects are either fully committed or fully rolled back.
 */
export class SubTransactionManager {
	constructor(private task: Task) {}

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
		if (subTxn.safetyChecks && subTxn.safetyChecks.length > 0) {
			provider?.log(`[SubTransactionManager] Running safety checks for sub-transaction ${subTxn.id}`)

			const safetyGate = await this.runSafetyGate(subTxn)

			if (!safetyGate.ok) {
				// Safety checks failed - abort the sub-transaction
				subTxn.status = "ABORTED"
				subTxn.failure = {
					kind: "SAFETY_FAIL",
					message: `Safety checks failed at: ${safetyGate.failedAt}`,
				}
				subTxn.safetyGate = safetyGate
				subTxn.endedAt = Date.now()

				provider?.log(
					`[SubTransactionManager] Commit BLOCKED for ${subTxn.id} - safety gate failed at: ${safetyGate.failedAt}`,
				)

				throw new Error(
					`Cannot commit sub-transaction ${subTxn.id}: safety checks failed at ${safetyGate.failedAt}`,
				)
			}

			subTxn.safetyGate = safetyGate
			provider?.log(`[SubTransactionManager] Safety gate PASSED for ${subTxn.id}`)
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
			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${parentTxId}/sub-tx/${subTxn.id}/safety-gate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify({ checks: subTxn.safetyChecks }),
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
