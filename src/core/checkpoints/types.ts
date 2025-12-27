/**
 * Checkpoint System Types
 *
 * NOTE: The canonical SubTransaction type is defined in @agentic-code/types.
 * Import it from there: `import type { SubTransaction } from "@agentic-code/types"`
 *
 * This file defines types specific to the checkpoint system's state management.
 */

import type { ClineMessage } from "@agentic-code/types"
import type { ApiMessage } from "../task-persistence"

// Re-export SubTransaction from canonical location for backwards compatibility
export type { SubTransaction, SubTransactionStatus, SafetyGate, SafetyCheckResult } from "@agentic-code/types"

/**
 * System State vs Agent State
 *
 * SystemState: The repository and file system state (what gets rolled back)
 * AgentState: The agent's trajectory, logs, and reasoning (what gets preserved)
 *
 * This separation is critical - rollback affects ONLY SystemState;
 * AgentState is preserved for debugging, replay, and informed retries.
 */

/**
 * SystemState represents the mutable state of the repository
 * This is what gets snapshot'd and restored during rollback
 */
export interface SystemState {
	/** Current git commit hash */
	repoCommit: string
	/** List of tracked files */
	files: string[]
}

/**
 * AgentState represents the agent's execution history
 * This is NEVER rolled back - it's preserved for debugging, replay, and learning
 */
export interface AgentState {
	/** Full chat history with the user */
	chatHistory: ClineMessage[]
	/** Tool call records for replay */
	toolCalls: Record<string, unknown>[]
	/** API conversation history for debugging */
	apiConversationHistory: ApiMessage[]
}
