/**
 * Spec-strict merge pipeline (R15–R17, R21–R24, R30, Structural Conflict Policy).
 *
 * For a batch of sibling sub-transactions of one parent:
 *   1. snapshot every sub-tx (uncommitted work is committed first)
 *   2. analyse structural conflicts within the batch AND against sub-txs
 *      already merged into the parent (earlier batches)
 *   3. order: depends_on (topological), then no-conflict first, then more
 *      lines changed first, then id
 *   4. merge in order; the FIRST rule that applies decides each sub-tx:
 *        DEPENDENCY_FAILED    a dependency in this batch was not merged
 *        DEPENDENCY_NOT_MET   a dependency outside the batch is not committed
 *        SAFETY_GATE_FAILED   a required safety gate is missing or failed
 *        R30_FILE_RESERVED    it adds a file another sub-tx reserved
 *        STRUCTURAL_CONFLICT  it conflicts with an already-merged sub-tx →
 *                             rolled back even if git could merge it
 *        MERGE_CONFLICT       git could not merge it
 *      otherwise it is merged.
 *
 * Every non-merged sub-tx is rolled back (worktree + branch removed) and
 * reported; callers must count `rolled_back_ids` and `failed_ids` as failures.
 */
import type { FastifyInstance } from "fastify"
import { CPError } from "./errors.js"
import { Git } from "./git.js"
import { requireSubTx } from "./guards.js"
import { toGlobalSubTxId, toRelativeSubTxId, assertSubTxId } from "./ids.js"
import { planMergeOrder } from "./merge-planner.js"
import {
	analyzeStructuralConflicts,
	snapshotSubTx,
	type ConflictResult,
	type SubTxSnapshot,
} from "./structural-conflict.js"
import {
	getDependsOn,
	getRecordedSafetyGate,
	getSubTxStatus,
	hasDeclaredSafetyChecks,
	recordSubTxRollbackMetric,
	setSubTxStatus,
} from "./subtx-state.js"

export type MergeReason =
	| "STRUCTURAL_CONFLICT"
	| "MERGE_CONFLICT"
	| "DEPENDENCY_FAILED"
	| "DEPENDENCY_NOT_MET"
	| "SAFETY_GATE_FAILED"
	| "R30_FILE_RESERVED"
	| "ROLLBACK_FAILED"
	| "ERROR"

export interface MergeResultEntry {
	subTxId: string // relative
	sub_tx_id: string // global
	status: "merged" | "rolled_back" | "failed"
	merged: boolean
	rollback: boolean
	reason?: MergeReason
	conflicts_with?: string[]
	conflict_type?: "same-file" | "dependent-file"
	files?: string[]
	merge_commit?: string
	lines_changed: number
	bytes_rolled_back?: number
	error?: string
}

export interface MergePipelineBody {
	sub_tx_ids: string[]
	depends_on?: Record<string, string[]>
	require_safety_gate?: boolean
}

