import * as path from "path"
import os from "os"
import * as vscode from "vscode"

/*
The Node.js 'path' module resolves and normalizes paths differently depending on the platform:
- On Windows, it uses backslashes (\) as the default path separator.
- On POSIX-compliant systems (Linux, macOS), it uses forward slashes (/) as the default path separator.

While modules like 'upath' can be used to normalize paths to use forward slashes consistently,
this can create inconsistencies when interfacing with other modules (like vscode.fs) that use
backslashes on Windows.

Our approach:
1. We present paths with forward slashes to the AI and user for consistency.
2. We use the 'arePathsEqual' function for safe path comparisons.
3. Internally, Node.js gracefully handles both backslashes and forward slashes.

This strategy ensures consistent path presentation while leveraging Node.js's built-in
path handling capabilities across different platforms.

Note: When interacting with the file system or VS Code APIs, we still use the native path module
to ensure correct behavior on all platforms. The toPosixPath and arePathsEqual functions are
primarily used for presentation and comparison purposes, not for actual file system operations.

Observations:
- Macos isn't so flexible with mixed separators, whereas windows can handle both. ("Node.js does automatically handle path separators on Windows, converting forward slashes to backslashes as needed. However, on macOS and other Unix-like systems, the path separator is always a forward slash (/), and backslashes are treated as regular characters.")
*/

function toPosixPath(p: string) {
	// Extended-Length Paths in Windows start with "\\?\" to allow longer paths and bypass usual parsing. If detected, we return the path unmodified to maintain functionality, as altering these paths could break their special syntax.
	const isExtendedLengthPath = p.startsWith("\\\\?\\")

	if (isExtendedLengthPath) {
		return p
	}

	return p.replace(/\\/g, "/")
}

// Declaration merging allows us to add a new method to the String type
// You must import this file in your entry point (extension.ts) to have access at runtime
declare global {
	interface String {
		toPosix(): string
	}
}

String.prototype.toPosix = function (this: string): string {
	return toPosixPath(this)
}

// Safe path comparison that works across different platforms
export function arePathsEqual(path1?: string, path2?: string): boolean {
	if (!path1 && !path2) {
		return true
	}
	if (!path1 || !path2) {
		return false
	}

	path1 = normalizePath(path1)
	path2 = normalizePath(path2)

	if (process.platform === "win32") {
		return path1.toLowerCase() === path2.toLowerCase()
	}
	return path1 === path2
}

function normalizePath(p: string): string {
	// normalize resolve ./.. segments, removes duplicate slashes, and standardizes path separators
	let normalized = path.normalize(p)
	// however it doesn't remove trailing slashes
	// remove trailing slash, except for root paths
	if (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
		normalized = normalized.slice(0, -1)
	}
	return normalized
}

export function getReadablePath(cwd: string, relPath?: string): string {
	relPath = relPath || ""
	// path.resolve is flexible in that it will resolve relative paths like '../../' to the cwd and even ignore the cwd if the relPath is actually an absolute path
	const absolutePath = path.resolve(cwd, relPath)
	if (arePathsEqual(cwd, path.join(os.homedir(), "Desktop"))) {
		// User opened vscode without a workspace, so cwd is the Desktop. Show the full absolute path to keep the user aware of where files are being created
		return absolutePath.toPosix()
	}
	if (arePathsEqual(path.normalize(absolutePath), path.normalize(cwd))) {
		return path.basename(absolutePath).toPosix()
	} else {
		// show the relative path to the cwd
		const normalizedRelPath = path.relative(cwd, absolutePath)
		if (absolutePath.includes(cwd)) {
			return normalizedRelPath.toPosix()
		} else {
			// we are outside the cwd, so show the absolute path (useful for when cline passes in '../../' for example)
			return absolutePath.toPosix()
		}
	}
}

export const toRelativePath = (filePath: string, cwd: string) => {
	const relativePath = path.relative(cwd, filePath).toPosix()
	return filePath.endsWith("/") ? relativePath + "/" : relativePath
}

/**
 * Detects the actual project root by searching for project indicators.
 * If the workspace root doesn't contain project files, searches nested directories.
 * This handles cases where VS Code opens a parent folder but the project is nested.
 */
