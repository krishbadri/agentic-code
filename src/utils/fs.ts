import fs from "fs/promises"
import * as path from "path"

/**
 * Common file extensions for source code files.
 * Used for extracting file paths from text.
 */
const SOURCE_FILE_EXTENSIONS = [
	"py", "ts", "js", "tsx", "jsx", "java", "go", "rs", "cpp", "c", "h", "hpp",
	"md", "txt", "json", "yaml", "yml", "xml", "html", "css", "scss", "less",
	"rb", "php", "swift", "kt", "scala", "r", "m", "mm", "pl", "sh", "bat", "ps1",
	"vue", "svelte", "sql", "graphql", "proto", "toml", "ini", "cfg", "conf",
]

/**
 * Regex pattern to match file paths in text.
 * Matches paths like: src/file.py, ./utils/helper.ts, tests/test_main.py
 */
const FILE_PATH_PATTERN = new RegExp(
	`(?:^|\\s|["'\`(\\[{])` + // Start of string, whitespace, or common delimiters
	`((?:\\.?\\.?/)?` + // Optional ./ or ../ or /
	`[\\w@.-]+(?:/[\\w@.-]+)*` + // Path segments
	`\\.(?:${SOURCE_FILE_EXTENSIONS.join("|")})` + // File extension
	`)` + // End capture group
	`(?:\\s|["'\`)\]},;:]|$)`, // End delimiters
	"gi"
)

/**
 * Extracts file paths from a text string.
 * Finds paths like src/file.py, ./utils/helper.ts, etc.
 *
 * @param text - The text to search for file paths.
 * @returns An array of unique file paths found in the text.
 */
export function extractFilePathsFromText(text: string): string[] {
	const matches: string[] = []
	let match: RegExpExecArray | null

	// Reset regex state
	FILE_PATH_PATTERN.lastIndex = 0

	while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
		if (match[1]) {
			// Clean the path - remove leading ./ if present
			let filePath = match[1].trim()
			if (filePath.startsWith("./")) {
				filePath = filePath.slice(2)
			}
			matches.push(filePath)
		}
	}

	// Deduplicate while preserving order
	return [...new Set(matches)]
}

/**
 * Validates which file paths exist in the workspace.
 *
 * @param filePaths - Array of relative file paths to check.
 * @param workspaceRoot - The workspace root directory.
 * @returns Object with existing and nonExistent path arrays.
 */
export async function validateFilePaths(
	filePaths: string[],
	workspaceRoot: string
): Promise<{ existing: string[]; nonExistent: string[] }> {
	const existing: string[] = []
	const nonExistent: string[] = []

	for (const filePath of filePaths) {
		const absolutePath = path.resolve(workspaceRoot, filePath)
		const exists = await fileExistsAtPath(absolutePath)
		if (exists) {
			existing.push(filePath)
		} else {
			nonExistent.push(filePath)
		}
	}

	return { existing, nonExistent }
}

/**
 * Lists files in a directory recursively up to a specified depth.
 * Respects common ignore patterns (.git, node_modules, etc.).
 *
 * @param dir - The directory to scan.
 * @param maxDepth - Maximum depth to recurse (default 3).
 * @param currentDepth - Current recursion depth (internal use).
 * @returns Array of relative file paths.
 */
export async function listFilesRecursively(
	dir: string,
	maxDepth: number = 3,
	currentDepth: number = 0,
	baseDir?: string
): Promise<string[]> {
	if (currentDepth >= maxDepth) {
		return []
	}

	const base = baseDir || dir
	const files: string[] = []

	// Directories to skip
	const ignoreDirs = new Set([
		".git", "node_modules", "__pycache__", ".venv", "venv", "env",
		".next", ".nuxt", "dist", "build", "out", ".cache", "coverage",
		".pytest_cache", ".mypy_cache", ".tox", "eggs", "*.egg-info",
	])

	try {
		const entries = await fs.readdir(dir, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name)
			const relativePath = path.relative(base, fullPath)

			if (entry.isDirectory()) {
				// Skip ignored directories
				if (ignoreDirs.has(entry.name) || entry.name.endsWith(".egg-info")) {
					continue
				}
				// Recurse into subdirectory
				const subFiles = await listFilesRecursively(fullPath, maxDepth, currentDepth + 1, base)
				files.push(...subFiles)
			} else if (entry.isFile()) {
				// Only include source files
				const ext = path.extname(entry.name).slice(1).toLowerCase()
				if (SOURCE_FILE_EXTENSIONS.includes(ext)) {
					files.push(relativePath.replace(/\\/g, "/")) // Normalize to forward slashes
				}
			}
		}
	} catch {
		// Directory read failed - skip
	}

	return files
}

/**
 * Gets a summary of the repository structure for grounding LLM prompts.
 * Returns a concise list of directories and file counts.
 *
 * @param workspaceRoot - The workspace root directory.
 * @param maxDepth - Maximum depth to scan (default 2).
 * @returns A formatted string describing the repository structure.
 */
export async function getRepositoryStructureSummary(
	workspaceRoot: string,
	maxDepth: number = 2
): Promise<string> {
	const lines: string[] = []

	// Common project indicator files
	const projectFiles = [
		"pyproject.toml", "package.json", "setup.py", "requirements.txt",
		"Cargo.toml", "go.mod", "pom.xml", "build.gradle", "CMakeLists.txt",
	]

	// Check for project indicator files at root
	for (const file of projectFiles) {
		const exists = await fileExistsAtPath(path.join(workspaceRoot, file))
		if (exists) {
			lines.push(`✓ ${file}`)
		}
	}

	// Get directory structure
	try {
		const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
		const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")

		for (const dir of dirs.slice(0, 10)) { // Limit to 10 directories
			const dirPath = path.join(workspaceRoot, dir.name)
			const subFiles = await listFilesRecursively(dirPath, maxDepth, 0, dirPath)
			
			if (subFiles.length > 0) {
				lines.push(`📁 ${dir.name}/ (${subFiles.length} source files)`)
				// Show first few files
				for (const file of subFiles.slice(0, 5)) {
					lines.push(`  - ${dir.name}/${file}`)
				}
				if (subFiles.length > 5) {
					lines.push(`  ... and ${subFiles.length - 5} more files`)
				}
			} else {
				lines.push(`📁 ${dir.name}/`)
			}
		}
	} catch {
		lines.push("(Could not read directory structure)")
	}

	return lines.join("\n")
}

/**
 * Asynchronously creates all non-existing subdirectories for a given file path
 * and collects them in an array for later deletion.
 *
 * @param filePath - The full path to a file.
 * @returns A promise that resolves to an array of newly created directories.
 */
export async function createDirectoriesForFile(filePath: string): Promise<string[]> {
	const newDirectories: string[] = []
	const normalizedFilePath = path.normalize(filePath) // Normalize path for cross-platform compatibility
	const directoryPath = path.dirname(normalizedFilePath)

	let currentPath = directoryPath
	const dirsToCreate: string[] = []

	// Traverse up the directory tree and collect missing directories
	while (!(await fileExistsAtPath(currentPath))) {
		dirsToCreate.push(currentPath)
		currentPath = path.dirname(currentPath)
	}

	// Create directories from the topmost missing one down to the target directory
	for (let i = dirsToCreate.length - 1; i >= 0; i--) {
		await fs.mkdir(dirsToCreate[i])
		newDirectories.push(dirsToCreate[i])
	}

	return newDirectories
}

/**
 * Helper function to check if a path exists.
 *
 * @param path - The path to check.
 * @returns A promise that resolves to true if the path exists, false otherwise.
 */
export async function fileExistsAtPath(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}
