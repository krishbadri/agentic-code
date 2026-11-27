/**
 * Structural Conflict Detection (R16, R22, R23)
 *
 * Detects conflicts beyond Git's text-based merge:
 * - Same-file overlap: multiple subTx touch the same file
 * - Dependent-file overlap: subTx touch files in the same import graph
 *
 * Uses import graph analysis to detect dependency conflicts.
 * AST-aware refinement (TS/TSX only) downgrades same-file conflicts
 * when both edits map to disjoint ownable top-level declarations.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
import ts from "typescript"

const pexec = promisify(execFile)

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

export interface ImportGraph {
	// Map from file path to list of files it imports
	imports: Map<string, string[]>
	// Map from file path to list of files that import it (reverse edges)
	importedBy: Map<string, string[]>
}

export interface ConflictResult {
	hasConflict: boolean
	conflictType?: "same-file" | "dependent-file"
	conflictingSubTxs?: [string, string]
	conflictingFiles?: string[]
	message?: string
}

/**
 * Get list of files touched by a sub-transaction (diff against parent).
 */
export async function getTouchedFiles(
	worktreePath: string,
	baseRef: string,
): Promise<{ files: string[]; linesChanged: number }> {
	try {
		// Get diffstat: files and lines changed
		const { stdout } = await pexec("git", ["diff", "--numstat", baseRef, "HEAD"], {
			cwd: worktreePath,
			windowsHide: true,
		})

		const files: string[] = []
		let linesChanged = 0

		for (const line of stdout.trim().split("\n")) {
			if (!line.trim()) continue
			const [added, removed, file] = line.split("\t")
			if (file && added !== undefined && removed !== undefined) {
				files.push(file)
				// Handle binary files (shown as "-")
				const addedNum = added === "-" ? 0 : parseInt(added, 10)
				const removedNum = removed === "-" ? 0 : parseInt(removed, 10)
				linesChanged += addedNum + removedNum
			}
		}

		return { files, linesChanged }
	} catch {
		return { files: [], linesChanged: 0 }
	}
}

/**
 * Parse imports from a TypeScript/JavaScript file.
 * Extracts: import { x } from './file', import x from './file', require('./file')
 */
export function parseImports(content: string, filePath: string, basePath: string): string[] {
	const imports: string[] = []
	const dir = dirname(filePath)

	// Match ES imports: import ... from '...' or import '...'
	const esImportRegex = /import\s+(?:(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?|\*\s+as\s+\w+)\s+from\s+)?['"]([^'"]+)['"]/g
	// Match require: require('...')
	const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g

	let match
	while ((match = esImportRegex.exec(content)) !== null) {
		const importPath = match[1]
		if (importPath && importPath.startsWith(".")) {
			// Resolve relative import
			let resolved = resolve(basePath, dir, importPath)
			// Add common extensions if not present
			if (!resolved.match(/\.(ts|tsx|js|jsx|mjs|cjs)$/)) {
				resolved += ".ts"
			}
			// Make path relative to basePath
			const relative = resolved.replace(basePath + "/", "").replace(basePath + "\\", "")
			imports.push(relative.replace(/\\/g, "/"))
		}
	}

	while ((match = requireRegex.exec(content)) !== null) {
		const importPath = match[1]
		if (importPath && importPath.startsWith(".")) {
			let resolved = resolve(basePath, dir, importPath)
			if (!resolved.match(/\.(ts|tsx|js|jsx|mjs|cjs)$/)) {
				resolved += ".ts"
			}
			const relative = resolved.replace(basePath + "/", "").replace(basePath + "\\", "")
			imports.push(relative.replace(/\\/g, "/"))
		}
	}

	return imports
}

/**
 * Build import graph for a set of files in a worktree.
 */
