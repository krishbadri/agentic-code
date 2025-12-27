import * as vscode from "vscode"
// Early patch BEFORE any other imports register chat participants
const chatApiEarly: any = (vscode as any).chat
if (chatApiEarly && typeof chatApiEarly.registerChatParticipant === "function") {
	const origRegister = chatApiEarly.registerChatParticipant
	chatApiEarly.registerChatParticipant = function (id: string, participant: any) {
		if (!id || typeof id !== "string" || !/^[\w-]+$/.test(id)) {
			console.warn("[chatGuard early] skipped invalid participant id:", id)
			return { dispose() {} }
		}
		return origRegister.call(this, id, participant)
	}
}
// End early guard
import * as dotenvx from "@dotenvx/dotenvx"
import * as path from "path"
import * as fs from "fs/promises"
import { spawn } from "child_process"
import * as readline from "readline"
import { setGlobalChannel } from "./shared/globalChannel"

async function nukeOldWebviewCache() {
	try {
		const appData = process.env.APPDATA || ""
		const cacheRoot = path.join(appData, "Code", "Cache")
		const entries = await fs.readdir(cacheRoot, { withFileTypes: true })
		for (const e of entries) {
			if (e.isDirectory() && e.name.includes("rooveterinaryinc.roo-cline")) {
				await fs.rm(path.join(cacheRoot, e.name), { recursive: true, force: true })
			}
		}
	} catch {}
}

// Load environment variables from .env file
try {
	// Specify path to .env file in the project root directory
	const envPath = path.join(__dirname, "..", ".env")
	dotenvx.config({ path: envPath })
} catch (e) {
	// Silently handle environment loading errors
	console.warn("Failed to load environment variables:", e)
}

import type { CloudUserInfo, AuthState } from "@agentic-code/types"
import { CloudService, BridgeOrchestrator } from "@agentic-code/cloud"
import { TelemetryService, PostHogTelemetryClient } from "@agentic-code/telemetry"

import "./utils/path" // Necessary to have access to String.prototype.toPosix.
import { createOutputChannelLogger, createDualLogger } from "./utils/outputChannelLogger"

import { Package } from "./shared/package"
import { formatLanguage } from "./shared/language"
import { ContextProxy } from "./core/config/ContextProxy"
import { ClineProvider } from "./core/webview/ClineProvider"
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/DiffViewProvider"
import { TerminalRegistry } from "./integrations/terminal/TerminalRegistry"
import { McpServerManager } from "./services/mcp/McpServerManager"
import { CodeIndexManager } from "./services/code-index/manager"
import { MdmService } from "./services/mdm/MdmService"
import { migrateSettings } from "./utils/migrateSettings"
import { autoImportSettings } from "./utils/autoImportSettings"
import { API } from "./extension/api"
import { safeWriteJson } from "./utils/safeWriteJson"

import {
	handleUri,
	registerCommandMap,
	getCoreCommands,
	getUiCommands,
	registerCodeActions,
	registerTerminalActions,
	CodeActionProvider,
} from "./activate"
import { initializeI18n } from "./i18n"

/**
 * Built using https://github.com/microsoft/vscode-webview-ui-toolkit
 *
 * Inspired by:
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra
 */

let outputChannel: vscode.OutputChannel
let cpProcess: import("child_process").ChildProcess | undefined

