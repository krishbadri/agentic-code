/**
 * Sub-transaction bookkeeping shared by the sub-tx routes and the merge
 * pipeline. In DB mode the database is authoritative; these in-memory maps make
 * DB-less mode (tests, --disableDb) enforce the same rules.
 */
import type { FastifyInstance } from "fastify"
import { getSubTransaction, getSafetyGate, updateSubTransactionStatus } from "./store.js"
import { toGlobalSubTxId } from "./ids.js"

/** depends_on (relative ids) keyed by GLOBAL sub-tx id */
export const subTxDeps = new Map<string, string[]>()
/** GLOBAL sub-tx ids that declared safety checks at begin */
export const subTxHasChecks = new Set<string>()
/** GLOBAL sub-tx id → final status (DB-less mirror of sub_transaction.status) */
export const subTxStatus = new Map<string, "RUNNING" | "COMMITTED" | "ABORTED">()

export async function getDependsOn(app: FastifyInstance, parentTxId: string, rel: string): Promise<string[]> {
	const global = toGlobalSubTxId(parentTxId, rel)
	if (app.db) {
		const row = await getSubTransaction(app.db, global)
		if (row?.depends_on && Array.isArray(row.depends_on)) return row.depends_on
	}
	return subTxDeps.get(global) ?? []
}

export async function hasDeclaredSafetyChecks(app: FastifyInstance, global: string): Promise<boolean> {
	if (subTxHasChecks.has(global)) return true
	if (app.db) {
		const row = await getSubTransaction(app.db, global)
		return !!(row?.safety_checks && row.safety_checks.length > 0)
	}
	return false
}

/** Latest safety-gate outcome for a sub-tx, if a gate was run. */
export async function getRecordedSafetyGate(app: FastifyInstance, global: string): Promise<{ ok: boolean } | null> {
	const mem = app.safetyGates.get(global)
	if (mem) return { ok: mem.ok }
	if (app.db) {
		try {
			const g = await getSafetyGate(app.db, global)
			if (g) return { ok: !!g.ok }
		} catch {
			/* no gate */
		}
	}
	return null
}

export async function getSubTxStatus(app: FastifyInstance, global: string): Promise<string | null> {
	const mem = subTxStatus.get(global)
	if (mem) return mem
	if (app.db) {
		const row = await getSubTransaction(app.db, global)
		return row?.status ?? null
	}
	return null
}

export async function setSubTxStatus(
	app: FastifyInstance,
	global: string,
	status: "COMMITTED" | "ABORTED",
	endCommit?: string,
	failure?: { kind: string; message: string },
) {
	subTxStatus.set(global, status)
	if (app.db) {
		try {
			await updateSubTransactionStatus(app.db, global, status, endCommit, failure as any)
		} catch (e) {
			app.log.warn({ err: e, global }, "Failed to persist sub-transaction status")
		}
	}
}

/** Record a sub-transaction rollback metric; failures are logged, not swallowed. */
export async function recordSubTxRollbackMetric(
	app: FastifyInstance,
	parentTxId: string,
	globalSubTxId: string,
	durationMs: number,
	filesAffected: number,
	bytesRolledBack: number,
) {
	if (!app.db) return
	try {
		const { insertMetricRollback } = await import("./store.js")
		const exists = await getSubTransaction(app.db, globalSubTxId)
		await insertMetricRollback(app.db, {
			tx_id: parentTxId,
			// FK to sub_transaction: only reference rows that exist
			sub_tx_id: exists ? globalSubTxId : undefined,
			duration_ms: durationMs,
			files_affected: filesAffected,
			bytes_rolled_back: bytesRolledBack,
			rollback_type: "sub_transaction",
		})
	} catch (e) {
		app.log.warn({ err: e }, "Failed to record sub-transaction rollback metric")
	}
}
