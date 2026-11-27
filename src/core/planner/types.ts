/**
 * Planner Types
 *
 * Re-exports the canonical SubTransaction, Step, and Plan types from @roo-code/types.
 * Also defines planner-specific result types.
 */

// Re-export canonical types - there is ONE SubTransaction type
export type { SubTransaction, Step, Plan } from "@roo-code/types"

/**
 * Result of a child task execution
 */
export interface ChildResult {
	success: boolean
	worktreePath?: string
	checkpointHash?: string
	error?: string
	/** Wall-clock run time of the child task (used for execution metrics). */
	durationMs?: number
}

/**
 * Result of plan execution
 */
export interface ExecutionResult {
	success: boolean
	parentTxId?: string
	failedSubTransactions?: string[]
	/** Why each failed sub-transaction failed (runtime, safety gate, merge, progress, skipped). */
	failures?: Array<{ subTxId: string; reason: string }>
}