async function detectProjectRoot(candidateRoot: string): Promise<string> {
	const fs = await import("fs/promises")
	
	// Check if candidate root itself is a project root
	const projectIndicators = ["pyproject.toml", "package.json", "setup.py", "requirements.txt"]
	const hasProjectFile = await Promise.all(
		projectIndicators.map((indicator) =>
			fs.access(path.join(candidateRoot, indicator))
				.then(() => true)
				.catch(() => false),
		),
	).then((results) => results.some((r) => r))
	
	// Check for src/ or tests/ directories
	let hasProjectStructure = false
	try {
		const entries = await fs.readdir(candidateRoot, { withFileTypes: true })
		hasProjectStructure = entries.some(
			(e) => e.isDirectory() && (e.name === "src" || e.name === "tests" || e.name === "test"),
		)
	} catch {
		// Can't read directory
	}
	
	if (hasProjectFile || hasProjectStructure) {
		return candidateRoot
	}
	
	// Search nested directories for project root
	try {
		const entries = await fs.readdir(candidateRoot, { withFileTypes: true })
		const directories = entries.filter((e) => e.isDirectory())
		
		// Try each subdirectory
		for (const dir of directories) {
			const nestedPath = path.join(candidateRoot, dir.name)
			const nestedRoot = await detectProjectRoot(nestedPath)
			if (nestedRoot !== nestedPath) {
				// Found a project root deeper
				return nestedRoot
			}
			
			// Check if this nested directory is a project root
			const nestedHasProjectFile = await Promise.all(
				projectIndicators.map((indicator) =>
					fs.access(path.join(nestedPath, indicator))
						.then(() => true)
						.catch(() => false),
				),
			).then((results) => results.some((r) => r))
			
			if (nestedHasProjectFile) {
				console.log(`[path] Detected nested project root: ${nestedPath}`)
				return nestedPath
			}
		}
	} catch {
		// Can't search nested directories
	}
	
	// No project root found, return original
	return candidateRoot
}

export const getWorkspacePath = (defaultCwdPath = "") => {
	// VERIFICATION-ONLY: If TEST_TORTURE_REPO_WORKSPACE is set, use it as the workspace root
	// This ensures deterministic workspace root for torture repo e2e tests
	if (process.env.TEST_TORTURE_REPO_WORKSPACE) {
		const overridePath = process.env.TEST_TORTURE_REPO_WORKSPACE
		// Normalize the path to handle any trailing slashes or path separators
		const normalizedPath = path.normalize(overridePath).replace(/[\/\\]+$/, "")
		return normalizedPath
	}

	const cwdPath = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) || defaultCwdPath
	const currentFileUri = vscode.window.activeTextEditor?.document.uri
	if (currentFileUri) {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentFileUri)
		return workspaceFolder?.uri.fsPath || cwdPath
	}
	return cwdPath
}

/**
 * Gets the workspace path with automatic detection of nested project roots.
 * This is async because it may need to scan the filesystem.
 */
export async function getWorkspacePathWithDetection(defaultCwdPath = ""): Promise<string> {
	const basePath = getWorkspacePath(defaultCwdPath)
	return await detectProjectRoot(basePath)
}

export const getWorkspacePathForContext = (contextPath?: string): string => {
	// If context path provided, find its workspace
	if (contextPath) {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(contextPath))
		if (workspaceFolder) {
			return workspaceFolder.uri.fsPath
		}
		// Debug logging when falling back
		console.debug(`[CodeIndex] No workspace found for context path: ${contextPath}, falling back to default`)
	}

	// Fall back to current behavior
	return getWorkspacePath()
}

/**
 * Resolves a relative file path against the workspace root with fallback to nested project directory.
 * This handles cases where VS Code opens a parent directory but the actual project is in a subdirectory.
 * 
 * @param workspaceRoot - The workspace root path
 * @param relPath - Relative path from workspace root (e.g., "src/file.py")
 * @returns Resolved absolute path, or null if file doesn't exist and no fallback found
 */
export async function resolveFilePathWithFallback(
	workspaceRoot: string,
	relPath: string,
): Promise<string | null> {
	const fs = await import("fs/promises")
	
	// First try: resolve against workspace root
	const primaryPath = path.resolve(workspaceRoot, relPath)
	try {
		await fs.access(primaryPath)
		return primaryPath
	} catch {
		// File not found at primary path
	}
	
	// Fallback: if workspace root has exactly one child directory that looks like a project root,
	// try resolving against that nested directory
	try {
		const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
		const directories = entries.filter((e) => e.isDirectory())
		
		// Only try fallback if there's exactly one subdirectory
		if (directories.length === 1) {
			const nestedRoot = path.join(workspaceRoot, directories[0]!.name)
			
			// Check if nested root looks like a project (has common project indicators)
			const projectIndicators = ["pyproject.toml", "package.json", "src", "tests", "test"]
			const nestedEntries = await fs.readdir(nestedRoot, { withFileTypes: true })
			const hasProjectIndicator = nestedEntries.some((e) => 
				projectIndicators.some((indicator) => 
					e.name === indicator || (e.isDirectory() && e.name === indicator)
				)
			)
			
			if (hasProjectIndicator) {
				const fallbackPath = path.resolve(nestedRoot, relPath)
				try {
					await fs.access(fallbackPath)
					console.log(`[path] Resolved ${relPath} via fallback: ${fallbackPath}`)
					return fallbackPath
				} catch {
					// Fallback path also doesn't exist
				}
			}
		}
	} catch {
		// Error reading directory - skip fallback
	}
	
	// No fallback found, return primary path (caller will handle the error)
	return primaryPath
}
