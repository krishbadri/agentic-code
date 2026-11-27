import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import { TelemetryService } from "@roo-code/telemetry"
import { ControlPlaneCheckpointService } from "../../services/checkpoints/ControlPlaneCheckpointService"

import { Task } from "../task/Task"

import { getWorkspacePath } from "../../utils/path"
import { checkGitInstalled } from "../../utils/git"
import { t } from "../../i18n"

import { DIFF_VIEW_URI_SCHEME } from "../../integrations/editor/DiffViewProvider"

import { CheckpointServiceOptions, RepoPerTaskCheckpointService } from "../../services/checkpoints"
import type { CheckpointResult } from "../../services/checkpoints/types"
import { getCpPort } from "../control-plane/client"

export async function getCheckpointService(
	task: Task,
	{ interval = 250, timeout = 15_000 }: { interval?: number; timeout?: number } = {},
) {
	if (!task.enableCheckpoints) {
		return undefined
	}

	if (task.checkpointService) {
		return task.checkpointService
	}

	const provider = task.providerRef.deref()

	const log = (message: string) => {
		console.log(message)

		try {
			provider?.log(message)
		} catch (err) {
			// NO-OP
		}
	}

	console.log("[Task#getCheckpointService] initializing checkpoints service")

	try {
		const workspaceDir = task.cwd || getWorkspacePath()

		if (!workspaceDir) {
			log("[Task#getCheckpointService] workspace folder not found, disabling checkpoints")
			task.enableCheckpoints = false
			return undefined
		}

		const globalStorageDir = provider?.context.globalStorageUri.fsPath

		if (!globalStorageDir) {
			log("[Task#getCheckpointService] globalStorageDir not found, disabling checkpoints")
			task.enableCheckpoints = false
			return undefined
		}

		// A task that owns (or belongs to) a Control-Plane transaction checkpoints
		// through the CP, in its own worktree (sub-tx composite id for planner
		// children). It never silently switches to shadow git.
		const txId = task.worktreeTxId
		if (txId) {
			const cpPort = getCpPort(provider?.context)
			if (!cpPort) {
				log(`[Task#getCheckpointService] Transaction ${txId} is open but the Control-Plane port is unknown`)
				return undefined
			}
			log(`[Task#getCheckpointService] Using Control-Plane checkpoint service (port ${cpPort}, tx ${txId})`)
			const cpService = new ControlPlaneCheckpointService(cpPort, txId, log)
			cpService.on("checkpoint", ({ toHash, suppressMessage }: { toHash: string; suppressMessage?: boolean }) => {
				;(provider as any)?.postMessageToWebview({
					type: "currentCheckpointUpdated",
					text: toHash,
					suppressMessage: !!suppressMessage,
				})
				task.say(
					"checkpoint_saved",
					toHash,
					undefined,
					undefined,
					{ from: "", to: toHash, suppressMessage: !!suppressMessage },
					undefined,
					{ isNonInteractive: true },
				).catch(() => {})
			})
			task.checkpointService = cpService as any
			return cpService as any
		}

		// Fallback: use local RepoPerTaskCheckpointService
		const options: CheckpointServiceOptions = {
			taskId: task.taskId,
			workspaceDir,
			shadowDir: globalStorageDir,
			log,
		}

		if (task.checkpointServiceInitializing) {
			await pWaitFor(
				() => {
					console.log("[Task#getCheckpointService] waiting for service to initialize")
					return !!task.checkpointService && !!task?.checkpointService?.isInitialized
				},
				{ interval, timeout },
			)
			if (!task?.checkpointService) {
				task.enableCheckpoints = false
				return undefined
			}
			return task.checkpointService
		}

		if (!task.enableCheckpoints) {
			return undefined
		}

		const service = RepoPerTaskCheckpointService.create(options)
		task.checkpointServiceInitializing = true
		await checkGitInstallation(task, service, log, provider)

		// checkGitInstallation may have disabled checkpoints (e.g. initShadowGit failed)
		if (!task.enableCheckpoints) {
			task.checkpointServiceInitializing = false
			return undefined
		}

		task.checkpointService = service
		return service
	} catch (err) {
		log(`[Task#getCheckpointService] ${err.message}`)
		task.enableCheckpoints = false
		task.checkpointServiceInitializing = false
		return undefined
	}
}

export async function checkpointSaveManual(task: Task, suppressMessage = false): Promise<CheckpointSaveResult> {
	const service = await getCheckpointService(task)
	if (!service) {
		if (task.worktreeTxId) {
			throw new Error(`Control-Plane checkpoint unavailable for transaction ${task.worktreeTxId}`)
		}
		return {}
	}
	const result = (await service.saveCheckpoint(`Manual checkpoint at ${new Date().toISOString()}`, {
		allowEmpty: true,
		suppressMessage,
	})) as (CheckpointResult & { progressViolation?: ProgressViolation }) | undefined
	return { hash: result?.commit || undefined, progressViolation: result?.progressViolation }
}

