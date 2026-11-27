/**
 * Transaction / sub-transaction identifier helpers.
 *
 * Git artifacts (worktree directories, branch names) use the RELATIVE sub-tx id
 * ("agent-a"); the database uses the GLOBAL id ("<parentTxId>:agent-a") so the
 * same relative id under different parents never collides. Callers may send
 * either form; every route normalises with these helpers.
 */
import { CPError } from "./errors.js"

// A transaction id, optionally in the composite "<parent>_sub_<rel>" form that
// addresses a sub-transaction's worktree directly (worktreePath(composite) ===
// subTxWorktreePath(parent, rel)).
const TX_ID_RE = /^[A-Za-z0-9-]{1,64}(?:_sub_[A-Za-z0-9._-]{1,64})?$/
const SUB_TX_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

export function assertTxId(id: unknown): string {
	if (typeof id !== "string" || !TX_ID_RE.test(id)) {
		throw new CPError("VALIDATION_ERROR", `Invalid transaction id: ${JSON.stringify(id)}`)
	}
	return id
}

/** Strip a "<parent>:" prefix if present. */
export function toRelativeSubTxId(parentTxId: string, id: string): string {
	const prefix = `${parentTxId}:`
	return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

export function toGlobalSubTxId(parentTxId: string, id: string): string {
	return `${parentTxId}:${toRelativeSubTxId(parentTxId, id)}`
}

/** Validate and return the relative form of a sub-tx id. */
export function assertSubTxId(parentTxId: string, id: unknown): string {
	if (typeof id !== "string") {
		throw new CPError("VALIDATION_ERROR", `Invalid sub-transaction id: ${JSON.stringify(id)}`)
	}
	const rel = toRelativeSubTxId(parentTxId, id)
	if (!SUB_TX_ID_RE.test(rel) || rel.includes("_sub_") || rel === "." || rel === "..") {
		throw new CPError("VALIDATION_ERROR", `Invalid sub-transaction id: ${JSON.stringify(id)}`)
	}
	return rel
}
