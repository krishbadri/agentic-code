import { execFile, exec } from "node:child_process"
import { promisify } from "node:util"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import { CPError } from "./errors.js"
const pexec = promisify(execFile)
const pexecShell = promisify(exec)

export type GitConfig = { repoRoot: string }

/** Cached resolved git binary path (module-level so it persists across Git instances). */
let resolvedGitBinary: string | undefined

/**
 * Resolve the git binary path. Tries (in order):
 * 1. GIT_BINARY_PATH environment variable (set by the VS Code extension)
 * 2. "git" on PATH via shell (handles Windows PATH/PATHEXT quirks)
 * 3. `where git` (Windows) / `which git` (Unix) to discover the full path
 * 4. Common Windows install locations
 */
async function resolveGitBinary(): Promise<string> {
	if (resolvedGitBinary) return resolvedGitBinary

	// 1. Check environment variable (passed by VS Code extension host)
	if (process.env.GIT_BINARY_PATH) {
		try {
			await pexec(process.env.GIT_BINARY_PATH, ["--version"], { windowsHide: true })
			resolvedGitBinary = process.env.GIT_BINARY_PATH
			console.log(`[CP/Git] Using GIT_BINARY_PATH: ${resolvedGitBinary}`)
			return resolvedGitBinary
		} catch {
			// env var set but path invalid, continue
		}
	}

	// 2. Try plain "git" via shell (handles PATH + PATHEXT correctly on Windows)
	try {
		const { stdout } = await pexecShell("git --version", { windowsHide: true })
		if (stdout.includes("git version")) {
			// "git" works via shell – now find the actual path for execFile use
			const findCmd = process.platform === "win32" ? "where git" : "which git"
			try {
				const { stdout: pathOut } = await pexecShell(findCmd, { windowsHide: true })
				const gitPath = pathOut.trim().split(/\r?\n/)[0]?.trim()
				if (gitPath) {
					resolvedGitBinary = gitPath
					console.log(`[CP/Git] Resolved git binary: ${resolvedGitBinary}`)
					return resolvedGitBinary
				}
			} catch {
				// where/which failed but git works via shell – use "git" with shell fallback
			}
			// Shell can find git but we couldn't get the path; use "git" and hope execFile works
			resolvedGitBinary = "git"
			return resolvedGitBinary
		}
	} catch {
		// git not available via shell either
	}

	// 3. Windows: try common install locations
	if (process.platform === "win32") {
		const candidates = [
			path.join("C:", "Program Files", "Git", "cmd", "git.exe"),
			path.join("C:", "Program Files", "Git", "bin", "git.exe"),
			path.join("C:", "Program Files", "Git", "mingw64", "bin", "git.exe"),
			path.join("C:", "Program Files (x86)", "Git", "cmd", "git.exe"),
			path.join("C:", "Program Files (x86)", "Git", "bin", "git.exe"),
		]
		for (const candidate of candidates) {
			try {
				await pexec(candidate, ["--version"], { windowsHide: true })
				resolvedGitBinary = candidate
				console.log(`[CP/Git] Found git at fallback path: ${resolvedGitBinary}`)
				return resolvedGitBinary
			} catch {
				// try next
			}
		}
	}

	throw new Error("git not found: checked PATH, GIT_BINARY_PATH env, where/which, and common install locations")
}

export class Git {
	constructor(private cfg: GitConfig) {}

	private async git(args: string[], cwd?: string) {
		const binary = await resolveGitBinary()
		return pexec(binary, args, { cwd: cwd ?? this.cfg.repoRoot, windowsHide: true })
	}

	/**
	 * Assert that a relative path is safe for use within a worktree.
	 * Enforces:
	 * - rel is NOT absolute
	 * - rel does NOT contain .. segments
	 * - rel does NOT contain \0
	 * - normalized join stays within worktree root
	 */
	private assertSafeRelPath(rel: string, worktreePath: string): void {
		// Check for null bytes
		if (rel.includes("\0")) {
			throw new CPError("DENIED", "Path contains null byte", { path: rel })
		}

		// Check for absolute path
		if (path.isAbsolute(rel)) {
			throw new CPError("DENIED", "Absolute path not allowed", { path: rel })
		}

		// Check for .. segments
		if (rel.includes("..")) {
			throw new CPError("DENIED", "Path traversal (..) not allowed", { path: rel })
		}

		// Normalize and check that resolved path stays within worktree
		const normalizedWt = path.resolve(worktreePath)
		const resolved = path.resolve(worktreePath, rel)

		// Ensure resolved path is within worktree (handle both Windows and Unix paths)
		if (!resolved.startsWith(normalizedWt + path.sep) && resolved !== normalizedWt) {
			throw new CPError("DENIED", "Path resolves outside worktree", { path: rel })
		}
	}

