/**
 * Structural Conflict Detection (R16, R17, R22, R23) and the Structural
 * Conflict Policy.
 *
 * Detects conflicts beyond Git's text-based merge:
 * - same-file: two concurrent sub-txs touch the same file. AST-aware refinement
 *   (JS/TS family) dismisses the conflict when every hunk on both sides falls
 *   inside a single ownable top-level declaration and the two sides touch
 *   different declarations ("disjoint AST nodes MAY proceed").
 * - dependent-file: a file changed only by one side can reach, through
 *   relative imports, a file changed only by the other side.
 *
 * All analysis works on commit shas (SubTxSnapshot), so it stays valid after a
 * sub-tx's worktree has been merged and removed, and it diffs each side from
 * its true merge-base — not from the parent's moving HEAD.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"
import ts from "typescript"
import type { Git } from "./git.js"

/**
 * Immutable description of a sub-transaction's changes, computed from shas so it
 * stays valid after the sub-tx worktree is removed (e.g. once merged).
 */
export interface SubTxSnapshot {
	/** Relative sub-tx id */
	rel: string
	/** merge-base of the sub-tx head and the parent head at snapshot time */
	base: string
	/** sub-tx head commit */
	head: string
	files: string[]
	/** files newly added by the sub-tx */
	added: string[]
	linesChanged: number
}

export interface TouchedFiles {
	subTxId: string
	files: string[]
	linesChanged: number
}

export interface ConflictResult {
	hasConflict: boolean
	conflictType?: "same-file" | "dependent-file"
	conflictingSubTxs?: [string, string]
	conflictingFiles?: string[]
	message?: string
}

const CODE_EXT_RE = /\.(?:c|m)?[jt]sx?$/i

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Snapshot a sub-transaction. Any uncommitted changes in its worktree are
 * committed first, because merging only ever takes committed work — what is
 * analysed must be exactly what would be merged.
 */
export async function snapshotSubTx(
	git: Git,
	rel: string,
	subWorktree: string,
	parentWorktree: string,
): Promise<SubTxSnapshot> {
	const status = await git.run(["status", "--porcelain"], subWorktree)
	if (status) {
		await git.run(["add", "-A"], subWorktree)
		await git.run(["commit", "-m", `[cp] sub-tx ${rel}: final changes`], subWorktree)
	}
	const head = await git.run(["rev-parse", "HEAD"], subWorktree)
	const parentHead = await git.run(["rev-parse", "HEAD"], parentWorktree)
	const base = await git.mergeBase(parentHead, head, subWorktree)
	return snapshotFromShas(git, rel, base, head, subWorktree)
}

export async function snapshotFromShas(
	git: Git,
	rel: string,
	base: string,
	head: string,
	cwd?: string,
): Promise<SubTxSnapshot> {
	const numstat = await git.run(["diff", "--numstat", "--no-renames", base, head], cwd)
	const files: string[] = []
	let linesChanged = 0
	for (const line of numstat.split("\n")) {
		if (!line.trim()) continue
		const [a, r, file] = line.split("\t")
		if (!file) continue
		files.push(file)
		linesChanged += (a === "-" ? 0 : parseInt(a!, 10)) + (r === "-" ? 0 : parseInt(r!, 10))
	}
	const addedOut = await git.run(["diff", "--name-only", "--no-renames", "--diff-filter=A", base, head], cwd)
	const added = addedOut.split("\n").filter(Boolean)
	return { rel, base, head, files, added, linesChanged }
}

/** Back-compat helper: files + lines touched between baseRef and HEAD of a worktree. */
export async function getTouchedFiles(
	git: Git,
	worktreePath: string,
	baseRef: string,
): Promise<{ files: string[]; linesChanged: number }> {
	try {
		const snap = await snapshotFromShas(git, "", baseRef, "HEAD", worktreePath)
		return { files: snap.files, linesChanged: snap.linesChanged }
	} catch {
		return { files: [], linesChanged: 0 }
	}
}

/** Two snapshots are concurrent unless one was built on top of the other. */
export async function isConcurrent(git: Git, a: SubTxSnapshot, b: SubTxSnapshot): Promise<boolean> {
	if (a.head === b.head) return false
	if (await git.isAncestor(a.head, b.base)) return false
	if (await git.isAncestor(b.head, a.base)) return false
	return true
}

// ---------------------------------------------------------------------------
// Import graph (relative imports only), built lazily from the parent tree
// ---------------------------------------------------------------------------