/** True when `dir` is a Control-Plane transaction worktree (never the user's workspace). */
export function isControlPlaneWorktree(dir: string | undefined): boolean {
	if (!dir) return false
	return /[\\/]\.cp[\\/]worktrees[\\/]/.test(dir.replace(/[\\/]+$/, "") + "/")
}

/**
 * Rollback to checkpoint - Restores SystemState only, preserves AgentState
 *
 * Rollback affects ONLY SystemState (repo/files); AgentState (chat history, tool calls, API history)
 * is preserved for debugging, replay, and informed retries.
 *
 * One path: the task's checkpoint service restores the checkpoint (for a
 * transaction this is exactly one CP `/rollback` call on the task's worktree).
 * A direct `git reset --hard` is only allowed inside a CP worktree — never in
 * the user's workspace. Throws on failure.
 */
export async function rollbackToCheckpointManual(task: Task, commitHash: string) {
	if (!commitHash) throw new Error("commit hash required")

	const provider = task.providerRef.deref()
	const service = await getCheckpointService(task)

	if (service && typeof service.restoreCheckpoint === "function") {
		try {
			await service.restoreCheckpoint(commitHash)
		} catch (e: any) {
			throw new Error(`Failed to rollback to ${commitHash}: ${e?.message || e}`)
		}
		provider?.log?.(`[Rollback] Restored SystemState to ${commitHash} (AgentState preserved)`)
		provider?.postMessageToWebview({ type: "currentCheckpointUpdated", text: commitHash })
		return
	}

	// No checkpoint service. Only a CP worktree may be reset directly.
	const dir = task.cwd
	if (!isControlPlaneWorktree(dir)) {
		throw new Error(
			"Failed to rollback: no checkpoint service is available, and a direct git reset is only allowed " +
				"inside a Control-Plane worktree (refusing to reset the workspace)",
		)
	}

	const simpleGit = (await import("simple-git")).default
	const git = simpleGit(dir, { binary: "git" })
	try {
		await git.revparse([commitHash])
		await git.reset(["--hard", commitHash])
		await git.clean("f", ["-d"])
		provider?.log?.(`[DirectGitRollback] Reset worktree ${dir} to ${commitHash} (AgentState preserved)`)
		provider?.postMessageToWebview({ type: "currentCheckpointUpdated", text: commitHash })
	} catch (e: any) {
		throw new Error(`Failed to rollback: ${e?.message || e}`)
	}
}

async function checkGitInstallation(
	task: Task,
	service: RepoPerTaskCheckpointService,
	log: (message: string) => void,
	provider: any,
) {
	try {
		const gitInstalled = await checkGitInstalled()

		if (!gitInstalled) {
			log("[Task#getCheckpointService] Git is not installed, disabling checkpoints")
			task.enableCheckpoints = false
			task.checkpointServiceInitializing = false

			// Show user-friendly notification
			const selection = await vscode.window.showWarningMessage(
				t("common:errors.git_not_installed"),
				t("common:buttons.learn_more"),
			)

			if (selection === t("common:buttons.learn_more")) {
				await vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/downloads"))
			}

			return
		}

		// Git is installed, proceed with initialization
		service.on("initialize", () => {
			log("[Task#getCheckpointService] service initialized")
			task.checkpointServiceInitializing = false
		})

		service.on("checkpoint", ({ fromHash: from, toHash: to, suppressMessage }) => {
			try {
				// Always update the current checkpoint hash in the webview, including the suppress flag
				provider?.postMessageToWebview({
					type: "currentCheckpointUpdated",
					text: to,
					suppressMessage: !!suppressMessage,
				})

				// Always create the chat message but include the suppress flag in the payload
				// so the chatview can choose not to render it while keeping it in history.
				task.say(
					"checkpoint_saved",
					to,
					undefined,
					undefined,
					{ from, to, suppressMessage: !!suppressMessage },
					undefined,
					{ isNonInteractive: true },
				).catch((err) => {
					log("[Task#getCheckpointService] caught unexpected error in say('checkpoint_saved')")
					console.error(err)
				})
			} catch (err) {
				log("[Task#getCheckpointService] caught unexpected error in on('checkpoint'), disabling checkpoints")
				console.error(err)
				task.enableCheckpoints = false
			}
		})

		log("[Task#getCheckpointService] initializing shadow git")

		try {
			await service.initShadowGit()
		} catch (err) {
			log(`[Task#getCheckpointService] initShadowGit -> ${err.message}`)
			task.enableCheckpoints = false
		}
	} catch (err) {
		log(`[Task#getCheckpointService] Unexpected error during Git check: ${err.message}`)
		console.error("Git check error:", err)
		task.enableCheckpoints = false
		task.checkpointServiceInitializing = false
	}
}

export interface ProgressViolation {
	kind?: "tests" | "compile" | string
	rollbackTo?: string
	currentCount?: number
	lastCount?: number
	message: string
}

