import * as vscode from "vscode"
import delay from "delay"

import type { CommandId } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Package } from "../shared/package"
import { getCommand } from "../utils/commands"
import { ClineProvider } from "../core/webview/ClineProvider"
import { ContextProxy } from "../core/config/ContextProxy"
import { focusPanel } from "../utils/focusPanel"

import { registerHumanRelayCallback, unregisterHumanRelayCallback, handleHumanRelayResponse } from "./humanRelay"
import { handleNewTask } from "./handleTask"
import { CodeIndexManager } from "../services/code-index/manager"
import { importSettingsWithFeedback } from "../core/config/importExport"
import { MdmService } from "../services/mdm/MdmService"
import { t } from "../i18n"
import { checkpointSaveManual } from "../core/checkpoints"
import { rollbackToCheckpointManual } from "../core/checkpoints"

/**
 * Helper to get the visible ClineProvider instance or log if not found.
 */
export function getVisibleProviderOrLog(outputChannel: vscode.OutputChannel): ClineProvider | undefined {
	const visibleProvider = ClineProvider.getVisibleInstance()
	if (!visibleProvider) {
		outputChannel.appendLine("Cannot find any visible Roo Code instances.")
		return undefined
	}
	return visibleProvider
}

// Store panel references in both modes
let sidebarPanel: vscode.WebviewView | undefined = undefined
let tabPanel: vscode.WebviewPanel | undefined = undefined

/**
 * Get the currently active panel
 * @returns WebviewPanel或WebviewView
 */
export function getPanel(): vscode.WebviewPanel | vscode.WebviewView | undefined {
	return tabPanel || sidebarPanel
}

/**
 * Set panel references
 */
export function setPanel(
	newPanel: vscode.WebviewPanel | vscode.WebviewView | undefined,
	type: "sidebar" | "tab",
): void {
	if (type === "sidebar") {
		sidebarPanel = newPanel as vscode.WebviewView
		tabPanel = undefined
	} else {
		tabPanel = newPanel as vscode.WebviewPanel
		sidebarPanel = undefined
	}
}

export type RegisterCommandOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	provider: ClineProvider
}

export const registerCommands = async (options: RegisterCommandOptions) => {
	const { context, outputChannel } = options
	const existing = new Set(await vscode.commands.getCommands(true))
	for (const [id, callback] of Object.entries(getCommandsMap(options))) {
		const command = getCommand(id as CommandId)
		if (existing.has(command)) {
			outputChannel.appendLine(`[registerCommands] ${command} already exists, skipping`)
			continue
		}
		outputChannel.appendLine(`[registerCommands] registering ${command}`)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}
}

// ------------------ New: Split registration into core/UI groups ------------------

const CORE_COMMAND_IDS: CommandId[] = ["saveCheckpoint", "rollbackCheckpoint", "startControlPlaneHere"]

const isCoreId = (id: CommandId) => CORE_COMMAND_IDS.includes(id)

export const getCoreCommands = (options: RegisterCommandOptions): Partial<Record<CommandId, any>> => {
	const all = getCommandsMap(options)
	const core: Partial<Record<CommandId, any>> = {}
	for (const [id, cb] of Object.entries(all) as [CommandId, any][]) {
		if (isCoreId(id)) core[id] = cb
	}
	return core
}

export const getUiCommands = (options: RegisterCommandOptions): Partial<Record<CommandId, any>> => {
	const all = getCommandsMap(options)
	const ui: Partial<Record<CommandId, any>> = {}
	for (const [id, cb] of Object.entries(all) as [CommandId, any][]) {
		if (!isCoreId(id)) ui[id] = cb
	}
	return ui
}

export const registerCommandMap = async (
	options: RegisterCommandOptions,
	factory: (o: RegisterCommandOptions) => Partial<Record<CommandId, any>>,
) => {
	const { context, outputChannel } = options
	const existing = new Set(await vscode.commands.getCommands(true))
	const map = factory(options)
	for (const [id, callback] of Object.entries(map)) {
		const command = getCommand(id as CommandId)
		if (existing.has(command)) {
			outputChannel.appendLine(`[register] ${command} already exists, skipping`)
			continue
		}
		outputChannel.appendLine(`[register] ${command}`)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}
}