export async function runMergePipeline(app: FastifyInstance, parentTxId: string, body: MergePipelineBody) {
	const git = new Git({ repoRoot: app.repoRoot })
	const parentWt = git.worktreePath(parentTxId)

	// --- validate everything before touching anything ---
	const rels = Array.from(new Set(body.sub_tx_ids.map((id) => assertSubTxId(parentTxId, id))))
	const missing: string[] = []
	const worktrees = new Map<string, string>()
	for (const rel of rels) {
		try {
			worktrees.set(rel, (await requireSubTx(app, parentTxId, rel)).worktreePath)
		} catch {
			missing.push(rel)
		}
	}
	if (missing.length > 0) {
		throw new CPError("SUB_TX_NOT_FOUND", `Unknown sub-transactions: ${missing.join(", ")}`, { missing })
	}

	const dependsOn: Record<string, string[]> = {}
	for (const rel of rels) {
		const fromBody = body.depends_on?.[rel] ?? body.depends_on?.[toGlobalSubTxId(parentTxId, rel)]
		dependsOn[rel] = (fromBody ?? (await getDependsOn(app, parentTxId, rel))).map((d) =>
			toRelativeSubTxId(parentTxId, d),
		)
	}

	// --- snapshot + analyse ---
	const snapshots = new Map<string, SubTxSnapshot>()
	for (const rel of rels) snapshots.set(rel, await snapshotSubTx(git, rel, worktrees.get(rel)!, parentWt))
	const previouslyMerged = app.mergedSnapshots.get(parentTxId) ?? []
	const analysis = await analyzeStructuralConflicts(git, parentWt, Array.from(snapshots.values()), previouslyMerged)

	const order = planMergeOrder(
		rels.map((rel) => ({
			id: rel,
			linesChanged: snapshots.get(rel)!.linesChanged,
			conflicting: (analysis.graph.get(rel)?.size ?? 0) > 0,
		})),
		dependsOn,
	)

	const accepted: SubTxSnapshot[] = [...previouslyMerged]
	const acceptedIds = new Set(accepted.map((s) => s.rel))
	const results: MergeResultEntry[] = []
	const reservations = app.fileReservations.get(parentTxId)

	const rollback = async (rel: string, reason: MergeReason, extra: Partial<MergeResultEntry> = {}) => {
		const snap = snapshots.get(rel)!
		const global = toGlobalSubTxId(parentTxId, rel)
		const started = Date.now()
		let bytes = 0
		try {
			bytes = Buffer.byteLength(await git.runRaw(["diff", "--binary", snap.base, snap.head]), "utf8")
		} catch {
			/* ignore */
		}
		let rolledBack = true
		let error = extra.error
		try {
			await git.rollbackSubTx(parentTxId, rel)
		} catch (e) {
			rolledBack = false
			error = `${error ? error + "; " : ""}rollback failed: ${String(e)}`
		}
		await setSubTxStatus(app, global, "ABORTED", undefined, {
			kind: reason,
			message: error ?? extra.conflicts_with?.join(", ") ?? reason,
		})
		await recordSubTxRollbackMetric(app, parentTxId, global, Date.now() - started, snap.files.length, bytes)
		results.push({
			subTxId: rel,
			sub_tx_id: global,
			status: rolledBack ? "rolled_back" : "failed",
			merged: false,
			rollback: rolledBack,
			reason: rolledBack ? reason : "ROLLBACK_FAILED",
			lines_changed: snap.linesChanged,
			bytes_rolled_back: bytes,
			...extra,
			...(error ? { error } : {}),
		})
	}

	for (const rel of order) {
		const snap = snapshots.get(rel)!
		const global = toGlobalSubTxId(parentTxId, rel)
		try {
			// 1/2. dependencies
			const deps = dependsOn[rel] ?? []
			const inBatchFailed = deps.filter((d) => rels.includes(d) && !acceptedIds.has(d))
			if (inBatchFailed.length > 0) {
				await rollback(rel, "DEPENDENCY_FAILED", { conflicts_with: inBatchFailed })
				continue
			}
			const outOfBatch = deps.filter((d) => !rels.includes(d))
			const unmet: string[] = []
			for (const d of outOfBatch) {
				if (acceptedIds.has(d)) continue
				const st = await getSubTxStatus(app, toGlobalSubTxId(parentTxId, d))
				if (st !== "COMMITTED") unmet.push(d)
			}
			if (unmet.length > 0) {
				await rollback(rel, "DEPENDENCY_NOT_MET", { conflicts_with: unmet })
				continue
			}

			// 3. safety gate
			const gate = await getRecordedSafetyGate(app, global)
			const gateRequired =
				body.require_safety_gate ?? (gate !== null || (await hasDeclaredSafetyChecks(app, global)))
			if (gateRequired && (!gate || !gate.ok)) {
				await rollback(rel, "SAFETY_GATE_FAILED", {
					error: gate ? "safety gate failed" : "safety gate required but not run",
				})
				continue
			}

			// 4. R30 new-file reservations
			const stolen = snap.added.filter((f) => {
				const owner = reservations?.get(normalizeReservedPath(f))
				return owner !== undefined && toRelativeSubTxId(parentTxId, owner) !== rel
			})
			if (stolen.length > 0) {
				await rollback(rel, "R30_FILE_RESERVED", { files: stolen })
				continue
			}

			// 5. strict structural policy vs. everything already accepted
			const edges = analysis.graph.get(rel)
			const against = edges ? Array.from(edges.keys()).filter((o) => acceptedIds.has(o)) : []
			if (against.length > 0) {
				const first = edges!.get(against[0]!)! as ConflictResult
				await rollback(rel, "STRUCTURAL_CONFLICT", {
					conflicts_with: against,
					conflict_type: first.conflictType,
					files: Array.from(new Set(against.flatMap((o) => edges!.get(o)!.conflictingFiles ?? []))),
				})
				continue
			}

			// 6. git merge
			const res = await git.mergeSubTx(parentTxId, rel)
			if (!res.merged && res.conflict) {
				// mergeSubTx already aborted the merge and removed the worktree;
				// rollback() is idempotent cleanup + bookkeeping
				await rollback(rel, "MERGE_CONFLICT", { error: res.conflict })
				continue
			}
			const mergeCommit = await git.run(["rev-parse", "HEAD"], parentWt)
			await setSubTxStatus(app, global, "COMMITTED", mergeCommit)
			accepted.push(snap)
			acceptedIds.add(rel)
			results.push({
				subTxId: rel,
				sub_tx_id: global,
				status: "merged",
				merged: true,
				rollback: false,
				merge_commit: mergeCommit,
				lines_changed: snap.linesChanged,
			})
		} catch (e) {
			await rollback(rel, "ERROR", { error: String(e) })
		}
	}

	app.mergedSnapshots.set(parentTxId, accepted)

	const merged_ids = results.filter((r) => r.status === "merged").map((r) => r.subTxId)
	const rolled_back_ids = results.filter((r) => r.status === "rolled_back").map((r) => r.subTxId)
	const failed_ids = results.filter((r) => r.status === "failed").map((r) => r.subTxId)
	return {
		success: merged_ids.length === rels.length,
		total: rels.length,
		merged: merged_ids.length,
		failed: rels.length - merged_ids.length,
		rolled_back: rolled_back_ids.length,
		merged_ids,
		rolled_back_ids,
		failed_ids,
		order,
		conflicts_detected: analysis.conflicts.length,
		conflicts: analysis.conflicts,
		dismissed_by_ast: analysis.dismissed,
		parent_head: await git.run(["rev-parse", "HEAD"], parentWt),
		// results in the order merges were attempted
		results,
	}
}

/**
 * Strict structural check for a single sub-tx merge (used by
 * /sub-tx/:id/merge): conflicts with any sub-tx already merged into the parent.
 */
export async function checkAgainstMerged(app: FastifyInstance, parentTxId: string, rel: string, subWt: string) {
	const git = new Git({ repoRoot: app.repoRoot })
	const parentWt = git.worktreePath(parentTxId)
	const snap = await snapshotSubTx(git, rel, subWt, parentWt)
	const merged = app.mergedSnapshots.get(parentTxId) ?? []
	const analysis = await analyzeStructuralConflicts(git, parentWt, [snap], merged)
	const edges = analysis.graph.get(rel)
	return { snapshot: snap, conflicts: edges ? Array.from(edges.entries()) : [], dismissed: analysis.dismissed }
}

export function normalizeReservedPath(p: string): string {
	let n = p.replace(/\\/g, "/").trim()
	while (n.startsWith("./")) n = n.slice(2)
	return process.platform === "win32" ? n.toLowerCase() : n
}
