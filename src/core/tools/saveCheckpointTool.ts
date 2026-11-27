import { Task } from "../task/Task"
import type { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { checkpointSaveManual, getCheckpointService } from "../checkpoints"
import {
	evaluateQualityGate,
	recordCheckpointSaved,
	executeQualityGateRollback,
	type QualityGateVerdict,
} from "../checkpoints/QualityGate"

/**
 * In-memory cache of checkpoint name → commit hash, keyed by root task ID.
 * Shared across all tasks in the same hierarchy (parent + children) so that
 * a checkpoint saved by one subtask can be found by any other subtask or parent.
 * (essential for ControlPlaneCheckpointService which has no local git repo).
 */
const checkpointNameCache = new Map<string, Map<string, string>>()

/** Get the root task ID for cache keying (shared across parent/child hierarchy) */
function getCacheKey(task: Task): string {
	return task.rootTaskId || task.rootTask?.taskId || task.taskId
}

export function registerCheckpointName(task: Task, name: string, hash: string): void {
	const key = getCacheKey(task)
	let taskMap = checkpointNameCache.get(key)
	if (!taskMap) {
		taskMap = new Map()
		checkpointNameCache.set(key, taskMap)
	}
	taskMap.set(name.trim().toLowerCase(), hash)
}

export function lookupCheckpointName(task: Task, name: string): string | undefined {
	const key = getCacheKey(task)
	return checkpointNameCache.get(key)?.get(name.trim().toLowerCase())
}

/**
 * save_checkpoint - Creates a checkpoint with an optional name for Stage 2 protocol.
 * Used when the agent needs to create named checkpoints (e.g. C1_tests, C2_impl).
 */
export async function saveCheckpointTool(
	task: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const name = (block.params.name ?? block.params.message ?? "Checkpoint").trim()

	try {
		if (!task.enableCheckpoints) {
			pushToolResult(
				formatResponse.toolError(
					"Checkpoints are not enabled for this task. Enable checkpoints in settings to use save_checkpoint.",
				),
			)
			return
		}

		// Quality gate: run tests/compile and block save if quality regressed
		// (In Control-Plane mode the CP progress gate on /checkpoint is the gate: no local tests.)
		let verdict: QualityGateVerdict = { action: "skip", reason: "not evaluated" }
		try {
			if (!task.worktreeTxId) verdict = await evaluateQualityGate(task, name)
		} catch (qgErr: unknown) {
			const provider = task.providerRef.deref()
			provider?.log?.(
				`[QualityGate] Error (non-fatal, proceeding with save): ${qgErr instanceof Error ? qgErr.message : qgErr}`,
			)
		}

		if (verdict.action === "rollback") {
			const errorMessage = await executeQualityGateRollback(task, verdict)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		const { getWorkspacePath } = await import("../../utils/path")
		let hash: string | undefined

		if (task.worktreeTxId) {
			// Transaction mode (top-level tx or sub-tx child): checkpoint through the
			// Control-Plane on this task's own worktree, subject to its progress gate.
			const result = await checkpointSaveManual(task, true)
			if (result.progressViolation) {
				const v = result.progressViolation
				pushToolResult(
					formatResponse.toolError(
						`Checkpoint "${name}" rejected by the progress gate: ${v.message}.` +
							(v.rollbackTo ? ` The worktree was rolled back to ${v.rollbackTo.substring(0, 7)}.` : "") +
							" Fix the regression before saving a checkpoint.",
					),
				)
				return
			}
			hash = result.hash
		} else {
			// No transaction: local shadow checkpoint service
			const service = await getCheckpointService(task)
			if (!service) {
				pushToolResult(
					formatResponse.toolError(
						"Checkpoint service not available. Ensure Control-Plane or local Git is configured.",
					),
				)
				return
			}

			const result = await service.saveCheckpoint(name, { allowEmpty: true, suppressMessage: true })
			hash =
				typeof result === "object" && result?.commit
					? result.commit
					: result != null
						? String(result)
						: undefined

			// Also create a workspace git commit to capture files written directly to workspace
			try {
				const workspaceDir = task.cwd || getWorkspacePath()
				if (workspaceDir) {
					const simpleGit = (await import("simple-git")).default
					const git = simpleGit(workspaceDir, { binary: "git" })
					await git.add(["-A"])
					const wsResult = await git.commit(`Checkpoint: ${name}`, { "--allow-empty": null })
					if (wsResult.commit) {
						hash = wsResult.commit
					}
				}
			} catch (wsErr: unknown) {
				const provider = task.providerRef.deref()
				provider?.log?.(
					`[saveCheckpointTool] Workspace commit failed (non-fatal): ${wsErr instanceof Error ? wsErr.message : wsErr}`,
				)
			}
		}

		if (!hash) {
			pushToolResult(formatResponse.toolError("Checkpoint save produced no commit. Working tree may be clean."))
			return
		}

		// Cache name→hash so rollback can find it
		registerCheckpointName(task, name, hash)

		// Record in quality gate state for regression tracking
		if (verdict.action === "save") {
			recordCheckpointSaved(task, name, hash, verdict.score)
		}

		// Inform the provider so it can update UI
		const provider = task.providerRef.deref()
		provider?.postMessageToWebview?.({ type: "currentCheckpointUpdated", text: hash })

		pushToolResult(
			`Checkpoint "${name}" created successfully.\n` +
				`Commit hash: ${hash}\n` +
				`Use this hash with rollback_to_checkpoint to restore this state. For Stage 2 rollback drill, pass commit_hash="${hash}" or checkpoint_name="${name}".`,
		)
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error)
		pushToolResult(formatResponse.toolError(`Failed to save checkpoint: ${msg}`))
	}
}
