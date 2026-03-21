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

export interface ClauseResult {
	ok: boolean
	reason?: string
}