export async function buildImportGraph(worktreePath: string, files: string[]): Promise<ImportGraph> {
	const imports = new Map<string, string[]>()
	const importedBy = new Map<string, string[]>()

	for (const file of files) {
		if (!file.match(/\.(ts|tsx|js|jsx|mjs|cjs)$/)) continue

		try {
			const fullPath = join(worktreePath, file)
			const content = await readFile(fullPath, "utf8")
			const fileImports = parseImports(content, file, worktreePath)

			imports.set(file, fileImports)

			// Build reverse edges
			for (const imp of fileImports) {
				if (!importedBy.has(imp)) {
					importedBy.set(imp, [])
				}
				importedBy.get(imp)!.push(file)
			}
		} catch {
			// File might not exist or be binary
		}
	}

	return { imports, importedBy }
}

/**
 * Get the dependency closure (transitive imports) for a file.
 */
export function getDependencyClosure(file: string, graph: ImportGraph, visited = new Set<string>()): Set<string> {
	if (visited.has(file)) return visited
	visited.add(file)

	// Add files this file imports
	const fileImports = graph.imports.get(file) || []
	for (const imp of fileImports) {
		getDependencyClosure(imp, graph, visited)
	}

	// Add files that import this file
	const importers = graph.importedBy.get(file) || []
	for (const importer of importers) {
		getDependencyClosure(importer, graph, visited)
	}

	return visited
}

/**
 * Detect structural conflicts between sub-transactions.
 *
 * Conflict types:
 * 1. Same-file: Two subTx touch the same file
 * 2. Dependent-file: Files are in the same import graph closure
 */
export function detectConflicts(touchedFilesMap: Map<string, TouchedFiles>): ConflictResult[] {
	const conflicts: ConflictResult[] = []
	const subTxIds = Array.from(touchedFilesMap.keys())

	// Check all pairs
	for (let i = 0; i < subTxIds.length; i++) {
		for (let j = i + 1; j < subTxIds.length; j++) {
			const subAId = subTxIds[i]
			const subBId = subTxIds[j]
			if (!subAId || !subBId) continue
			const subA = touchedFilesMap.get(subAId)
			const subB = touchedFilesMap.get(subBId)
			if (!subA || !subB) continue

			// Check same-file overlap
			const overlap = subA.files.filter((f) => subB.files.includes(f))
			if (overlap.length > 0) {
				conflicts.push({
					hasConflict: true,
					conflictType: "same-file",
					conflictingSubTxs: [subA.subTxId, subB.subTxId],
					conflictingFiles: overlap,
					message: `Same-file conflict: ${overlap.join(", ")}`,
				})
			}
		}
	}

	return conflicts
}

/**
 * Detect dependent-file conflicts using import graph analysis.
 */
export async function detectDependentFileConflicts(
	worktreePath: string,
	touchedFilesMap: Map<string, TouchedFiles>,
): Promise<ConflictResult[]> {
	const conflicts: ConflictResult[] = []
	const subTxIds = Array.from(touchedFilesMap.keys())

	// Collect all touched files
	const allFiles = new Set<string>()
	for (const tf of touchedFilesMap.values()) {
		for (const f of tf.files) {
			allFiles.add(f)
		}
	}

	// Build import graph
	const graph = await buildImportGraph(worktreePath, Array.from(allFiles))

	// Check if any pair of subTx has overlapping dependency closures
	for (let i = 0; i < subTxIds.length; i++) {
		for (let j = i + 1; j < subTxIds.length; j++) {
			const subAId = subTxIds[i]
			const subBId = subTxIds[j]
			if (!subAId || !subBId) continue
			const subA = touchedFilesMap.get(subAId)
			const subB = touchedFilesMap.get(subBId)
			if (!subA || !subB) continue

			// Get dependency closures for all files in subA
			const closureA = new Set<string>()
			for (const f of subA.files) {
				for (const dep of getDependencyClosure(f, graph)) {
					closureA.add(dep)
				}
			}

			// Check if any file in subB is in closureA (or vice versa)
			for (const f of subB.files) {
				if (closureA.has(f)) {
					conflicts.push({
						hasConflict: true,
						conflictType: "dependent-file",
						conflictingSubTxs: [subA.subTxId, subB.subTxId],
						conflictingFiles: [f],
						message: `Dependent-file conflict: ${f} is in dependency closure`,
					})
					break // One conflict per pair is enough
				}
			}
		}
	}

	return conflicts
}

