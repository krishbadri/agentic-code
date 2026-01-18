/**
 * Structural Conflict Detection (R16, R22, R23)
 *
 * Detects conflicts beyond Git's text-based merge:
 * - Same-file overlap: multiple subTx touch the same file
 * - Dependent-file overlap: subTx touch files in the same import graph
 *
 * Uses import graph analysis to detect dependency conflicts.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"

const pexec = promisify(execFile)

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
			if (file) {
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
		if (importPath.startsWith(".")) {
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
		if (importPath.startsWith(".")) {
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
			const subA = touchedFilesMap.get(subTxIds[i])!
			const subB = touchedFilesMap.get(subTxIds[j])!

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
			const subA = touchedFilesMap.get(subTxIds[i])!
			const subB = touchedFilesMap.get(subTxIds[j])!

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
