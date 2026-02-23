import { Task } from "../task/Task"
import type { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { rollbackToCheckpointManual, getCheckpointService } from "../checkpoints"
import { getWorkspacePath } from "../../utils/path"
import { lookupCheckpointName } from "./saveCheckpointTool"

/** Resolve checkpoint name to commit hash.
 *  1. Check in-memory cache (populated by save_checkpoint — works for all service types)
 *  2. Search shadow repo git log (local RepoPerTask service)
 *  3. Fallback: search workspace repo git log
 */
async function resolveCheckpointNameToHash(
	task: Task,
	workspaceDir: string,
	checkpointName: string,
): Promise<{ hash?: string; error?: string }> {
	const normalized = checkpointName.trim().toLowerCase()

	// 1. Check in-memory name→hash cache (set by saveCheckpointTool)
	const cachedHash = lookupCheckpointName(task, checkpointName)
	if (cachedHash) {
		return { hash: cachedHash }
	}

	// 2. Search shadow repo git log (only works for local RepoPerTaskCheckpointService)
	const simpleGit = (await import("simple-git")).default
	try {
		const service = await getCheckpointService(task)
		const shadowDir = (service as any)?.checkpointsDir || (service as any)?.shadowGitDir
		if (shadowDir) {
			const shadowGit = simpleGit(shadowDir, { binary: "git" })
			const shadowLog = await shadowGit.log({ maxCount: 100 })
			const match = shadowLog.all.find((c) => c.message.toLowerCase().includes(normalized))
			if (match) {
				return { hash: match.hash }
			}
		}
	} catch {
		// Shadow repo search failed, fall through to workspace repo
	}

	// 3. Fallback: search the workspace repo
	try {
		const git = simpleGit(workspaceDir, { binary: "git" })
		const log = await git.log({ maxCount: 100 })
		const match = log.all.find((c) => c.message.toLowerCase().includes(normalized))

		if (!match) {
			const recentCommits = log.all
				.slice(0, 10)
				.map((c) => `${c.hash.substring(0, 7)}: ${c.message}`)
				.join("\n  ")
			return {
				error: `No commit found with "${checkpointName}" in message.\n\nSearched in-memory cache, shadow repo, and last 100 commits in ${workspaceDir}.\n\nRecent workspace commits:\n  ${recentCommits}`,
			}
		}

		return { hash: match.hash }
	} catch (error) {
		return {
			error: `Failed to search git log: ${error instanceof Error ? error.message : String(error)}\nWorkspace: ${workspaceDir}`,
		}
	}
}

/** Heuristic: looks like a Git commit hash (full or short). */
function looksLikeHash(s: string): boolean {
	const t = s.trim()
	return /^[a-fA-F0-9]{7,40}$/.test(t)
}

/**
 * rollback_to_checkpoint - Restores repo state to a prior checkpoint (Stage 2 rollback drill).
 * MUST use this tool for rollback - do NOT use git reset, git restore, or manual file deletion.
 */
export async function rollbackToCheckpointTool(
	task: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const commitHashParam = (block.params.commit_hash ?? block.params.hash ?? "").trim()
	const checkpointNameParam = (block.params.checkpoint_name ?? block.params.name ?? "").trim()
	const raw = commitHashParam || checkpointNameParam

	if (!raw) {
		task.consecutiveMistakeCount++
		task.recordToolError("rollback_to_checkpoint")
		pushToolResult(
			formatResponse.toolError(
				"rollback_to_checkpoint requires either commit_hash or checkpoint_name. " +
					"Example: <commit_hash>abc1234</commit_hash> or <checkpoint_name>C1_tests</checkpoint_name>",
			),
		)
		return
	}

	try {
		if (!task.enableCheckpoints) {
			pushToolResult(
				formatResponse.toolError(
					"Checkpoints are not enabled for this task. Enable checkpoints to use rollback_to_checkpoint.",
				),
			)
			return
		}

		let commitHash: string

		if (looksLikeHash(raw)) {
			commitHash = raw
		} else {
			const workspaceDir = task.cwd || getWorkspacePath()
			if (!workspaceDir) {
				pushToolResult(
					formatResponse.toolError("Workspace directory not found; cannot resolve checkpoint by name."),
				)
				return
			}
			const resolved = await resolveCheckpointNameToHash(task, workspaceDir, raw)
			if (resolved.error) {
				pushToolResult(
					formatResponse.toolError(
						`Cannot find checkpoint "${raw}".\n\n${resolved.error}\n\n` +
							`The checkpoint name should match a commit message created by save_checkpoint.\n` +
							`If you just created checkpoint "${raw}", check that save_checkpoint completed successfully.`,
					),
				)
				return
			}
			if (!resolved.hash) {
				pushToolResult(
					formatResponse.toolError(
						`No checkpoint found with name "${raw}". Create a checkpoint first with save_checkpoint.`,
					),
				)
				return
			}
			commitHash = resolved.hash
		}

		await rollbackToCheckpointManual(task, commitHash)

		// Post-rollback verification: report ACTUAL state to the agent
		const verifyLines: string[] = []
		const workspaceDir = task.cwd || getWorkspacePath()
		if (workspaceDir) {
			const simpleGit = (await import("simple-git")).default
			const git = simpleGit(workspaceDir, { binary: "git" })
			const path = await import("path")
			const fs = await import("fs/promises")

			// Check HEAD
			try {
				const head = await git.revparse(["HEAD"])
				const matches = head.startsWith(commitHash.substring(0, 7))
				verifyLines.push(
					`- HEAD: ${head.substring(0, 7)} ${matches ? "(matches checkpoint)" : "(WARNING: mismatch)"}`,
				)
			} catch {
				verifyLines.push("- HEAD: could not verify")
			}

			// Check sentinel
			try {
				await fs.access(path.join(workspaceDir, "ROLLBACK_SENTINEL.txt"))
				verifyLines.push("- ROLLBACK_SENTINEL.txt: WARNING — still exists (rollback may be incomplete)")
			} catch {
				verifyLines.push("- ROLLBACK_SENTINEL.txt: absent (correct)")
			}

			// Check working tree
			try {
				const status = await git.status()
				const total = status.files.length
				verifyLines.push(`- Working tree: ${total === 0 ? "clean" : `${total} modified/untracked files`}`)
			} catch {
				verifyLines.push("- Working tree: could not verify")
			}
		}

		pushToolResult(
			`✓ Rollback to checkpoint (${commitHash.substring(0, 7)}) completed.\n\n` +
				`Verification:\n${verifyLines.join("\n")}\n\n` +
				`System state restored, agent state preserved.`,
		)
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error)
		task.consecutiveMistakeCount++
		pushToolResult(
			formatResponse.toolError(
				`Rollback failed: ${msg}\n\n` +
					`IMPORTANT: Do NOT attempt manual git commands (git reset, git restore, git checkout, etc.). ` +
					`Use only the rollback_to_checkpoint tool for rollback operations. ` +
					`If the checkpoint doesn't exist, first create one with save_checkpoint.`,
			),
		)
	}
}