/**
 * Order sub-transactions by amount of modifications (lines changed), descending.
 *
 * R23: Deterministic ordering with stable tie-breaker.
 * - Primary sort: linesChanged (descending)
 * - Tie-breaker: subTxId (alphabetical, ascending) using localeCompare for stable ordering
 *
 * This determines merge order for conflicting subTxs.
 */
export function orderByModifications(touchedFilesMap: Map<string, TouchedFiles>): string[] {
	return Array.from(touchedFilesMap.entries())
		.sort((a, b) => {
			// Primary: lines changed (descending)
			const diff = b[1].linesChanged - a[1].linesChanged
			if (diff !== 0) return diff
			// Tie-breaker: subTxId (alphabetical, ascending) for stable ordering
			return a[0].localeCompare(b[0])
		})
		.map(([id]) => id)
}

/**
 * Partition sub-transactions into conflicting and non-conflicting groups.
 */
export function partitionByConflicts(
	subTxIds: string[],
	conflicts: ConflictResult[],
): { noConflict: string[]; conflicting: string[] } {
	const conflictingSet = new Set<string>()
	for (const c of conflicts) {
		if (c.conflictingSubTxs) {
			conflictingSet.add(c.conflictingSubTxs[0])
			conflictingSet.add(c.conflictingSubTxs[1])
		}
	}

	const noConflict = subTxIds.filter((id) => !conflictingSet.has(id))
	const conflicting = subTxIds.filter((id) => conflictingSet.has(id))

	return { noConflict, conflicting }
}

// ---------------------------------------------------------------------------
// AST-aware same-file conflict refinement (TypeScript/TSX only)
// ---------------------------------------------------------------------------

interface TopLevelNode {
	index: number
	startLine: number // 1-based, inclusive
	endLine: number // 1-based, inclusive
	ownable: boolean
}

export interface DiffHunk {
	oldStart: number // 1-based line in base file
	oldCount: number // 0 for pure additions
}

/**
 * Classify whether a top-level statement is an "ownable" declaration
 * (safe to attribute edits to) or an unownable region (imports, bare
 * exports, side-effect expressions) that must remain conservative.
 */
function isOwnableKind(kind: ts.SyntaxKind): boolean {
	switch (kind) {
		case ts.SyntaxKind.FunctionDeclaration:
		case ts.SyntaxKind.ClassDeclaration:
		case ts.SyntaxKind.InterfaceDeclaration:
		case ts.SyntaxKind.TypeAliasDeclaration:
		case ts.SyntaxKind.EnumDeclaration:
		case ts.SyntaxKind.VariableStatement:
			return true
		default:
			return false
	}
}

/**
 * Parse a TypeScript/TSX file and return its top-level statement ranges.
 * Returns null on parse failure (caller should treat as conservative).
 */
export function getTopLevelNodes(content: string, fileName = "file.ts"): TopLevelNode[] | null {
	try {
		const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
		const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind)

		const nodes: TopLevelNode[] = []
		let index = 0

		for (const stmt of sourceFile.statements) {
			const startPos = stmt.getStart(sourceFile)
			const endPos = stmt.getEnd()
			const startLine = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1
			const endLine = sourceFile.getLineAndCharacterOfPosition(Math.max(startPos, endPos - 1)).line + 1

			nodes.push({
				index,
				startLine,
				endLine,
				ownable: isOwnableKind(stmt.kind),
			})
			index++
		}

		return nodes
	} catch {
		return null
	}
}

/**
 * Parse unified-diff hunk headers (@@ -old,count +new,count @@).
 */
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
 * Run `git diff --unified=0` for a single file between baseRef and HEAD.
 */