const getCommandsMap = ({ context, outputChannel, provider }: RegisterCommandOptions): Record<CommandId, any> => ({
	activationCompleted: () => {},
	cloudButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("cloud")

		visibleProvider.postMessageToWebview({ type: "action", action: "cloudButtonClicked" })
	},
	plusButtonClicked: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("plus")

		await visibleProvider.removeClineFromStack()
		await visibleProvider.refreshWorkspace()
		await visibleProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		// Send focusInput action immediately after chatButtonClicked
		// This ensures the focus happens after the view has switched
		await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
	},
	mcpButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("mcp")

		visibleProvider.postMessageToWebview({ type: "action", action: "mcpButtonClicked" })
	},
	promptsButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("prompts")

		visibleProvider.postMessageToWebview({ type: "action", action: "promptsButtonClicked" })
	},
	popoutButtonClicked: () => {
		TelemetryService.instance.captureTitleButtonClicked("popout")

		return openClineInNewTab({ context, outputChannel })
	},
	openInNewTab: () => openClineInNewTab({ context, outputChannel }),
	settingsButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("settings")

		visibleProvider.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
		// Also explicitly post the visibility message to trigger scroll reliably
		visibleProvider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
	},
	historyButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("history")

		visibleProvider.postMessageToWebview({ type: "action", action: "historyButtonClicked" })
	},
	// New: manual checkpoint command (fallbacks handled in provider side)
	saveCheckpoint: async () => {
		try {
			const task = ClineProvider.getVisibleInstance()?.getCurrentTask()
			if (!task) {
				vscode.window.showWarningMessage("No active task to checkpoint")
				return
			}
			const { checkpointSaveManual } = await import("../core/checkpoints/index")
			await checkpointSaveManual(task)
			vscode.window.showInformationMessage("Checkpoint saved")
		} catch (err) {
			outputChannel.appendLine(`[SaveCheckpoint] failed: ${err}`)
			vscode.window.showErrorMessage(`Failed to save checkpoint: ${err}`)
		}
	},
	marketplaceButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) return
		visibleProvider.postMessageToWebview({ type: "action", action: "marketplaceButtonClicked" })
	},
	// Expose start control-plane here from command palette
	startControlPlaneHere: async () => {
		await vscode.commands.executeCommand("roo.startControlPlaneHere")
	},

	rollbackCheckpoint: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) return
		const task = visibleProvider.getCurrentTask()
		if (!task) {
			vscode.window.showErrorMessage("No active task to rollback")
			return
		}
		// Show the user a quick-pick list of recent checkpoint commits instead of asking for a raw hash.
		try {
			const simpleGit = (await import("simple-git")).default
			const workspaceDir = task.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

			if (!workspaceDir) {
				vscode.window.showErrorMessage("Workspace folder not found – cannot enumerate checkpoints.")
				return
			}

			const provider = task.providerRef.deref()
			const globalStorageDir = provider?.context?.globalStorageUri?.fsPath
			const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")
			const txId = provider?.context?.globalState.get<string>("roo.current_tx_id")
			const cfg = vscode.workspace.getConfiguration()
			const txMode =
				cfg.get<boolean>("roo.experimental.transactionalMode") ||
				cfg.get<boolean>("roo-cline.experimental.transactionalMode")

			// Determine which Git repo to query: transaction branch, shadow repo, or workspace repo
			let gitRepoDir: string | undefined
			let logOptions: { maxCount: number; from?: string } = { maxCount: 50 }

			if (txMode && cpPort && txId) {
				// Try transaction branch in workspace repo
				const workspaceGit = simpleGit(workspaceDir, { binary: "git" })
				try {
					await workspaceGit.raw(["rev-parse", "--verify", `tx/${txId}`])
					gitRepoDir = workspaceDir
					logOptions.from = `tx/${txId}`
				} catch {
					// Transaction branch doesn't exist, fall through to shadow repo
				}
			}

			// If no transaction branch, check shadow repo (where local Git checkpoints are stored)
			if (!gitRepoDir && globalStorageDir) {
				const path = (await import("path")).default
				const shadowRepoDir = path.join(globalStorageDir, "tasks", task.taskId, "checkpoints")
				try {
					const shadowGit = simpleGit(shadowRepoDir, { binary: "git" })
					await shadowGit.raw(["rev-parse", "--verify", "HEAD"])
					gitRepoDir = shadowRepoDir
				} catch {
					// Shadow repo doesn't exist or isn't initialized
				}
			}

			// Fallback to workspace repo
			if (!gitRepoDir) {
				gitRepoDir = workspaceDir
			}

			const git = simpleGit(gitRepoDir, { binary: "git" })
			const log = await git.log(logOptions)

			if (!log.all.length) {
				vscode.window.showWarningMessage("No commits found to rollback.")
				return
			}

			// Filter to ONLY checkpoint commits (manual or automatic)
			const checkpointPattern = /^(Manual checkpoint at|Task:)/i
			const checkpointCommits = log.all.filter((c) => checkpointPattern.test(c.message))

			if (!checkpointCommits.length) {
				vscode.window.showWarningMessage("No checkpoint commits found. Save a checkpoint first.")
				return
			}

			// Sort by date descending (newest first) - log.all should already be sorted, but ensure it
			checkpointCommits.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

			// Build richer Quick-Pick entries: message + time + short diff summary
			const items: vscode.QuickPickItem[] = []
			for (let i = 0; i < checkpointCommits.length; i++) {
				const c = checkpointCommits[i]
				let summary = ""
				try {
					// git diff --shortstat <hash>^!  => " 1 file changed, 2 insertions(+), 1 deletion(-)"
					const raw = await git.raw(["diff", "--shortstat", `${c.hash}^!`])
					summary = raw.trim()
				} catch {
					// ignore
				}

				const when = new Date(c.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				const date = new Date(c.date).toLocaleDateString([], { month: "short", day: "numeric" })
				const isMostRecent = i === 0
				const labelPrefix = isMostRecent ? "⬤ " : "  "
				const labelSuffix = isMostRecent ? " (most recent)" : ""

				// Clean up commit message for display
				let displayMessage = c.message
				if (displayMessage.startsWith("Manual checkpoint at")) {
					displayMessage = "Manual checkpoint"
				} else if (displayMessage.startsWith("Task:")) {
					displayMessage = "Auto checkpoint"
				}

				items.push({
					label: `${labelPrefix}${displayMessage}${labelSuffix}`,
					description: `${date} ${when}  ${summary}`.trim(),
					detail: c.hash,
				})
			}

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: "Top = most recent checkpoint. Select which checkpoint to roll back to:",
				matchOnDescription: true,
			})

			if (!picked) return // user cancelled

			const commitHash = picked.detail || picked.label

			await rollbackToCheckpointManual(task, commitHash)
			vscode.window.showInformationMessage(`Rolled back to ${commitHash.substring(0, 7)}`)
		} catch (err: any) {
			outputChannel.appendLine(`[Rollback] failed: ${err.message || err}`)
			vscode.window.showErrorMessage(`Rollback failed: ${err.message || err}`)
		}
	},

	suggestRollback: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) return
		const task = visibleProvider.getCurrentTask()
		if (!task) return

		const provider = task.providerRef.deref()
		const cpPort = provider?.context?.globalState.get<number>("roo.cpPort")
		const txId = await provider?.context?.globalState.get<string>("roo.current_tx_id")
		const lastError = await provider?.context?.globalState.get<string>("roo.lastError")

		if (!cpPort || !txId) {
			vscode.window.showErrorMessage("Control-Plane not running")
			return
		}

		try {
			const params = new URLSearchParams()
			if (lastError) {
				params.set("context", "error")
				params.set("message", lastError)
			}

			const res = await fetch(`http://127.0.0.1:${cpPort}/tx/${txId}/suggest-rollback?${params}`)
			const data = await res.json()

			if (data.suggested) {
				const choice = await vscode.window.showInformationMessage(
					`Suggested checkpoint: ${data.suggested.message} (${data.suggested.reason})`,
					"Rollback to Suggestion",
					"Cancel",
				)
				if (choice === "Rollback to Suggestion") {
					await rollbackToCheckpointManual(task, data.suggested.hash)
					vscode.window.showInformationMessage(`Rolled back to ${data.suggested.hash.slice(0, 7)}`)
				}
			} else {
				vscode.window.showInformationMessage("No checkpoint suggestions available")
			}
		} catch (err: any) {
			outputChannel.appendLine(`[SuggestRollback] failed: ${err.message || err}`)
			vscode.window.showErrorMessage(`Failed to get suggestion: ${err.message || err}`)
		}
	},
	showHumanRelayDialog: (params: { requestId: string; promptText: string }) => {
		const panel = getPanel()

		if (panel) {
			panel?.webview.postMessage({
				type: "showHumanRelayDialog",
				requestId: params.requestId,
				promptText: params.promptText,
			})
		}
	},
	registerHumanRelayCallback: registerHumanRelayCallback,
	unregisterHumanRelayCallback: unregisterHumanRelayCallback,
	handleHumanRelayResponse: handleHumanRelayResponse,
	newTask: handleNewTask,
	setCustomStoragePath: async () => {
		const { promptForCustomStoragePath } = await import("../utils/storage")
		await promptForCustomStoragePath()
	},
	importSettings: async (filePath?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) {
			return
		}

		await importSettingsWithFeedback(
			{
				providerSettingsManager: visibleProvider.providerSettingsManager,
				contextProxy: visibleProvider.contextProxy,
				customModesManager: visibleProvider.customModesManager,
				provider: visibleProvider,
			},
			filePath,
		)
	},
	focusInput: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)

			// Send focus input message only for sidebar panels
			if (sidebarPanel && getPanel() === sidebarPanel) {
				provider.postMessageToWebview({ type: "action", action: "focusInput" })
			}
		} catch (error) {
			outputChannel.appendLine(`Error focusing input: ${error}`)
		}
	},
	focusPanel: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)
		} catch (error) {
			outputChannel.appendLine(`Error focusing panel: ${error}`)
		}
	},
	acceptInput: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({ type: "acceptInput" })
	},
	toggleAutoApprove: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({
			type: "action",
			action: "toggleAutoApprove",
		})
	},
})