export interface CheckpointSaveResult {
	hash?: string
	/** Set when the Control-Plane progress gate rejected the checkpoint and rolled back. */
	progressViolation?: ProgressViolation
}

export async function checkpointSave(
	task: Task,
	force = false,
	suppressMessage = false,
): Promise<CheckpointSaveResult> {
	const service = await getCheckpointService(task)

	if (!service) {
		return {}
	}

	TelemetryService.instance.captureCheckpointCreated(task.taskId)

	const message = `Task: ${task.taskId}, Time: ${Date.now()}`
	try {
		const result = (await service.saveCheckpoint(message, { allowEmpty: force, suppressMessage })) as
			| (CheckpointResult & { progressViolation?: ProgressViolation })
			| undefined
		return { hash: result?.commit || undefined, progressViolation: result?.progressViolation }
	} catch (err: any) {
		// A task that owns a transaction never clears roo.cpPort or silently switches
		// to shadow git; the failure is logged and the caller continues without a hash.
		const provider = task.providerRef.deref()
		provider?.log(
			`[Checkpoint] Save failed${task.worktreeTxId ? ` (tx ${task.worktreeTxId})` : ""}: ${err?.message || err}`,
		)
		return {}
	}
}

export type CheckpointRestoreOptions = {
	ts: number
	commitHash: string
	mode: "preview" | "restore" // Kept for API compatibility, no longer affects behavior
	operation?: "delete" | "edit" // Kept for API compatibility, no longer affects behavior
}

/**
 * Restore checkpoint - Restores SystemState only, preserves AgentState
 *
 * Rollback affects ONLY SystemState (repo/files); AgentState (chat history, tool calls, API history)
 * is preserved for debugging, replay, and informed retries.
 *
 * This separation is critical - we treat rollback as a system-state operation;
 * agent state is preserved to support replay, debugging, and informed retries.
 */
export async function checkpointRestore(
	task: Task,
	{ ts, commitHash, mode, operation = "delete" }: CheckpointRestoreOptions,
) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	const index = task.clineMessages.findIndex((m) => m.ts === ts)

	if (index === -1) {
		return
	}

	const provider = task.providerRef.deref()

	try {
		// Restore SystemState (repo) only; AgentState is preserved
		await service.restoreCheckpoint(commitHash)
		TelemetryService.instance.captureCheckpointRestored(task.taskId)
		await provider?.postMessageToWebview({ type: "currentCheckpointUpdated", text: commitHash })

		// NOTE: AgentState (chat history, API history) is NOT deleted during rollback.
		// This preserves the agent's trajectory for debugging, replay, and informed retries.
		// The previous behavior of deleting messages when mode === "restore" has been removed
		// to align with the SystemState/AgentState separation principle.

		// The task is already cancelled by the provider beforehand, but we
		// need to re-init to get the updated messages.
		//
		// This was taken from Cline's implementation of the checkpoints
		// feature. The task instance will hang if we don't cancel twice,
		// so this is currently necessary, but it seems like a complicated
		// and hacky solution to a problem that I don't fully understand.
		// I'd like to revisit this in the future and try to improve the
		// task flow and the communication between the webview and the
		// `Task` instance.
		provider?.cancelTask()
	} catch (err) {
		provider?.log("[checkpointRestore] disabling checkpoints for this task")
		task.enableCheckpoints = false
	}
}

export type CheckpointDiffOptions = {
	ts: number
	previousCommitHash?: string
	commitHash: string
	mode: "full" | "checkpoint"
}

export async function checkpointDiff(task: Task, { ts, previousCommitHash, commitHash, mode }: CheckpointDiffOptions) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	TelemetryService.instance.captureCheckpointDiffed(task.taskId)

	let prevHash = commitHash
	let nextHash: string | undefined = undefined

	if (mode !== "full") {
		const checkpoints = task.clineMessages.filter(({ say }) => say === "checkpoint_saved").map(({ text }) => text!)
		const idx = checkpoints.indexOf(commitHash)
		if (idx !== -1 && idx < checkpoints.length - 1) {
			nextHash = checkpoints[idx + 1]
		} else {
			nextHash = undefined
		}
	}

	try {
		const changes = await service.getDiff({ from: prevHash, to: nextHash })

		if (!changes?.length) {
			vscode.window.showInformationMessage("No changes found.")
			return
		}

		await vscode.commands.executeCommand(
			"vscode.changes",
			mode === "full" ? "Changes since task started" : "Changes compare with next checkpoint",
			changes.map((change: import("../../services/checkpoints/types").CheckpointDiff) => [
				vscode.Uri.file(change.paths.absolute),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.before ?? "").toString("base64"),
				}),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.after ?? "").toString("base64"),
				}),
			]),
		)
	} catch (err) {
		const provider = task.providerRef.deref()
		provider?.log("[checkpointDiff] disabling checkpoints for this task")
		task.enableCheckpoints = false
	}
}