async function getDiffHunksForFile(worktreePath: string, baseRef: string, filePath: string): Promise<DiffHunk[]> {
	try {
		const { stdout } = await pexec("git", ["diff", "--unified=0", baseRef, "HEAD", "--", filePath], {
			cwd: worktreePath,
			windowsHide: true,
		})
		return parseDiffHunks(stdout)
	} catch {
		return []
	}
}

/**
 * Map diff hunks to the set of ownable top-level node indices they fall within.
 * Returns null if any hunk cannot be cleanly attributed to exactly one ownable node.
 */
export function findAffectedNodeIndices(hunks: DiffHunk[], nodes: TopLevelNode[]): Set<number> | null {
	const ownableNodes = nodes.filter((n) => n.ownable)
	const indices = new Set<number>()

	for (const hunk of hunks) {
		const hunkStart = hunk.oldStart
		const hunkEnd = hunk.oldCount > 0 ? hunk.oldStart + hunk.oldCount - 1 : hunk.oldStart

		// Find the single ownable node that fully contains this hunk range
		let found = false
		for (const node of ownableNodes) {
			if (hunkStart >= node.startLine && hunkEnd <= node.endLine) {
				indices.add(node.index)
				found = true
				break
			}
		}

		if (!found) {
			// Hunk is outside any ownable node, spans multiple nodes, or in unowned region
			return null
		}
	}

	return indices
}

/**
 * Determine whether two sets of diff hunks touch entirely disjoint
 * ownable top-level declarations in the base file.
 */
export function areChangesDisjoint(
	baseContent: string,
	fileName: string,
	hunksA: DiffHunk[],
	hunksB: DiffHunk[],
): boolean {
	if (hunksA.length === 0 || hunksB.length === 0) return false

	const nodes = getTopLevelNodes(baseContent, fileName)
	if (!nodes || nodes.length === 0) return false

	const indicesA = findAffectedNodeIndices(hunksA, nodes)
	if (!indicesA || indicesA.size === 0) return false

	const indicesB = findAffectedNodeIndices(hunksB, nodes)
	if (!indicesB || indicesB.size === 0) return false

	for (const i of indicesA) {
		if (indicesB.has(i)) return false
	}
	return true
}

/**
 * Post-process same-file conflicts: remove false positives where both
 * sub-txs' changes map to disjoint ownable top-level TS/TSX declarations.
 *
 * Conservative: keeps the conflict when uncertain (non-TS, parse failure,
 * imports/exports/side-effects, ambiguous ownership).
 */
export async function refineSameFileConflicts(
	conflicts: ConflictResult[],
	parentWorktreePath: string,
	subTxContexts: Map<string, { worktreePath: string; baseRef: string }>,
): Promise<ConflictResult[]> {
	const refined: ConflictResult[] = []

	for (const conflict of conflicts) {
		if (conflict.conflictType !== "same-file" || !conflict.conflictingFiles || !conflict.conflictingSubTxs) {
			refined.push(conflict)
			continue
		}

		const [subAId, subBId] = conflict.conflictingSubTxs
		const ctxA = subTxContexts.get(subAId)
		const ctxB = subTxContexts.get(subBId)

		if (!ctxA || !ctxB) {
			refined.push(conflict)
			continue
		}

		let allDisjoint = true
		for (const file of conflict.conflictingFiles) {
			// Only refine TypeScript files
			if (!/\.tsx?$/.test(file)) {
				allDisjoint = false
				break
			}

			try {
				const baseContent = await readFile(join(parentWorktreePath, file), "utf8")
				const hunksA = await getDiffHunksForFile(ctxA.worktreePath, ctxA.baseRef, file)
				const hunksB = await getDiffHunksForFile(ctxB.worktreePath, ctxB.baseRef, file)

				if (!areChangesDisjoint(baseContent, file, hunksA, hunksB)) {
					allDisjoint = false
					break
				}
			} catch {
				allDisjoint = false
				break
			}
		}

		if (!allDisjoint) {
			refined.push(conflict)
		}
		// Disjoint: drop the false-positive conflict
	}

	return refined
}
