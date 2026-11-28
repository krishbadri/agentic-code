/**
 * Route guards: resolve and validate transaction / sub-transaction ids so that
 * no route ever operates on a worktree that does not exist (previously a
 * missing worktree made e.g. `not(cmd)` clauses pass vacuously).
 */
import type { FastifyInstance } from "fastify"
import { existsSync } from "node:fs"
import { CPError } from "./errors.js"
import { Git } from "./git.js"
import { assertTxId, assertSubTxId, toGlobalSubTxId } from "./ids.js"

export interface TxHandle {
	txId: string
	worktreePath: string
	git: Git
}

export interface SubTxHandle {
	parentTxId: string
	rel: string
	global: string
	worktreePath: string
	git: Git
}

export async function requireTx(app: FastifyInstance, rawTxId: unknown): Promise<TxHandle> {
	const txId = assertTxId(rawTxId)
	const git = new Git({ repoRoot: app.repoRoot })
	const worktreePath = git.worktreePath(txId)
	if (!existsSync(worktreePath)) {
		throw new CPError("TX_NOT_FOUND", `Transaction ${txId} not found (no worktree)`, { tx_id: txId })
	}
	return { txId, worktreePath, git }
}

export async function requireSubTx(app: FastifyInstance, rawParent: unknown, rawSubId: unknown): Promise<SubTxHandle> {
	const { txId: parentTxId, git } = await requireTx(app, rawParent)
	const rel = assertSubTxId(parentTxId, rawSubId)
	const worktreePath = git.subTxWorktreePath(parentTxId, rel)
	if (!existsSync(worktreePath)) {
		throw new CPError("SUB_TX_NOT_FOUND", `Sub-transaction ${rel} of ${parentTxId} not found (no worktree)`, {
			tx_id: parentTxId,
			sub_tx_id: rel,
		})
	}
	return { parentTxId, rel, global: toGlobalSubTxId(parentTxId, rel), worktreePath, git }
}