export const openClineInNewTab = async ({ context, outputChannel }: Omit<RegisterCommandOptions, "provider">) => {
	// (This example uses webviewProvider activation event which is necessary to
	// deserialize cached webview, but since we use retainContextWhenHidden, we
	// don't need to use that event).
	// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	const contextProxy = await ContextProxy.getInstance(context)
	const codeIndexManager = CodeIndexManager.getInstance(context)

	// Get the existing MDM service instance to ensure consistent policy enforcement
	let mdmService: MdmService | undefined
	try {
		mdmService = MdmService.getInstance()
	} catch (error) {
		// MDM service not initialized, which is fine - extension can work without it
		mdmService = undefined
	}

	const tabProvider = new ClineProvider(context, outputChannel, "editor", contextProxy, mdmService)
	const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

	// Check if there are any visible text editors, otherwise open a new group
	// to the right.
	const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

	if (!hasVisibleEditors) {
		await vscode.commands.executeCommand("workbench.action.newGroupRight")
	}

	const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

	const newPanel = vscode.window.createWebviewPanel(ClineProvider.tabPanelId, "Roo Code", targetCol, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [context.extensionUri],
	})

	// Save as tab type panel.
	setPanel(newPanel, "tab")

	// TODO: Use better svg icon with light and dark variants (see
	// https://stackoverflow.com/questions/58365687/vscode-extension-iconpath).
	newPanel.iconPath = {
		light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_light.png"),
		dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_dark.png"),
	}

	await tabProvider.resolveWebviewView(newPanel)

	// Add listener for visibility changes to notify webview
	newPanel.onDidChangeViewState(
		(e) => {
			const panel = e.webviewPanel
			if (panel.visible) {
				panel.webview.postMessage({ type: "action", action: "didBecomeVisible" }) // Use the same message type as in SettingsView.tsx
			}
		},
		null, // First null is for `thisArgs`
		context.subscriptions, // Register listener for disposal
	)

	// Handle panel closing events.
	newPanel.onDidDispose(
		() => {
			setPanel(undefined, "tab")
		},
		null,
		context.subscriptions, // Also register dispose listener
	)

	// Lock the editor group so clicking on files doesn't open them over the panel.
	await delay(100)
	await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

	return tabProvider
}
