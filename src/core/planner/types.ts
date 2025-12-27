/**
 * Planner Types
 *
 * Re-exports the canonical SubTransaction, Step, and Plan types from @agentic-code/types.
 * Also defines planner-specific result types.
 */

// Re-export canonical types - there is ONE SubTransaction type
export type { SubTransaction, Step, Plan } from "@agentic-code/types"

/**
 * Result of a child task execution
 */
export interface ChildResult {
	success: boolean
	worktreePath?: string
	checkpointHash?: string
	error?: string
}

/**
 * Result of plan execution
 */
export interface ExecutionResult {
	success: boolean
	parentTxId?: string
	failedSubTransactions?: string[]
}
