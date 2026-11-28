/**
 * Transaction metadata lookup shared by all routes.
 *
 * In DB-less mode `app.txMeta` is authoritative; with a database the row is the
 * source of truth (so metadata survives a control-plane restart) and the map is
 * a cache.
 */
import type { FastifyInstance } from "fastify"
import type { TxMeta } from "./server.js"

export async function loadTxMeta(app: FastifyInstance, txId: string): Promise<TxMeta | null> {
	const cached = app.txMeta.get(txId)
	if (cached) return cached
	if (!app.db) return null
	const { getTransaction, getProgressBaseline } = await import("./store.js")
	const row = await getTransaction(app.db, txId)
	if (!row) return null
	let testCommand = row.test_command ?? undefined
	if (!testCommand) {
		const baseline = await getProgressBaseline(app.db, txId)
		testCommand = baseline?.test_command
	}
	const meta: TxMeta = {
		base_commit: row.base_commit,
		isolation: (row.isolation_policy as TxMeta["isolation"]) ?? "fail-fast",
		target_branch: row.target_branch || "main",
		test_command: testCommand || undefined,
		compile_command: row.compile_command || undefined,
		status: row.state === "committed" ? "committed" : row.state === "active" || !row.state ? "active" : "aborted",
	}
	app.txMeta.set(txId, meta)
	return meta
}

export function setTxStatus(app: FastifyInstance, txId: string, status: TxMeta["status"]) {
	const meta = app.txMeta.get(txId)
	if (meta) meta.status = status
}