async function startControlPlane(workspaceRoot: string, disableDb: boolean): Promise<number | undefined> {
	const log = (msg: string) => outputChannel.appendLine(`[ControlPlane] ${msg}`)

	/** Simple helper – true if command runs successfully */
	const commandExists = (exe: string): boolean => {
		try {
			const r = spawn(exe, ["--version"], { shell: true, stdio: "ignore" })
			r.on("error", () => {})
			// best-effort – immediately kill
			r.kill()
			return true
		} catch {
			return false
		}
	}

	// Pre-flight: pnpm and git must be available
	if (!commandExists("pnpm")) {
		vscode.window.showErrorMessage("'pnpm' not found in PATH – install PNPM and reload VS Code.")
		return undefined
	}
	if (!commandExists("git")) {
		vscode.window.showErrorMessage("'git' not found in PATH – install Git and reload VS Code.")
		return undefined
	}

	if (cpProcess && extensionContext) {
		return extensionContext.globalState.get<number>("roo.cpPort")
	}
	const cfg = vscode.workspace.getConfiguration()
	const overridePort = cfg.get<number>("roo.cpPortOverride", 0)
	if (overridePort && overridePort > 0) {
		await extensionContext.globalState.update("roo.cpPort", overridePort)
		return overridePort
	}

	const cpRoot = cfg.get<string>("roo.controlPlane.rootPath", "")
	if (!cpRoot) {
		vscode.window.showErrorMessage(
			"Set 'roo.controlPlane.rootPath' to your Roo-Code repo (folder containing apps/control-plane)",
		)
		return undefined
	}
	const args = [
		"-C",
		"apps/control-plane",
		"run",
		"dev:oneshot",
		"--",
		"--repo",
		workspaceRoot,
		"--port",
		"0",
		"--disableMcp",
	]
	if (disableDb) args.push("--disableDb")

	// Use shell=true so that Windows resolves pnpm.cmd; this is cross-platform safe.
	// Explicitly pass process.env to ensure the child inherits the current PATH (including Git).
	const child = spawn("pnpm", args, { cwd: cpRoot, shell: true, env: process.env })
	cpProcess = child
	const rl = readline.createInterface({ input: child.stdout })
	return new Promise<number | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), 10000)
		rl.on("line", (line) => {
			try {
				const j = JSON.parse(line.trim())
				if (typeof j.port === "number") {
					clearTimeout(timer)
					extensionContext.globalState.update("roo.cpPort", j.port)
					resolve(j.port)
					rl.close()
				}
			} catch {}
		})
		child.on("exit", () => {
			clearTimeout(timer)
			extensionContext.globalState.update("roo.cpPort", undefined)
			resolve(undefined)
		})
	})
}

let extensionContext: vscode.ExtensionContext
let cloudService: CloudService | undefined
let autoCheckpointStatusItem: vscode.StatusBarItem | undefined

