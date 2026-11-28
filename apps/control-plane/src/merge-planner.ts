/**
 * Merge ordering (R22, R23 + depends_on).
 *
 * Kahn topological sort over the depends_on edges inside the batch. Among the
 * sub-txs that are ready at each step, priority is:
 *   1. non-conflicting before conflicting (R22: merge no-conflict sub-txs first)
 *   2. more lines changed first (R23: order conflicting sub-txs by amount of
 *      modification — the bigger change wins, later conflicting ones roll back)
 *   3. id (stable, deterministic tie-breaker)
 */
import { CPError } from "./errors.js"

export interface MergeCandidate {
	id: string
	linesChanged: number
	conflicting: boolean
}

export function planMergeOrder(
	candidates: MergeCandidate[],
	dependsOn: Record<string, string[] | undefined>,
): string[] {
	const ids = new Set(candidates.map((c) => c.id))
	const byId = new Map(candidates.map((c) => [c.id, c]))
	const indegree = new Map<string, number>()
	const dependents = new Map<string, string[]>()
	for (const c of candidates) {
		indegree.set(c.id, 0)
		dependents.set(c.id, [])
	}
	for (const c of candidates) {
		for (const dep of dependsOn[c.id] ?? []) {
			if (!ids.has(dep) || dep === c.id) continue // out-of-batch deps are checked at merge time
			indegree.set(c.id, (indegree.get(c.id) ?? 0) + 1)
			dependents.get(dep)!.push(c.id)
		}
	}

	const cmp = (a: string, b: string) => {
		const x = byId.get(a)!
		const y = byId.get(b)!
		if (x.conflicting !== y.conflicting) return x.conflicting ? 1 : -1
		if (x.linesChanged !== y.linesChanged) return y.linesChanged - x.linesChanged
		return a.localeCompare(b)
	}

	const ready = candidates.filter((c) => indegree.get(c.id) === 0).map((c) => c.id)
	const order: string[] = []
	while (ready.length > 0) {
		ready.sort(cmp)
		const next = ready.shift()!
		order.push(next)
		for (const d of dependents.get(next) ?? []) {
			const n = (indegree.get(d) ?? 0) - 1
			indegree.set(d, n)
			if (n === 0) ready.push(d)
		}
	}
	if (order.length !== candidates.length) {
		const cyclic = candidates.map((c) => c.id).filter((id) => !order.includes(id))
		throw new CPError("VALIDATION_ERROR", `depends_on contains a cycle: ${cyclic.join(", ")}`, { cycle: cyclic })
	}
	return order
}
