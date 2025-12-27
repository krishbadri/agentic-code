import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
const pexec = promisify(execFile)

export type GitConfig = { repoRoot: string }

export class Git {
	constructor(private cfg: GitConfig) {}

	private async git(args: string[], cwd?: string) {
		return pexec("git", args, { cwd: cwd ?? this.cfg.repoRoot, windowsHide: true })
	}

	public worktreePath(tx_id: string) {
		return path.join(this.cfg.repoRoot, ".cp", "worktrees", `tx_${tx_id}`)
	}

	public async revParse(ref: string, cwd?: string) {
		const { stdout } = await this.git(["rev-parse", ref], cwd)
		return stdout.trim()
	}

	public async beginTx(tx_id: string, base: string) {
		const baseSha = await this.revParse(base)
		await this.git(["branch", `tx/${tx_id}`, baseSha])
		await this.git(["worktree", "add", this.worktreePath(tx_id), `tx/${tx_id}`])
		return baseSha
	}

	public async applyPatch(tx_id: string, filePath: string, patch: string) {
		const wt = this.worktreePath(tx_id)
		// Write patch to a temp file and apply
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-cp-"))
		const patchPath = path.join(tmpDir, "patch.diff")
		await fs.writeFile(patchPath, patch, "utf8")
		try {
			await this.git(["apply", "--whitespace=nowarn", "-p0", patchPath], wt)
			await this.git(["add", filePath], wt)
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
		}
	}

	public async writeFile(tx_id: string, filePath: string, content: Buffer, mode?: string) {
		const wt = this.worktreePath(tx_id)
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
		await this.git(["commit", "-m", message], wt)
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

		// Create branch for sub-transaction
		const branchName = `tx/${parentTxId}/sub/${subTxId}`
		await this.git(["branch", branchName, baseSha])

		// Create worktree for sub-transaction
		const subWt = this.subTxWorktreePath(parentTxId, subTxId)
		await this.git(["worktree", "add", subWt, branchName])

		return subWt
	}

	public async mergeSubTx(parentTxId: string, subTxId: string): Promise<void> {
		const parentWt = this.worktreePath(parentTxId)
		const subWt = this.subTxWorktreePath(parentTxId, subTxId)
		const branchName = `tx/${parentTxId}/sub/${subTxId}`

		// Check if sub-transaction has any commits
		try {
			// Get the current HEAD of sub-transaction
			const subHead = await this.revParse("HEAD", subWt)

			// Merge sub-transaction branch into parent worktree
			await this.git(["checkout", `tx/${parentTxId}`], parentWt)
			await this.git(["merge", "--no-ff", "-m", `[cp] Merge sub-transaction ${subTxId}`, branchName], parentWt)
		} catch {
			// No commits in sub-transaction, nothing to merge - just clean up
		}

		// Clean up sub-transaction worktree and branch
		await this.git(["worktree", "remove", subWt, "--force"])
		await this.git(["branch", "-D", branchName])
	}

	public async rollbackSubTx(parentTxId: string, subTxId: string): Promise<void> {
		const subWt = this.subTxWorktreePath(parentTxId, subTxId)
		const branchName = `tx/${parentTxId}/sub/${subTxId}`

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

		// Reset sub-transaction worktree to base
		await this.git(["reset", "--hard", baseSha], subWt)

		// Clean up sub-transaction worktree and branch
		await this.git(["worktree", "remove", subWt, "--force"])
		await this.git(["branch", "-D", branchName])
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
					// Determine the branch name
					let branchName: string
					if (isSubTx && parentTxId && subTxId) {
						branchName = `tx/${parentTxId}/sub/${subTxId}`
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
	 * Get list of all tx/* branches that may need cleanup
	 */
	public async listOrphanedBranches(activeTxIds: Set<string> = new Set()): Promise<string[]> {
		const orphaned: string[] = []

		try {
			// List all branches matching tx/*
			const { stdout } = await this.git(["branch", "--list", "tx/*"])
			const branches = stdout
				.split("\n")
				.map((b) => b.trim().replace(/^\*\s*/, ""))
				.filter(Boolean)

			for (const branch of branches) {
				// Parse transaction ID from branch name
				// Format: tx/<txId> or tx/<parentTxId>/sub/<subTxId>
				const match = branch.match(/^tx\/([^/]+)/)
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