let authStateChangedHandler: ((data: { state: AuthState; previousState: AuthState }) => Promise<void>) | undefined
let settingsUpdatedHandler: (() => void) | undefined
let userInfoHandler: ((data: { userInfo: CloudUserInfo }) => Promise<void>) | undefined

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {
	await nukeOldWebviewCache()
	extensionContext = context
	outputChannel = vscode.window.createOutputChannel(Package.outputChannel)
	setGlobalChannel(outputChannel)
	context.subscriptions.push(outputChannel)
	outputChannel.appendLine(`${Package.name} extension activated - ${JSON.stringify(Package)}`)

	// Ensure Start Control-Plane command is always available even if later init fails
	vscode.commands.registerCommand("roo.startControlPlaneHere", async (): Promise<void> => {
		// If real command already registered, delegate
		const all = await vscode.commands.getCommands(true)
		if (all.includes("roo.startControlPlaneHere.real")) {
			await vscode.commands.executeCommand("roo.startControlPlaneHere.real")
			return
		}
		// Fallback inline logic
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!workspaceRoot) {
			vscode.window.showErrorMessage("Open a workspace folder first")
			return
		}
		// Check if Control-Plane is already running (from auto-start or previous run)
		const existingPort = extensionContext?.globalState.get<number>("roo.cpPort")
		if (existingPort) {
			vscode.window.showInformationMessage(`Roo Control-Plane already running on port ${existingPort}`)
			return
		}
		const port = await startControlPlane(workspaceRoot, !process.env.CP_DATABASE_URL)
		if (port) {
			vscode.window.showInformationMessage(`Roo Control-Plane started on port ${port}`)
		} else {
			vscode.window.showErrorMessage("Failed to start Control-Plane (see output)")
		}
	})
	// ------------------------------------------------------------------
	// Guard against invalid chat-participant registrations introduced by
	// VS Code 1.105 validation – silently skip calls with empty / undefined id
	// ------------------------------------------------------------------
	const chatApi: any = (vscode as any).chat
	if (chatApi && typeof chatApi.registerChatParticipant === "function") {
		const originalRegister = chatApi.registerChatParticipant
		chatApi.registerChatParticipant = function (id: string, participant: any) {
			if (!id || typeof id !== "string" || !/^[\w-]+$/.test(id)) {
				console.warn(`[chatGuard] skipped invalid participant id: ${String(id)}`)
				return { dispose() {} }
			}
			return originalRegister.call(this, id, participant)
		}
	}
	// ------------------------------------------------------------------

	// Migrate old settings to new
	await migrateSettings(context, outputChannel)

	// Initialize telemetry service (disable PostHog if no API key configured)
	const telemetryService = TelemetryService.createInstance()

	try {
		if (process.env.POSTHOG_API_KEY || vscode.workspace.getConfiguration().get<string>("roo.posthogApiKey")) {
			telemetryService.register(new PostHogTelemetryClient())
		} else {
			console.debug("PostHog API key not found – skipping analytics client registration")
		}
	} catch (error) {
		console.warn("Failed to register PostHogTelemetryClient:", error)
	}

	// Create logger for cloud services.
	const cloudLogger = createDualLogger(createOutputChannelLogger(outputChannel))

	// Initialize MDM service
	const mdmService = await MdmService.createInstance(cloudLogger)

	// Initialize i18n for internationalization support.
	initializeI18n(context.globalState.get("language") ?? formatLanguage(vscode.env.language))

	// Initialize terminal shell execution handlers.
	TerminalRegistry.initialize()

	// Get default commands from configuration.
	const defaultCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>("allowedCommands") || []

	// Initialize global state if not already set.
	if (!context.globalState.get("allowedCommands")) {
		context.globalState.update("allowedCommands", defaultCommands)
	}

	const contextProxy = await ContextProxy.getInstance(context)

	// Early core command registration (no provider dependency)
	await registerCommandMap({ context, outputChannel, provider: undefined as any }, getCoreCommands)

	// Code index manager temporarily disabled to unblock activation
	outputChannel.appendLine("[CodeIndexManager] skipped (disabled)")

	let provider: ClineProvider | undefined
	try {
		provider = new ClineProvider(context, outputChannel, "sidebar", contextProxy, mdmService)
	} catch (err) {
		console.error("[Provider] failed:", err)
		outputChannel.appendLine(`[Provider] failed: ${err}`)
	}

	// Register UI commands that depend on provider
	if (provider) {
		await registerCommandMap({ context, outputChannel, provider }, getUiCommands)
	}

	// Experimental: transactional control-plane auto-start
	;(async () => {
		const cfg = vscode.workspace.getConfiguration()
		const enabled =
			cfg.get<boolean>("roo.experimental.transactionalMode") ||
			cfg.get<boolean>("roo-cline.experimental.transactionalMode")
		if (!enabled) return
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!workspaceRoot) return
		const disableDb = !process.env.CP_DATABASE_URL
		const portStored = await context.globalState.get<number>("roo.cpPort")
		if (!portStored) {
			const port = await startControlPlane(workspaceRoot, disableDb)
			if (port) {
				outputChannel.appendLine(`[ControlPlane] started on port ${port}`)
			} else {
				outputChannel.appendLine(`[ControlPlane] failed to start`)
			}
		} else {
			outputChannel.appendLine(`[ControlPlane] using existing port ${portStored}`)
		}
	})().catch((e) => outputChannel.appendLine(`[ControlPlane] auto-start error: ${e}`))

	// Internal command for getting current tx id (placeholder)
	context.subscriptions.push(
		vscode.commands.registerCommand("roo.internal.getCurrentTxId", async () => {
			return (await context.globalState.get<string>("roo.current_tx_id")) || ""
		}),
	)

	// Internal command: get Control-Plane port from global state or undefined
	context.subscriptions.push(
		vscode.commands.registerCommand("roo.internal.getCpPort", async () => {
			return await context.globalState.get<number>("roo.cpPort")
		}),
	)

	// Real command (placeholder delegates to this once loaded)
	context.subscriptions.push(
		vscode.commands.registerCommand("roo.startControlPlaneHere.real", async () => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
			if (!root) {
				vscode.window.showErrorMessage("Open a workspace folder first")
				return
			}
			const port = await startControlPlane(root, !process.env.CP_DATABASE_URL)
			if (port) {
				vscode.window.showInformationMessage(`Roo Control-Plane started on port ${port}`)
			} else {
				vscode.window.showErrorMessage("Failed to start Control-Plane (see output)")
			}
		}),
	)

	// Command: Commit Transaction
	context.subscriptions.push(
		vscode.commands.registerCommand("roo.commitTransaction", async () => {
			const txId = await vscode.commands.executeCommand<string>("roo.internal.getCurrentTxId")
			if (!txId) {
				vscode.window.showWarningMessage("No active transaction")
				return
			}
			const strategy = vscode.workspace.getConfiguration().get<string>("roo.commit.strategy", "fail-fast")
			const port = (await context.globalState.get<number>("roo.cpPort")) || 8899
			try {
				const res = await fetch(`http://127.0.0.1:${port}/tx/${txId}/commit`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Actor-Id": "human" },
					body: JSON.stringify({ strategy, maxRebaseMs: 3000, maxConflictFiles: 10 }),
				})
				if (res.ok) {
					vscode.window.showInformationMessage("Transaction committed to main")
					return
				}
				if (res.status === 409) {
					const body = await res.json().catch(() => ({}))
					const conflicts: string[] = body?.details?.conflicts || []
					vscode.window.showErrorMessage(
						conflicts.length
							? `Commit blocked by conflicts: ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? "…" : ""}`
							: "Commit blocked by conflicts",
					)
					return
				}
				const text = await res.text().catch(() => "")
				vscode.window.showErrorMessage(`Commit failed (${res.status}): ${text}`)
			} catch (e) {
				vscode.window.showErrorMessage(`Commit failed: ${e}`)
			}
		}),
	)

	// Internal: record edit stats (patchBytes, filesTouched)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"roo.internal.recordEdit",
			async ({ patchBytes, filePath }: { patchBytes: number; filePath: string }) => {
				const prevBytes = (await context.globalState.get<number>("roo.ac.patchBytes")) || 0
				const prevFiles = (await context.globalState.get<number>("roo.ac.filesTouched")) || 0
				await context.globalState.update("roo.ac.patchBytes", prevBytes + (patchBytes || 0))
				await context.globalState.update("roo.ac.filesTouched", prevFiles + 1)
			},
		),
	)

	// Internal: store error context for smart rollback
	context.subscriptions.push(
		vscode.commands.registerCommand("roo.internal.storeError", async (errorMessage: string) => {
			await context.globalState.update("roo.lastError", errorMessage)
		}),
	)

	// Internal: maybe auto-checkpoint based on thresholds
	context.subscriptions.push(
		vscode.commands.registerCommand("roo.internal.maybeAutoCheckpoint", async () => {
			const cfg = vscode.workspace.getConfiguration()
			const transactional =
				cfg.get<boolean>("roo.experimental.transactionalMode") ||
				cfg.get<boolean>("roo-cline.experimental.transactionalMode")
			if (!transactional) return
			const enabled = cfg.get<boolean>("roo.autoCheckpoint.enabled", true)
			if (!enabled) return
			const patchBytesThresh = cfg.get<number>("roo.autoCheckpoint.patchBytes", 8192)
			const filesTouchedThresh = cfg.get<number>("roo.autoCheckpoint.filesTouched", 5)
			const elapsedMsThresh = cfg.get<number>("roo.autoCheckpoint.elapsedMs", 90000)
			const patchBytes = (await context.globalState.get<number>("roo.ac.patchBytes")) || 0
			const filesTouched = (await context.globalState.get<number>("roo.ac.filesTouched")) || 0
			const lastTs = (await context.globalState.get<number>("roo.ac.lastTs")) || 0
			const now = Date.now()
			const elapsed = now - lastTs
			const should =
				patchBytes >= patchBytesThresh || filesTouched >= filesTouchedThresh || elapsed >= elapsedMsThresh
			if (!should) return
			const txId = await vscode.commands.executeCommand<string>("roo.internal.getCurrentTxId")
			if (!txId) return
			try {
				const port = (await context.globalState.get<number>("roo.cpPort")) || 8899
				const res = await fetch(`http://127.0.0.1:${port}/tx/${txId}/checkpoint`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Actor-Id": "human" },
					body: JSON.stringify({ reason: "auto" }),
				})
				if (res.ok) {
					await context.globalState.update("roo.ac.patchBytes", 0)
					await context.globalState.update("roo.ac.filesTouched", 0)
					await context.globalState.update("roo.ac.lastTs", Date.now())
				}
			} catch (e) {
				// ignore
			}
		}),
	)

	// Status bar: Auto checkpoint toggle
	autoCheckpointStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	autoCheckpointStatusItem.command = "roo.toggleAutoCheckpoint"
	const refreshStatus = () => {
		const enabled = vscode.workspace.getConfiguration().get<boolean>("roo.autoCheckpoint.enabled", true)
		autoCheckpointStatusItem!.text = enabled ? "Roo Auto: On" : "Roo Auto: Off"
		autoCheckpointStatusItem!.tooltip = "Toggle auto-checkpoints"
		autoCheckpointStatusItem!.show()
	}
	refreshStatus()
	context.subscriptions.push(autoCheckpointStatusItem)
	context.subscriptions.push(
		vscode.commands.registerCommand("roo.toggleAutoCheckpoint", async () => {
			const cfg = vscode.workspace.getConfiguration()
			const current = cfg.get<boolean>("roo.autoCheckpoint.enabled", true)
			await cfg.update("roo.autoCheckpoint.enabled", !current, vscode.ConfigurationTarget.Global)
			refreshStatus()
		}),
	)

	// Initialize Roo Code Cloud service.
	const postStateListener = () => provider?.postStateToWebview()

	authStateChangedHandler = async (data: { state: AuthState; previousState: AuthState }) => {
		postStateListener()

		if (data.state === "logged-out") {
			try {
				await provider?.remoteControlEnabled(false)
			} catch (error) {
				cloudLogger(
					`[authStateChangedHandler] remoteControlEnabled(false) failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	settingsUpdatedHandler = async () => {
		const userInfo = CloudService.instance.getUserInfo()

		if (userInfo && CloudService.instance.cloudAPI) {
			try {
				await provider?.remoteControlEnabled(CloudService.instance.isTaskSyncEnabled())
			} catch (error) {
				cloudLogger(
					`[settingsUpdatedHandler] remoteControlEnabled failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		postStateListener()
	}

	userInfoHandler = async ({ userInfo }: { userInfo: CloudUserInfo }) => {
		postStateListener()

		if (!CloudService.instance.cloudAPI) {
			cloudLogger("[userInfoHandler] CloudAPI is not initialized")
			return
		}

		try {
			await provider?.remoteControlEnabled(CloudService.instance.isTaskSyncEnabled())
		} catch (error) {
			cloudLogger(
				`[userInfoHandler] remoteControlEnabled failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	cloudService = await CloudService.createInstance(context, cloudLogger, {
		"auth-state-changed": authStateChangedHandler,
		"settings-updated": settingsUpdatedHandler,
		"user-info": userInfoHandler,
	})

	try {
		if (cloudService.telemetryClient) {
			TelemetryService.instance.register(cloudService.telemetryClient)
		}
	} catch (error) {
		outputChannel.appendLine(
			`[CloudService] Failed to register TelemetryClient: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	// Add to subscriptions for proper cleanup on deactivate.
	context.subscriptions.push(cloudService)

	// Trigger initial cloud profile sync now that CloudService is ready.
	try {
		await provider?.initializeCloudProfileSyncWhenReady()
	} catch (error) {
		outputChannel.appendLine(
			`[CloudService] Failed to initialize cloud profile sync: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	// Finish initializing the provider.
	if (provider) {
		TelemetryService.instance.setProvider(provider)

		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(ClineProvider.sideBarId, provider, {
				webviewOptions: { retainContextWhenHidden: true },
			}),
		)

		// Auto-import configuration if specified in settings.
		try {
			await autoImportSettings(outputChannel, {
				providerSettingsManager: provider.providerSettingsManager,
				contextProxy: provider.contextProxy,
				customModesManager: provider.customModesManager,
			})
		} catch (error) {
			outputChannel.appendLine(
				`[AutoImport] Error during auto-import: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	} else {
		outputChannel.appendLine("[Extension] Provider initialization failed, some features unavailable")
	}

	registerCodeActions(context)
	registerTerminalActions(context)

	// Allows other extensions to activate once Roo is ready.
	vscode.commands.executeCommand(`${Package.name}.activationCompleted`)

	// Implements the `RooCodeAPI` interface.
	const socketPath = process.env.ROO_CODE_IPC_SOCKET_PATH
	const enableLogging = typeof socketPath === "string"

	// Watch the core files and automatically reload the extension host.
	if (process.env.NODE_ENV === "development") {
		const watchPaths = [
			{ path: context.extensionPath, pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "../packages/types"), pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "../packages/telemetry"), pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "node_modules/@agentic-code/cloud"), pattern: "**/*" },
		]

		console.log(
			`♻️♻️♻️ Core auto-reloading: Watching for changes in ${watchPaths.map(({ path }) => path).join(", ")}`,
		)

		// Create a debounced reload function to prevent excessive reloads
		let reloadTimeout: NodeJS.Timeout | undefined
		const DEBOUNCE_DELAY = 1_000

		const debouncedReload = (uri: vscode.Uri) => {
			if (reloadTimeout) {
				clearTimeout(reloadTimeout)
			}

			console.log(`♻️ ${uri.fsPath} changed; scheduling reload...`)

			reloadTimeout = setTimeout(() => {
				console.log(`♻️ Reloading host after debounce delay...`)
				vscode.commands.executeCommand("workbench.action.reloadWindow")
			}, DEBOUNCE_DELAY)
		}

		watchPaths.forEach(({ path: watchPath, pattern }) => {
			const relPattern = new vscode.RelativePattern(vscode.Uri.file(watchPath), pattern)
			const watcher = vscode.workspace.createFileSystemWatcher(relPattern, false, false, false)

			// Listen to all change types to ensure symlinked file updates trigger reloads.
			watcher.onDidChange(debouncedReload)
			watcher.onDidCreate(debouncedReload)
			watcher.onDidDelete(debouncedReload)

			context.subscriptions.push(watcher)
		})

		// Clean up the timeout on deactivation
		context.subscriptions.push({
			dispose: () => {
				if (reloadTimeout) {
					clearTimeout(reloadTimeout)
				}
			},
		})
	}

	// Provider is required for API - if initialization failed, use a null assertion (acceptable here as
	// the provider should always exist unless there was a critical error that would have been logged)
	return new API(outputChannel, provider!, socketPath, enableLogging)
}

// This method is called when your extension is deactivated.
export async function deactivate() {
	outputChannel.appendLine(`${Package.name} extension deactivated`)

	if (cloudService && CloudService.hasInstance()) {
		try {
			if (authStateChangedHandler) {
				CloudService.instance.off("auth-state-changed", authStateChangedHandler)
			}

			if (settingsUpdatedHandler) {
				CloudService.instance.off("settings-updated", settingsUpdatedHandler)
			}

			if (userInfoHandler) {
				CloudService.instance.off("user-info", userInfoHandler as any)
			}

			outputChannel.appendLine("CloudService event handlers cleaned up")
		} catch (error) {
			outputChannel.appendLine(
				`Failed to clean up CloudService event handlers: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	const bridge = BridgeOrchestrator.getInstance()

	if (bridge) {
		await bridge.disconnect()
	}

	await McpServerManager.cleanup(extensionContext)
	TelemetryService.instance.shutdown()
	TerminalRegistry.cleanup()

	if (cpProcess && !cpProcess.killed) {
		try {
			cpProcess.kill()
		} catch {}
	}
}