	/**
	 * Check if any segment in the path is a symlink.
	 * Walks each path segment under the worktree and checks with lstat.
	 */
	private async checkSymlinkPath(rel: string, worktreePath: string): Promise<void> {
		const normalizedWt = path.resolve(worktreePath)
		const fullPath = path.resolve(worktreePath, rel)

		// Build path segments from worktree root to target
		const segments: string[] = [normalizedWt]
		const relParts = rel.split(path.sep).filter(Boolean)

		// Build each segment path
		let current = normalizedWt
		for (const part of relParts) {
			current = path.join(current, part)
			segments.push(current)
		}

		// Check each segment (excluding the final target file, which we're creating)
		// We check all parent directories
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i]
			if (!segment) continue

			// Skip if we've gone outside worktree (shouldn't happen after assertSafeRelPath)
			if (!segment.startsWith(normalizedWt + path.sep) && segment !== normalizedWt) {
				continue
			}

			try {
				const stats = await fs.lstat(segment)
				if (stats.isSymbolicLink()) {
					throw new CPError("DENIED", "Symlink path not allowed", { path: rel })
				}
			} catch (e) {
				// If lstat fails because path doesn't exist, that's OK (we're creating it)
				// But if it's a symlink error, rethrow
				if (e instanceof CPError && e.code === "DENIED") {
					throw e
				}
				// Otherwise, path doesn't exist yet - that's fine, continue checking
			}
		}
	}

	public worktreePath(tx_id: string) {
		return path.join(this.cfg.repoRoot, ".cp", "worktrees", `tx_${tx_id}`)
	}

	public async revParse(ref: string, cwd?: string) {
		const { stdout } = await this.git(["rev-parse", ref], cwd)
		return stdout.trim()
	}

	/**
	 * Reset a worktree to a specific commit (hard reset).
	 * R33: Used for progress gate rollback.
	 * Cleans untracked files first so test artifacts (coverage, __pycache__,
	 * jest transform caches) from the bad state don't survive the reset and
	 * corrupt subsequent test runs.
	 */
	public async resetHard(tx_id: string, targetRef: string): Promise<void> {
		const wt = this.worktreePath(tx_id)
		await this.git(["clean", "-fd"], wt)
		await this.git(["reset", "--hard", targetRef], wt)
	}

	public async beginTx(tx_id: string, base: string) {
		const baseSha = await this.revParse(base)
		await this.git(["branch", `tx/${tx_id}`, baseSha])
		await this.git(["worktree", "add", this.worktreePath(tx_id), `tx/${tx_id}`])
		return baseSha
	}

	/**
	 * Apply a patch to a worktree.
	 *
	 * R26: Uses `git apply --reject` to handle partial applies.
	 *
	 * If any hunks are rejected, .rej files are created. This method:
	 * 1. Detects .rej files after apply
	 * 2. Validates .rej files are within worktree (path safety)
	 * 3. Treats .rej files as failure (no explicit resolution flow)
	 * 4. Returns deterministic error with .rej file paths
	 */
	public async applyPatch(tx_id: string, filePath: string, patch: string) {
		const wt = this.worktreePath(tx_id)

		// SECURITY: Validate file path before processing
		this.assertSafeRelPath(filePath, wt)

		// Write patch to a temp file and apply
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-cp-"))
		const patchPath = path.join(tmpDir, "patch.diff")
		await fs.writeFile(patchPath, patch, "utf8")

		// Save current HEAD before applying (for rollback if partial apply occurs)
		let headBeforeApply: string
		try {
			headBeforeApply = await this.revParse("HEAD", wt)
		} catch {
			// If HEAD doesn't exist (empty repo), use empty tree
			headBeforeApply = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
		}

		let applySucceeded = false
		try {
			// R26: Use --reject flag for partial apply support
			// REQUIRED: git apply --reject --whitespace=nowarn -p0 <patchPath>
			// Note: git apply --reject may exit with non-zero even if some hunks applied
			// We need to check for .rej files regardless of exit code
			try {
				await this.git(["apply", "--reject", "--whitespace=nowarn", "-p0", patchPath], wt)
				applySucceeded = true
			} catch (e) {
				// git apply --reject may throw even if some hunks applied
				// We'll check for .rej files below
				applySucceeded = false
			}

			// Check for .rej files (rejected hunks)
			const rejFiles = await this.findRejFiles(wt)

			if (rejFiles.length > 0) {
				// Validate path safety: ensure all .rej files are within worktree
				const normalizedWt = path.resolve(wt)
				for (const rejFile of rejFiles) {
					const resolvedRej = path.resolve(wt, rejFile)
					if (!resolvedRej.startsWith(normalizedWt + path.sep) && resolvedRej !== normalizedWt) {
						throw new Error(
							`SECURITY: .rej file path traversal detected: ${rejFile} resolves outside worktree`,
						)
					}
				}

				// CRITICAL: Rollback any applied hunks (we do NOT allow partial applies)
				// Reset worktree to state before apply to remove any partially applied hunks
				try {
					await this.git(["reset", "--hard", headBeforeApply], wt)
				} catch {
					// If reset fails, try to clean up manually
					// This should not happen, but we handle it gracefully
				}

				// Clean up .rej files (they may have been created outside worktree, but we validated paths)
				for (const rejFile of rejFiles) {
					try {
						await fs.unlink(path.join(wt, rejFile))
					} catch {
						// Ignore cleanup errors (file may not exist after reset)
					}
				}

				// R26: Treat .rej files as deterministic failure (no explicit resolution flow)
				// Partial applies are NOT allowed - all hunks must apply or none
				const error = new CPError(
					"PATCH_REJECTED",
					`Patch apply failed: ${rejFiles.length} hunk(s) rejected. .rej files: ${rejFiles.join(", ")}`,
					{ rej_files: rejFiles, file_path: filePath },
				)
				throw error
			}

			// Only add file if apply succeeded and no .rej files
			if (applySucceeded) {
				await this.git(["add", filePath], wt)
			} else {
				// Apply failed completely (no .rej files, but git exited with error)
				// This means the patch was completely invalid, not just partially rejected
				// Rollback to ensure no partial state
				try {
					await this.git(["reset", "--hard", headBeforeApply], wt)
				} catch {
					// Ignore reset errors
				}
				throw new CPError(
					"BAD_PATCH",
					"Patch apply failed completely - patch format may be invalid or file does not exist",
					{ file_path: filePath },
				)
			}
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
		}
	}

	/**
	 * Find all .rej files in a worktree.
	 * Returns relative paths from worktree root.
	 */
	private async findRejFiles(worktreePath: string): Promise<string[]> {
		const rejFiles: string[] = []

		async function scanDir(dir: string, baseDir: string): Promise<void> {
			try {
				const entries = await fs.readdir(dir, { withFileTypes: true })
				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name)
					const relPath = path.relative(baseDir, fullPath)

					if (entry.isDirectory()) {
						// Skip .git directory
						if (entry.name === ".git") continue
						await scanDir(fullPath, baseDir)
					} else if (entry.name.endsWith(".rej")) {
						rejFiles.push(relPath)
					}
				}
			} catch {
				// Ignore permission errors, etc.
			}
		}

		await scanDir(worktreePath, worktreePath)
		return rejFiles
	}

	public async writeFile(tx_id: string, filePath: string, content: Buffer, mode?: string) {
		const wt = this.worktreePath(tx_id)

		// SECURITY: Validate file path before processing
		this.assertSafeRelPath(filePath, wt)

		// SECURITY: Check for symlinks in path segments
		await this.checkSymlinkPath(filePath, wt)

		const fs = await import("node:fs/promises")
		const full = path.join(wt, filePath)
		await fs.mkdir(path.dirname(full), { recursive: true })
		await fs.writeFile(full, content)
		if (mode) {
			await fs.chmod(full, parseInt(mode, 8))
		}
		await this.git(["add", filePath], wt)
	}

	public async readFile(tx_id: string, filePath: string) {
		const wt = this.worktreePath(tx_id)
		const fs = await import("node:fs/promises")
		const full = path.join(wt, filePath)
		const buf = await fs.readFile(full)
		const st = await fs.stat(full)
		const mode = (st.mode & 0o777).toString(8).padStart(4, "0")
		return { content: buf, mode }
	}

	public async checkpoint(tx_id: string, message: string) {
		const wt = this.worktreePath(tx_id)
		// Stage all changes before committing
		await this.git(["add", "-A"], wt)
		// Use --allow-empty to handle case where tests ran but no file changes
		await this.git(["commit", "--allow-empty", "-m", message], wt)
		const sha = await this.revParse("HEAD", wt)
		const tag = `cp/${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${sha.slice(0, 7)}`
		await this.git(["tag", tag, sha], wt)
		return { sha, tag }
	}

	public async commitToMain(tx_id: string, baseSha: string, strategy: "fail-fast" | "rebase" | "hybrid") {
		const mainHead = await this.revParse("main")
		if (strategy === "fail-fast" && baseSha !== mainHead) {
			return { conflict: { code: "CONFLICT_BASE_ADVANCED", details: { main_head: mainHead } } }
		}
		if (strategy !== "fail-fast" && baseSha !== mainHead) {
			// attempt rebase
			await this.git(["-C", this.worktreePath(tx_id), "fetch", "--all"]) // safe default
			try {
				await this.git(["-C", this.worktreePath(tx_id), "rebase", "main"])
			} catch (e) {
				// Collect conflicted files
				const { stdout } = await this.git([
					"-C",
					this.worktreePath(tx_id),
					"diff",
					"--name-only",
					"--diff-filter=U",
				])
				const conflicts = stdout
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean)
				return { conflict: { code: "REBASE_CONFLICT", details: { conflicts } } }
			}
		}
		await this.git(["checkout", "main"]) // ensure fast-forward
		await this.git(["merge", "--ff-only", `tx/${tx_id}`])
		const newSha = await this.revParse("HEAD")
		const tag = `cp/${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${newSha.slice(0, 7)}`
		await this.git(["tag", tag, newSha])
		await this.git(["worktree", "remove", this.worktreePath(tx_id), "--force"])
		await this.git(["branch", "-D", `tx/${tx_id}`])
		return { merged_sha: newSha }
	}

	public async showFileAt(sha: string, relPath: string) {
		const { stdout } = await this.git(["show", `${sha}:${relPath}`])
		return Buffer.from(stdout)
	}

	public async status(tx_id: string) {
		const wt = this.worktreePath(tx_id)
		const { stdout } = await this.git(["status", "--porcelain=v1"], wt)
		const changes = stdout
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const staged = !!l[0]?.trim()
				const status = (staged ? l[0] : l[1])?.trim() || ""
				const pathPart = l.slice(3)
				return { path: pathPart, status, staged }
			})
		return { changes }
	}

	public async getCheckpoints(tx_id: string) {
		const wt = this.worktreePath(tx_id)
		const { stdout } = await this.git(["log", "--oneline", "--format=%H|%ct|%s", "HEAD"], wt)
		const checkpoints = stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [hash, timestamp, message] = line.split("|")
				const reason = message?.includes("[cp]") ? (message.includes("auto") ? "auto" : "manual") : "unknown"
				return {
					hash,
					timestamp: parseInt(timestamp || "0") * 1000, // Convert to milliseconds
					reason,
					message: message || "",
					files_changed: [], // TODO: implement diff summary
				}
			})
		return checkpoints
	}

	/**
	 * Create a sub-transaction worktree (nested under parent transaction)
	 */
	public subTxWorktreePath(parentTxId: string, subTxId: string) {
		return path.join(this.cfg.repoRoot, ".cp", "worktrees", `tx_${parentTxId}_sub_${subTxId}`)
	}

	/**
	 * Get the branch name for a sub-transaction.
	 * Uses flat naming (tx-<parentId>-sub-<subId>) to avoid Git ref path conflicts.
	 * R25: Branch naming must be compatible with Git's ref storage model.
	 */
	public subTxBranchName(parentTxId: string, subTxId: string): string {
		// CRITICAL: Use flat naming to avoid hierarchical ref conflict
		// Git cannot have both refs/heads/tx/abc (file) and refs/heads/tx/abc/sub/xyz (requires abc to be dir)
		return `tx-${parentTxId}-sub-${subTxId}`
	}

	public async beginSubTx(parentTxId: string, subTxId: string, base: string): Promise<string> {
		// Get the current HEAD of the parent transaction worktree
		const parentWt = this.worktreePath(parentTxId)
		let baseSha: string

		if (base === parentTxId) {
			// Use parent's current HEAD
			baseSha = await this.revParse("HEAD", parentWt)
		} else {
			// Use specified base commit
			baseSha = await this.revParse(base)
		}

		// R25: Use `git worktree add -B` for atomic branch creation + worktree setup
		const branchName = this.subTxBranchName(parentTxId, subTxId)
		const subWt = this.subTxWorktreePath(parentTxId, subTxId)

		// Single atomic command: create/reset branch AND create worktree
		await this.git(["worktree", "add", "-B", branchName, subWt, baseSha])

		return subWt
	}

	/**
	 * Merge a sub-transaction into its parent transaction.
	 * R27: Uses `git merge --no-ff` for explicit merge commits.
	 * R28: Cleans up worktree and branch after merge.
	 * R15, R17: Detects conflicts at merge time and aborts/rolls back on failure.
	 */
	public async mergeSubTx(parentTxId: string, subTxId: string): Promise<{ merged: boolean; conflict?: string }> {
		const parentWt = this.worktreePath(parentTxId)
		const subWt = this.subTxWorktreePath(parentTxId, subTxId)
		const branchName = this.subTxBranchName(parentTxId, subTxId)
		let merged = false

		try {
			// Check if sub-transaction has any commits
			let hasCommits = false
			try {
				await this.revParse("HEAD", subWt)
				hasCommits = true
			} catch {
				// No commits in sub-transaction
			}

			if (!hasCommits) {
				// Nothing to merge - just clean up
				return { merged: false }
			}

			// R27: Merge sub-transaction branch into parent worktree using --no-ff
			await this.git(["checkout", `tx/${parentTxId}`], parentWt)

			// Get HEAD before merge for potential rollback
			const headBefore = await this.revParse("HEAD", parentWt)

			try {
				await this.git(
					["merge", "--no-ff", "-m", `[cp] Merge sub-transaction ${subTxId}`, branchName],
					parentWt,
				)

				// R15: Check for unmerged files after merge (some conflicts may not throw)
				const { stdout: statusOut } = await this.git(["status", "--porcelain"], parentWt)
				const hasUnmerged = statusOut.split("\n").some((line) => {
					const status = line.substring(0, 2)
					return status.includes("U") || status === "DD" || status === "AA"
				})
				if (hasUnmerged) {
					// R28: Abort the merge on conflict
					await this.abortMerge(parentWt, headBefore)
					return { merged: false, conflict: "Unmerged files detected after merge" }
				}

				// Check for merge conflict markers in any modified files
				const conflictMarkers = await this.hasConflictMarkers(parentWt)
				if (conflictMarkers) {
					await this.abortMerge(parentWt, headBefore)
					return { merged: false, conflict: "Merge conflict markers found in files" }
				}

				merged = true
			} catch (e) {
				// Git merge failed - this is a conflict
				const errMsg = String(e)
				await this.abortMerge(parentWt, headBefore)
				return { merged: false, conflict: errMsg }
			}
		} finally {
			// R28: Always clean up sub-transaction worktree and branch
			await this.cleanupSubTx(parentTxId, subTxId)
		}

		return { merged }
	}

	/**
	 * Abort a merge in progress and reset to a known good state.
	 */
	private async abortMerge(worktree: string, resetTo: string): Promise<void> {
		try {
			await this.git(["merge", "--abort"], worktree)
		} catch {
			// merge --abort may fail if no merge in progress
		}
		try {
			await this.git(["reset", "--hard", resetTo], worktree)
		} catch {
			// Ignore reset errors
		}
	}

	/**
	 * Check if any tracked files contain conflict markers (<<<<<<< / >>>>>>> / =======).
	 */
	private async hasConflictMarkers(worktree: string): Promise<boolean> {
		try {
			const { stdout } = await this.git(["diff", "--check"], worktree)
			// git diff --check reports conflict markers
			return stdout.includes("conflict") || stdout.includes("<<<<<<<") || stdout.includes(">>>>>>>")
		} catch (e) {
			// git diff --check exits with non-zero if there are issues
			const errMsg = String(e)
			return errMsg.includes("conflict") || errMsg.includes("<<<<<<<") || errMsg.includes(">>>>>>>")
		}
	}

	/**
	 * Clean up a sub-transaction's worktree and branch.
	 * R28: Rollback uses `git worktree remove --force` + `git branch -D`.
	 */
	private async cleanupSubTx(parentTxId: string, subTxId: string): Promise<void> {
		const subWt = this.subTxWorktreePath(parentTxId, subTxId)
		const branchName = this.subTxBranchName(parentTxId, subTxId)

		// Remove worktree first (required before branch deletion)
		try {
			await this.git(["worktree", "remove", subWt, "--force"])
		} catch {
			// Worktree may already be removed or not exist
			try {
				await fs.rm(subWt, { recursive: true, force: true })
			} catch {
				// Ignore cleanup errors
			}
		}

		// Remove branch
		try {
			await this.git(["branch", "-D", branchName])
		} catch {
			// Branch may already be deleted
		}
	}

	/**
	 * Rollback a sub-transaction, discarding all changes.
	 * R7: Rollback restores to last good checkpoint.
	 * R28: Rollback uses `git merge --abort` + `git worktree remove --force` + `git branch -D`.
	 */
	public async rollbackSubTx(parentTxId: string, subTxId: string): Promise<void> {
		const subWt = this.subTxWorktreePath(parentTxId, subTxId)
		const branchName = this.subTxBranchName(parentTxId, subTxId)

		try {
			// Get the base commit - try parent first, fallback to branch itself, then parent's HEAD
			let baseSha: string
			try {
				baseSha = await this.revParse(`${branchName}^`, subWt)
			} catch {
				// Branch has no parent (just created, no commits), try the branch itself
				try {
					baseSha = await this.revParse(branchName, subWt)
				} catch {
					// Branch doesn't exist or is empty, use parent's HEAD
					const parentWt = this.worktreePath(parentTxId)
					baseSha = await this.revParse("HEAD", parentWt)
				}
			}

			// Reset sub-transaction worktree to base (restore last good state)
			try {
				await this.git(["reset", "--hard", baseSha], subWt)
			} catch {
				// Reset may fail if worktree is corrupted - proceed with cleanup
			}
		} finally {
			// R28: Always clean up worktree and branch
			await this.cleanupSubTx(parentTxId, subTxId)
		}
	}

	// ============================================================================
	// P3 FIX: Cleanup Stale Worktrees on Startup
	// ============================================================================

	/**
	 * Clean up stale worktrees and branches left over from crashes/restarts.
	 *
	 * P3 FIX: This prevents leaked worktrees/branches after crashes.
	 *
	 * Strategy:
	 * 1. List all worktrees in .cp/worktrees/
	 * 2. Check each against active transactions in the database
	 * 3. Remove orphaned worktrees and their associated branches
	 *
	 * @param activeTxIds - Set of transaction IDs that are currently active
	 * @returns Cleanup results with details of what was removed
	 */
	public async cleanupStaleWorktrees(activeTxIds: Set<string> = new Set()): Promise<{
		worktreesRemoved: string[]
		branchesRemoved: string[]
		errors: string[]
	}> {
		const worktreesRemoved: string[] = []
		const branchesRemoved: string[] = []
		const errors: string[] = []

		const worktreesDir = path.join(this.cfg.repoRoot, ".cp", "worktrees")

		try {
			// Check if worktrees directory exists
			await fs.access(worktreesDir)
		} catch {
			// No worktrees directory - nothing to clean up
			return { worktreesRemoved, branchesRemoved, errors }
		}

		try {
			// List all directories in .cp/worktrees/
			const entries = await fs.readdir(worktreesDir, { withFileTypes: true })

			for (const entry of entries) {
				if (!entry.isDirectory()) continue

				const worktreeName = entry.name
				const worktreePath = path.join(worktreesDir, worktreeName)

				// Parse transaction ID from worktree name
				// Format: tx_<txId> or tx_<parentTxId>_sub_<subTxId>
				let txId: string | null = null
				let isSubTx = false
				let subTxId: string | null = null
				let parentTxId: string | null = null

				if (worktreeName.startsWith("tx_")) {
					const parts = worktreeName.substring(3).split("_sub_")
					if (parts.length === 2 && parts[0] && parts[1]) {
						// Sub-transaction worktree
						parentTxId = parts[0]
						subTxId = parts[1]
						txId = parentTxId
						isSubTx = true
					} else if (parts[0]) {
						// Parent transaction worktree
						txId = parts[0]
					}
				}

				// Skip if transaction is active
				if (txId && activeTxIds.has(txId)) {
					continue
				}

				// This worktree is orphaned - clean it up
				try {
					// Determine the branch name (handle both old hierarchical and new flat naming)
					let branchName: string
					if (isSubTx && parentTxId && subTxId) {
						// Use new flat naming scheme
						branchName = this.subTxBranchName(parentTxId, subTxId)
					} else if (txId) {
						branchName = `tx/${txId}`
					} else {
						// Can't determine branch - just remove worktree
						branchName = ""
					}

					// Remove the worktree
					try {
						await this.git(["worktree", "remove", worktreePath, "--force"])
						worktreesRemoved.push(worktreePath)
					} catch (e) {
						// If git worktree remove fails, try force removing the directory
						try {
							await fs.rm(worktreePath, { recursive: true, force: true })
							worktreesRemoved.push(worktreePath)
						} catch (e2) {
							errors.push(`Failed to remove worktree ${worktreePath}: ${e2}`)
						}
					}

					// Remove the associated branch if we know it
					if (branchName) {
						try {
							await this.git(["branch", "-D", branchName])
							branchesRemoved.push(branchName)
						} catch {
							// Branch may already be deleted or doesn't exist - that's OK
						}
					}
				} catch (e) {
					errors.push(`Error cleaning up ${worktreePath}: ${e}`)
				}
			}

			// Clean up any dangling worktree entries in git's worktree list
			try {
				await this.git(["worktree", "prune"])
			} catch {
				// Prune failure is not critical
			}
		} catch (e) {
			errors.push(`Error listing worktrees directory: ${e}`)
		}

		return { worktreesRemoved, branchesRemoved, errors }
	}

	/**
	 * Get list of all tx/* and tx-* branches that may need cleanup
	 */
	public async listOrphanedBranches(activeTxIds: Set<string> = new Set()): Promise<string[]> {
		const orphaned: string[] = []

		try {
			// List all branches matching tx/* (parent transactions)
			const { stdout: stdout1 } = await this.git(["branch", "--list", "tx/*"])
			const parentBranches = stdout1
				.split("\n")
				.map((b) => b.trim().replace(/^\*\s*/, ""))
				.filter(Boolean)

			for (const branch of parentBranches) {
				// Parse transaction ID from branch name: tx/<txId>
				const match = branch.match(/^tx\/([^/]+)$/)
				if (match && match[1]) {
					const txId = match[1]
					if (!activeTxIds.has(txId)) {
						orphaned.push(branch)
					}
				}
			}

			// List all branches matching tx-* (sub-transactions with flat naming)
			const { stdout: stdout2 } = await this.git(["branch", "--list", "tx-*"])
			const subTxBranches = stdout2
				.split("\n")
				.map((b) => b.trim().replace(/^\*\s*/, ""))
				.filter(Boolean)

			for (const branch of subTxBranches) {
				// Parse transaction ID from branch name: tx-<parentTxId>-sub-<subTxId>
				const match = branch.match(/^tx-([^-]+)-sub-/)
				if (match && match[1]) {
					const txId = match[1]
					if (!activeTxIds.has(txId)) {
						orphaned.push(branch)
					}
				}
			}
		} catch {
			// List failure is not critical
		}

		return orphaned
	}

	/**
	 * Clean up orphaned branches not associated with active transactions
	 */
	public async cleanupOrphanedBranches(activeTxIds: Set<string> = new Set()): Promise<{
		removed: string[]
		errors: string[]
	}> {
		const removed: string[] = []
		const errors: string[] = []

		const orphaned = await this.listOrphanedBranches(activeTxIds)

		for (const branch of orphaned) {
			try {
				await this.git(["branch", "-D", branch])
				removed.push(branch)
			} catch (e) {
				errors.push(`Failed to remove branch ${branch}: ${e}`)
			}
		}

		return { removed, errors }
	}
}