const IMPORT_RES = [
	// import x from "./a" / import "./a" / export ... from "./a"
	/(?:^|[^\w$.])(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
	// dynamic import("./a")
	/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
	// require("./a")
	/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
]

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
const JS_TO_TS: Record<string, string[]> = {
	".js": [".ts", ".tsx"],
	".jsx": [".tsx"],
	".mjs": [".mts"],
	".cjs": [".cts"],
}

/**
 * Parse relative import specifiers of `filePath` (repo-relative, posix) and
 * resolve them to repo-relative files that exist under `root`.
 */
export function parseImports(content: string, filePath: string, root: string): string[] {
	const out = new Set<string>()
	const dir = posix.dirname(filePath.replace(/\\/g, "/"))
	for (const re of IMPORT_RES) {
		re.lastIndex = 0
		let m: RegExpExecArray | null
		while ((m = re.exec(content)) !== null) {
			const spec = m[1]!
			if (!spec.startsWith("./") && !spec.startsWith("../")) continue
			const resolved = resolveSpecifier(posix.normalize(posix.join(dir, spec)), root)
			if (resolved && !resolved.startsWith("../")) out.add(resolved)
		}
	}
	return Array.from(out)
}

function resolveSpecifier(p: string, root: string): string | null {
	const candidates: string[] = [p]
	const ext = posix.extname(p)
	if (JS_TO_TS[ext]) {
		for (const t of JS_TO_TS[ext]!) candidates.push(p.slice(0, -ext.length) + t)
	}
	if (!ext || !RESOLVE_EXTS.includes(ext)) {
		for (const e of RESOLVE_EXTS) candidates.push(p + e)
		for (const e of [".ts", ".tsx", ".js", ".jsx"]) candidates.push(posix.join(p, "index" + e))
	}
	for (const c of candidates) {
		if (existsSync(join(root, c))) {
			// a bare directory match is not a module
			if (c === p && !posix.extname(c)) continue
			return c
		}
	}
	return null
}

export interface ImportGraph {
	imports: Map<string, string[]>
}

/**
 * Build the import graph reachable from `starts` (bounded BFS).
 */
export async function buildImportGraph(
	root: string,
	starts: string[],
	limits = { maxNodes: 2000, maxDepth: 8 },
): Promise<ImportGraph> {
	const imports = new Map<string, string[]>()
	let frontier = starts.filter((f) => CODE_EXT_RE.test(f))
	for (let depth = 0; depth <= limits.maxDepth && frontier.length > 0; depth++) {
		const next: string[] = []
		for (const file of frontier) {
			if (imports.has(file)) continue
			if (imports.size >= limits.maxNodes) return { imports }
			let content = ""
			try {
				content = await readFile(join(root, file), "utf8")
			} catch {
				imports.set(file, [])
				continue
			}
			const deps = parseImports(content, file, root)
			imports.set(file, deps)
			for (const d of deps) if (!imports.has(d)) next.push(d)
		}
		frontier = next
	}
	return { imports }
}

function reachable(graph: ImportGraph, from: string, targets: Set<string>): string | null {
	const seen = new Set<string>([from])
	const queue = [from]
	while (queue.length) {
		const f = queue.shift()!
		for (const d of graph.imports.get(f) ?? []) {
			if (targets.has(d)) return d
			if (!seen.has(d)) {
				seen.add(d)
				queue.push(d)
			}
		}
	}
	return null
}

/**
 * Dependent-file conflict between A and B: some file changed only by A
 * (transitively) imports a file changed only by B, or vice versa. Files
 * changed by both are same-file conflicts and handled separately, so a shared
 * file never manufactures a dependent-file conflict on its own.
 */
export function dependentFileConflict(graph: ImportGraph, a: SubTxSnapshot, b: SubTxSnapshot): ConflictResult | null {
	const onlyA = new Set(a.files.filter((f) => !b.files.includes(f)))
	const onlyB = new Set(b.files.filter((f) => !a.files.includes(f)))
	for (const [from, targets, fromId, toId] of [
		[onlyA, onlyB, a.rel, b.rel],
		[onlyB, onlyA, b.rel, a.rel],
	] as const) {
		for (const f of from) {
			const hit = reachable(graph, f, targets)
			if (hit) {
				return {
					hasConflict: true,
					conflictType: "dependent-file",
					conflictingSubTxs: [a.rel, b.rel],
					conflictingFiles: [f, hit],
					message: `Dependent-file conflict: ${f} (${fromId}) imports ${hit} (${toId})`,
				}
			}
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// Same-file detection + AST refinement
// ---------------------------------------------------------------------------

export function sameFileConflict(a: SubTxSnapshot, b: SubTxSnapshot): ConflictResult | null {
	const overlap = a.files.filter((f) => b.files.includes(f))
	if (overlap.length === 0) return null
	return {
		hasConflict: true,
		conflictType: "same-file",
		conflictingSubTxs: [a.rel, b.rel],
		conflictingFiles: overlap,
		message: `Same-file conflict: ${overlap.join(", ")}`,
	}
}

interface TopLevelNode {
	index: number
	startLine: number // 1-based, inclusive
	endLine: number // 1-based, inclusive
	ownable: boolean
}

export interface DiffHunk {
	oldStart: number // 1-based line in base file
	oldCount: number // 0 for pure additions (insert AFTER oldStart)
}

function isOwnableKind(kind: ts.SyntaxKind): boolean {
	switch (kind) {
		case ts.SyntaxKind.FunctionDeclaration:
		case ts.SyntaxKind.ClassDeclaration:
		case ts.SyntaxKind.InterfaceDeclaration:
		case ts.SyntaxKind.TypeAliasDeclaration:
		case ts.SyntaxKind.EnumDeclaration:
		case ts.SyntaxKind.ModuleDeclaration:
		case ts.SyntaxKind.VariableStatement:
			return true
		default:
			return false
	}
}

function scriptKindFor(fileName: string): ts.ScriptKind {
	const f = fileName.toLowerCase()
	if (f.endsWith(".tsx")) return ts.ScriptKind.TSX
	if (f.endsWith(".jsx")) return ts.ScriptKind.JSX
	if (/\.(c|m)?js$/.test(f)) return ts.ScriptKind.JS
	return ts.ScriptKind.TS
}

/**
 * Parse a JS/TS file and return its top-level statement ranges.
 * Returns null on parse errors (caller must stay conservative).
 */
export function getTopLevelNodes(content: string, fileName = "file.ts"): TopLevelNode[] | null {
	try {
		const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKindFor(fileName))
		if (((sourceFile as any).parseDiagnostics?.length ?? 0) > 0) return null
		const nodes: TopLevelNode[] = []
		let index = 0
		for (const stmt of sourceFile.statements) {
			// Include leading JSDoc/comments in the node's range
			const fullStart = stmt.getFullStart()
			const leading = ts.getLeadingCommentRanges(content, fullStart)
			const startPos = leading && leading.length > 0 ? leading[0]!.pos : stmt.getStart(sourceFile)
			const endPos = stmt.getEnd()
			nodes.push({
				index: index++,
				startLine: sourceFile.getLineAndCharacterOfPosition(startPos).line + 1,
				endLine: sourceFile.getLineAndCharacterOfPosition(Math.max(startPos, endPos - 1)).line + 1,
				ownable: isOwnableKind(stmt.kind),
			})
		}
		return nodes
	} catch {
		return null
	}
}

/** Parse unified-diff hunk headers (@@ -old[,count] +new[,count] @@). */
export function parseDiffHunks(diffOutput: string): DiffHunk[] {
	const hunks: DiffHunk[] = []
	const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm
	let match
	while ((match = hunkRegex.exec(diffOutput)) !== null) {
		const oldStart = parseInt(match[1]!, 10)
		const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1
		hunks.push({ oldStart, oldCount })
	}
	return hunks
}

/**
 * Map each hunk to the single ownable top-level node containing it.
 * - A modification (oldCount > 0) must lie entirely within one ownable node.
 * - A pure insertion after line N (oldCount = 0) is attributed to a node only
 *   if it lands strictly inside it (startLine <= N < endLine). Insertions
 *   between declarations or at a declaration's last line are new top-level
 *   code and are NOT attributable → conservative null.
 */
export function findAffectedNodeIndices(hunks: DiffHunk[], nodes: TopLevelNode[]): Set<number> | null {
	const ownable = nodes.filter((n) => n.ownable)
	const indices = new Set<number>()
	for (const h of hunks) {
		let found: TopLevelNode | undefined
		if (h.oldCount === 0) {
			found = ownable.find((n) => n.startLine <= h.oldStart && h.oldStart < n.endLine)
		} else {
			const end = h.oldStart + h.oldCount - 1
			found = ownable.find((n) => h.oldStart >= n.startLine && end <= n.endLine)
		}
		if (!found) return null
		indices.add(found.index)
	}
	return indices
}

/** Whether two hunk sets touch disjoint ownable top-level declarations of `baseContent`. */
export function areChangesDisjoint(
	baseContent: string,
	fileName: string,
	hunksA: DiffHunk[],
	hunksB: DiffHunk[],
): boolean {
	if (hunksA.length === 0 || hunksB.length === 0) return false
	const nodes = getTopLevelNodes(baseContent, fileName)
	if (!nodes || nodes.length === 0) return false
	const a = findAffectedNodeIndices(hunksA, nodes)
	if (!a || a.size === 0) return false
	const b = findAffectedNodeIndices(hunksB, nodes)
	if (!b || b.size === 0) return false
	for (const i of a) if (b.has(i)) return false
	return true
}

async function hunksFor(git: Git, base: string, head: string, file: string): Promise<DiffHunk[] | null> {
	try {
		const out = await git.runRaw(["diff", "--unified=0", "--no-renames", base, head, "--", file])
		return parseDiffHunks(out)
	} catch {
		return null
	}
}

/**
 * Whether the same-file conflict between `a` and `b` can be dismissed because
 * every shared file is edited in disjoint top-level declarations.
 */
export async function isSameFileConflictDismissable(
	git: Git,
	conflict: ConflictResult,
	a: SubTxSnapshot,
	b: SubTxSnapshot,
	contentCache = new Map<string, string | null>(),
): Promise<boolean> {
	if (!conflict.conflictingFiles || conflict.conflictingFiles.length === 0) return false
	// Line numbers are only comparable when both sides diff from the same base
	if (a.base !== b.base) return false
	for (const file of conflict.conflictingFiles) {
		if (!CODE_EXT_RE.test(file)) return false
		if (a.added.includes(file) || b.added.includes(file)) return false
		const key = `${a.base}:${file}`
		let content = contentCache.get(key)
		if (content === undefined) {
			try {
				content = await git.runRaw(["show", `${a.base}:${file}`])
			} catch {
				content = null
			}
			contentCache.set(key, content)
		}
		if (content === null) return false
		const hA = await hunksFor(git, a.base, a.head, file)
		const hB = await hunksFor(git, b.base, b.head, file)
		if (!hA || !hB) return false
		if (!areChangesDisjoint(content, file, hA, hB)) return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Combined analysis
// ---------------------------------------------------------------------------

export interface StructuralAnalysis {
	/** conflicts that stand (after AST refinement) */
	conflicts: ConflictResult[]
	/** same-file conflicts dismissed by the AST refinement */
	dismissed: ConflictResult[]
	/** adjacency: rel → (other rel → conflict) */
	graph: Map<string, Map<string, ConflictResult>>
}

/**
 * Analyse all pairs among `candidates`, and each candidate against the
 * already-accepted (merged) snapshots, skipping non-concurrent pairs.
 */
export async function analyzeStructuralConflicts(
	git: Git,
	parentWorktree: string,
	candidates: SubTxSnapshot[],
	accepted: SubTxSnapshot[] = [],
): Promise<StructuralAnalysis> {
	const all = [...candidates, ...accepted.filter((a) => !candidates.some((c) => c.rel === a.rel))]
	const graph = await buildImportGraph(parentWorktree, Array.from(new Set(all.flatMap((s) => s.files))))
	const conflicts: ConflictResult[] = []
	const dismissed: ConflictResult[] = []
	const adj = new Map<string, Map<string, ConflictResult>>()
	const link = (x: string, y: string, c: ConflictResult) => {
		if (!adj.has(x)) adj.set(x, new Map())
		if (!adj.has(y)) adj.set(y, new Map())
		if (!adj.get(x)!.has(y)) adj.get(x)!.set(y, c)
		if (!adj.get(y)!.has(x)) adj.get(y)!.set(x, c)
	}
	const cache = new Map<string, string | null>()

	const pairs: Array<[SubTxSnapshot, SubTxSnapshot]> = []
	for (let i = 0; i < candidates.length; i++) {
		for (let j = i + 1; j < candidates.length; j++) pairs.push([candidates[i]!, candidates[j]!])
		for (const acc of accepted) if (acc.rel !== candidates[i]!.rel) pairs.push([candidates[i]!, acc])
	}

	for (const [a, b] of pairs) {
		if (!(await isConcurrent(git, a, b))) continue
		const same = sameFileConflict(a, b)
		if (same) {
			if (await isSameFileConflictDismissable(git, same, a, b, cache)) {
				dismissed.push(same)
			} else {
				conflicts.push(same)
				link(a.rel, b.rel, same)
			}
		}
		const dep = dependentFileConflict(graph, a, b)
		if (dep) {
			conflicts.push(dep)
			link(a.rel, b.rel, dep)
		}
	}
	return { conflicts, dismissed, graph: adj }
}

/**
 * Order by amount of modification, descending (R23), ties broken by id.
 */
export function orderByModifications(touched: Map<string, TouchedFiles> | SubTxSnapshot[]): string[] {
	const entries: Array<[string, number]> = Array.isArray(touched)
		? touched.map((s) => [s.rel, s.linesChanged])
		: Array.from(touched.entries()).map(([id, t]) => [id, t.linesChanged])
	return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id)
}
