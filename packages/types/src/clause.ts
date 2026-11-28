/**
 * Clause Interface — R8
 *
 * Declarative safety/progress rule language.
 * JSON is the only clause format — no text parser.
 */

export type Clause =
	| { type: "cmd_exits_0"; cmd: string }
	| { type: "test_suite"; name: string }
	| { type: "file_exists"; path: string }
	| { type: "not"; clause: Clause }
	| { type: "and"; clauses: [Clause, ...Clause[]] }
	| { type: "or"; clauses: [Clause, ...Clause[]] }

/** Outcome of one leaf clause (cmd_exits_0, test_suite, file_exists). */
export interface ClauseLeafResult {
	clause: string
	ok: boolean
	exitCode?: number
	durationMs: number
	reason?: string
}

export interface ClauseResult {
	ok: boolean
	reason?: string
	/**
	 * Set when the clause could not be evaluated (missing worktree, blocked or
	 * unstartable command). An error is never inverted by `not` and always
	 * makes the overall result fail.
	 */
	error?: string
	/** Leaf results in evaluation order */
	results?: ClauseLeafResult[]
}
