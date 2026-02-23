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
import { SubTransactionManager } from "./SubTransactionManager"

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

		// CHECK: Is transactional mode enabled?
		const cfg = vscode.workspace.getConfiguration()
		const txMode =
			cfg.get<boolean>("roo.experimental.transactionalMode") ||
			cfg.get<boolean>("roo-cline.experimental.transactionalMode")
		const cpPort = provider?.context.globalState?.get<number>("roo.cpPort")

		// If transactional mode is enabled and Control-Plane is running, use ControlPlaneCheckpointService
		if (txMode && cpPort) {
			try {
				log(`[Task#getCheckpointService] Using Control-Plane checkpoint service (port ${cpPort})`)
				// Use the task's own transactionalTxId (composite sub-tx ID) if set,
				// so checkpoints go to the child's sub-tx worktree, not the parent's.
				const txId = task.transactionalTxId || provider?.context.globalState?.get<string>("roo.current_tx_id")
				if (!txId) {
					log("[Task#getCheckpointService] No transaction ID, creating new one")
					// Will be set later when transaction begins
				}
				const baseUrl = `http://127.0.0.1:${cpPort}`
				const cpService = new ControlPlaneCheckpointService(baseUrl, txId || "pending", log)
				task.checkpointService = cpService as any
				log("[Task#getCheckpointService] Control-Plane service initialized")
				return cpService as any
			} catch (err) {
				log(
					`[Task#getCheckpointService] Failed to initialize Control-Plane service: ${err.message}, falling back to local`,
				)
			}
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

export async function checkpointSaveManual(task: Task, suppressMessage = false) {
	const provider = task.providerRef.deref()
	const attemptSave = async () => {
		const service = await getCheckpointService(task)
		if (!service) return

		// Checkpoint belongs to current sub-transaction (if exists)
		const subTxnId = task.currentSubTransaction?.id
		const message = subTxnId
			? `Manual checkpoint at ${new Date().toISOString()} (sub-transaction: ${subTxnId})`
			: `Manual checkpoint at ${new Date().toISOString()}`

		await service.saveCheckpoint(message, {
			allowEmpty: true,
			suppressMessage,
		})
	}

	try {
		await attemptSave()
	} catch (error: any) {
		const message = error?.message || String(error)
		const errorCode = error?.code || error?.cause?.code || ""
		const isControlPlaneFailure =
			message.includes("spawn git ENOENT") ||
			message.includes('"code":"DENIED"') ||
			message.includes("fetch failed") ||
			errorCode === "ECONNREFUSED" ||
			errorCode === "ENOTFOUND"

		if (isControlPlaneFailure) {
			provider?.log?.(`[Checkpoint] Control-Plane checkpoint failed (${message}); falling back to local Git.`)

			try {
				await provider?.context?.globalState.update("roo.cpPort", undefined)
			} catch {}

			task.checkpointService = undefined
			task.checkpointServiceInitializing = false

			try {
				await attemptSave()
				return
			} catch (fallbackError) {
				console.error("[checkpointSaveManual] fallback failed", fallbackError)
				throw fallbackError
			}
		}

		console.error("[checkpointSaveManual]", error)
		throw error
	}
}

/**
 * Verify rollback succeeded by checking expected state
 * @param task The Task instance
 * @param commitHash The commit hash we rolled back to
 */
async function verifyRollbackState(task: Task, commitHash: string): Promise<void> {
	const workspaceDir = task.cwd || getWorkspacePath()
	if (!workspaceDir) {
		throw new Error("Workspace directory not found for verification")
	}

	const simpleGit = (await import("simple-git")).default
	const git = simpleGit(workspaceDir, { binary: "git" })
	const fs = await import("fs/promises")
	const path = await import("path")

	// Verify 1: HEAD is at the correct commit
	const currentHead = await git.revparse(["HEAD"])
	if (!currentHead.startsWith(commitHash.substring(0, 7))) {
		throw new Error(
			`Rollback verification failed: HEAD is ${currentHead.substring(0, 7)} but expected ${commitHash.substring(0, 7)}`,
		)
	}

	// Verify 2: ROLLBACK_SENTINEL.txt check (only relevant for torture test)
	if (process.env.TEST_TORTURE_REPO === "1") {
		const sentinelPath = path.join(workspaceDir, "ROLLBACK_SENTINEL.txt")
		try {
			await fs.access(sentinelPath)
			throw new Error(
				`Rollback verification failed: ROLLBACK_SENTINEL.txt still exists after rollback. ` +
					`This indicates the rollback did not restore the checkpoint state correctly.`,
			)
		} catch (e: any) {
			if (e.code !== "ENOENT") {
				// File exists but we got a different error - this is bad
				throw e
			}
			// ENOENT means file doesn't exist - this is what we want
		}
	}

	// Verify 3: No uncommitted changes (should be clean after rollback)
	const status = await git.status()
	if (status.files.length > 0) {
		const provider = task.providerRef.deref()
		provider?.log?.(
			`[RollbackVerification] Warning: ${status.files.length} uncommitted changes after rollback: ${status.files.map((f) => f.path).join(", ")}`,
		)
		// Don't throw - some uncommitted changes might be expected in certain scenarios
	}

	const provider = task.providerRef.deref()
	provider?.log?.(
		`[RollbackVerification] ✓ HEAD at ${currentHead.substring(0, 7)}, ` +
			`✓ ROLLBACK_SENTINEL.txt removed, ` +
			`✓ Working tree status: ${status.files.length} files`,
	)
}

/**
 * Rollback to checkpoint - Restores SystemState only, preserves AgentState
 *
 * Rollback affects ONLY SystemState (repo/files); AgentState (chat history, tool calls, API history)
 * is preserved for debugging, replay, and informed retries.
 *
 * This separation is critical - we treat rollback as a system-state operation;
 * agent state is preserved to support replay, debugging, and informed retries.
 */
export async function rollbackToCheckpointManual(task: Task, commitHash: string) {
	if (!commitHash) throw new Error("commit hash required")

	// Get context from provider, not task (task.context might be undefined)
	const provider = task.providerRef.deref()
	if (!provider || !provider.context) {
		throw new Error("Provider context not available")
	}

	const cpPort = provider.context.globalState.get<number>("roo.cpPort")
	const txId = provider.context.globalState.get<string>("roo.current_tx_id")

	// Try Control-Plane rollback if available
	// CP rollback resets the WORKTREE only — workspace still needs syncing via Path 3.
	// So we use CP rollback as a "best effort" for worktree consistency but always
	// continue to Path 3 to sync the workspace when CP is active.
	if (cpPort && txId) {
		try {
			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${txId}/rollback`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Actor-Id": "human" },
				body: JSON.stringify({ hash: commitHash }),
				signal: AbortSignal.timeout(15_000),
			})
			if (!res.ok) {
				const errorText = await res.text()
				throw new Error(errorText || `HTTP ${res.status}`)
			}
			provider?.log?.(
				`[ControlPlaneRollback] Rolled back CP worktree to ${commitHash}. Will sync workspace via direct git.`,
			)
			// Don't return — fall through to Path 3 to sync workspace files.
			// CP only resets the worktree; the workspace repo still needs git reset --hard.
		} catch (e: any) {
			provider?.log?.(`[ControlPlaneRollback] failed: ${e.message || e}. Continuing to fallback paths.`)
		}
	}

	// Fallback: use checkpoint service's restore method (handles shadow repos correctly)
	// This restores SystemState (repo) only; AgentState is preserved
	try {
		const service = await getCheckpointService(task)
		if (service && typeof service.restoreCheckpoint === "function") {
			await service.restoreCheckpoint(commitHash)
			provider?.log?.(
				`[CheckpointServiceRollback] Successfully rolled back SystemState to ${commitHash} (AgentState preserved)`,
			)
			provider?.postMessageToWebview({
				type: "currentCheckpointUpdated",
				text: commitHash,
			})

			// For ControlPlaneCheckpointService, restoreCheckpoint only resets the CP
			// worktree — the workspace still needs to be synced. Fall through to
			// Path 3 (direct git reset on workspace) which handles that because
			// CP worktrees share the object database with the workspace repo.
			const isCpService = service instanceof ControlPlaneCheckpointService
			if (isCpService) {
				provider?.log?.(`[CheckpointServiceRollback] CP worktree restored. Falling through to sync workspace.`)
			} else {
				// Shadow/local service: restoreCheckpoint already restored workspace
				// files directly (shadow repo has core.worktree = workspace).
				// Do NOT verify workspace git HEAD — the checkpoint hash exists in
				// the shadow repo's git, not the workspace's own .git, so HEAD
				// will never match. The files ARE correct.
				provider?.log?.(`[CheckpointServiceRollback] Shadow service restored workspace files successfully.`)
				return
			}
		}
	} catch (e: any) {
		provider?.log?.(`[CheckpointServiceRollback] failed: ${e.message || e}, trying direct git`)
	}

	// Last resort: direct Git operations (for workspace repo only)
	// This restores SystemState (repo) only; AgentState is preserved
	const workspaceDir = task.cwd || getWorkspacePath()
	if (!workspaceDir) {
		throw new Error("Workspace directory not found")
	}

	const simpleGit = (await import("simple-git")).default
	const git = simpleGit(workspaceDir, { binary: "git" })

	try {
		await git.revparse([commitHash])
		await git.clean("f", ["-d", "-f"])
		await git.reset(["--hard", commitHash])
		provider?.log?.(
			`[DirectGitRollback] Successfully rolled back SystemState to ${commitHash} (AgentState preserved)`,
		)
		provider?.postMessageToWebview({
			type: "currentCheckpointUpdated",
			text: commitHash,
		})

		// Verify rollback succeeded
		await verifyRollbackState(task, commitHash)
	} catch (e: any) {
		throw new Error(`Failed to rollback: ${e.message || e}`)
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

export async function checkpointSave(task: Task, force = false, suppressMessage = false) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	TelemetryService.instance.captureCheckpointCreated(task.taskId)

	// Checkpoint belongs to current sub-transaction (if exists)
	const subTxnId = task.currentSubTransaction?.id
	const message = subTxnId
		? `Task: ${task.taskId}, Time: ${Date.now()} (sub-transaction: ${subTxnId})`
		: `Task: ${task.taskId}, Time: ${Date.now()}`

	const attemptSave = async () => {
		const svc = await getCheckpointService(task)
		if (!svc) return
		await svc.saveCheckpoint(message, { allowEmpty: force, suppressMessage })
	}

	// Start the checkpoint process in the background with CP fallback.
	try {
		await attemptSave()
	} catch (err: any) {
		const errMsg = err?.message || String(err)
		const errorCode = err?.code || err?.cause?.code || ""
		const isControlPlaneFailure =
			errMsg.includes("spawn git ENOENT") ||
			errMsg.includes('"code":"DENIED"') ||
			errMsg.includes("fetch failed") ||
			errorCode === "ECONNREFUSED" ||
			errorCode === "ENOTFOUND"

		if (isControlPlaneFailure) {
			// Control-Plane failed (git not on CP's PATH, etc.) - fall back to local Git.
			// Do NOT disable enableCheckpoints - the tools should remain available.
			console.warn("[Task#checkpointSave] Control-Plane failed, falling back to local Git:", errMsg)
			try {
				const provider = task.providerRef.deref()
				await provider?.context?.globalState.update("roo.cpPort", undefined)
			} catch {}
			task.checkpointService = undefined
			task.checkpointServiceInitializing = false
			try {
				await attemptSave()
				return
			} catch (fallbackErr) {
				// Local git fallback also failed - log but DON'T disable checkpoint tools.
				// The save_checkpoint / rollback_to_checkpoint tools can still be invoked explicitly.
				console.error("[Task#checkpointSave] fallback also failed:", fallbackErr)
			}
		} else {
			// Non-CP error - log but don't disable tools for transient errors
			console.error("[Task#checkpointSave] caught unexpected error:", err)
			const provider = task.providerRef.deref()
			provider?.log(`[Checkpoint] Save failed: ${err?.message || err}. Continuing without checkpoint.`)
		}
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

/**
 * Commit the current sub-transaction
 *
 * Runs safety checks, sets endCheckpoint, and marks as committed.
 * This corresponds to commit point C_i in the transaction model.
 *
 * After commit, a new sub-transaction can be created for subsequent work.
 */
export async function commitSubTransaction(task: Task): Promise<void> {
	const manager = new SubTransactionManager(task)
	const currentSubTxn = manager.getCurrentSubTransaction()

	if (!currentSubTxn) {
		throw new Error("No active sub-transaction to commit")
	}

	await manager.commitSubTransaction(currentSubTxn)
}

/**
 * Abort the current sub-transaction
 *
 * Rolls back to baseCheckpoint and marks as aborted.
 * This corresponds to rolling back to C_{i-1} on failure.
 *
 * SystemState is restored to baseCheckpoint; AgentState is preserved.
 * After abort, a new sub-transaction can be created for subsequent work.
 */
export async function abortSubTransaction(task: Task): Promise<void> {
	const manager = new SubTransactionManager(task)
	const currentSubTxn = manager.getCurrentSubTransaction()

	if (!currentSubTxn) {
		throw new Error("No active sub-transaction to abort")
	}

	await manager.abortSubTransaction(currentSubTxn)
}
