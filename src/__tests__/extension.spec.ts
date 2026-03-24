// npx vitest run __tests__/extension.spec.ts

import type * as vscode from "vscode"
import type { AuthState } from "@roo-code/types"

vi.mock("vscode", async () => {
	const base = await vi.importActual<any>("vscode")
	return {
		...base,
		// extension.ts touches vscode.chat very early; make sure it's always present in this mock
		chat: base.chat ?? {
			registerChatParticipant: vi.fn(() => ({ dispose: vi.fn() })),
		},
		window: {
			...(base.window ?? {}),
			createOutputChannel: vi.fn().mockReturnValue({
				appendLine: vi.fn(),
			}),
			registerWebviewViewProvider: vi.fn(),
			registerUriHandler: vi.fn(),
			showInformationMessage: vi.fn(),
			showErrorMessage: vi.fn(),
			showWarningMessage: vi.fn(),
			createStatusBarItem: vi.fn().mockReturnValue({
				show: vi.fn(),
				hide: vi.fn(),
				dispose: vi.fn(),
				text: "",
				tooltip: "",
				command: "",
			}),
			tabGroups: {
				onDidChangeTabs: vi.fn(),
			},
			onDidChangeActiveTextEditor: vi.fn(),
		},
		workspace: {
			...(base.workspace ?? {}),
			registerTextDocumentContentProvider: vi.fn(),
			getConfiguration: vi.fn().mockReturnValue({
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn(),
			}),
			createFileSystemWatcher: vi.fn().mockReturnValue({
				onDidCreate: vi.fn(),
				onDidChange: vi.fn(),
				onDidDelete: vi.fn(),
				dispose: vi.fn(),
			}),
			onDidChangeWorkspaceFolders: vi.fn(),
			workspaceFolders: undefined,
		},
		languages: {
			...(base.languages ?? {}),
			registerCodeActionsProvider: vi.fn(),
		},
		commands: {
			...(base.commands ?? {}),
			executeCommand: vi.fn(),
			registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		},
		env: {
			...(base.env ?? {}),
			language: "en",
		},
		ExtensionMode: {
			Production: 1,
		},
		StatusBarAlignment: {
			Left: 1,
			Right: 2,
		},
		ConfigurationTarget: {
			Global: 1,
			Workspace: 2,
			WorkspaceFolder: 3,
		},
		RelativePattern: vi.fn(),
		Uri: {
			file: vi.fn((p: string) => ({ fsPath: p })),
			...(base.Uri ?? {}),
		},
	}
})

vi.mock("@dotenvx/dotenvx", () => ({
	config: vi.fn(),
}))

const mockBridgeOrchestratorDisconnect = vi.fn().mockResolvedValue(undefined)

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		createInstance: vi.fn(),
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				off: vi.fn(),
				on: vi.fn(),
				getUserInfo: vi.fn().mockReturnValue(null),
				isTaskSyncEnabled: vi.fn().mockReturnValue(false),
			}
		},
	},
	BridgeOrchestrator: {
		getInstance: vi.fn().mockReturnValue({
			disconnect: mockBridgeOrchestratorDisconnect,
		}),
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		createInstance: vi.fn().mockReturnValue({
			register: vi.fn(),
			setProvider: vi.fn(),
			shutdown: vi.fn(),
		}),
		get instance() {
			return {
				register: vi.fn(),
				setProvider: vi.fn(),
				shutdown: vi.fn(),
			}
		},
	},
	PostHogTelemetryClient: vi.fn(),
}))

vi.mock("../utils/outputChannelLogger", () => ({
	createOutputChannelLogger: vi.fn().mockReturnValue(vi.fn()),
	createDualLogger: vi.fn().mockReturnValue(vi.fn()),
}))

vi.mock("../shared/package", () => ({
	Package: {
		name: "test-extension",
		outputChannel: "Test Output",
		version: "1.0.0",
	},
}))

vi.mock("../shared/language", () => ({
	formatLanguage: vi.fn().mockReturnValue("en"),
}))

vi.mock("../shared/globalChannel", () => ({
	setGlobalChannel: vi.fn(),
}))

vi.mock("../core/config/ContextProxy", () => ({
	ContextProxy: {
		getInstance: vi.fn().mockResolvedValue({
			getValue: vi.fn(),
			setValue: vi.fn(),
			getValues: vi.fn().mockReturnValue({}),
			getProviderSettings: vi.fn().mockReturnValue({}),
		}),
	},
}))

vi.mock("../integrations/editor/DiffViewProvider", () => ({
	DIFF_VIEW_URI_SCHEME: "test-diff-scheme",
}))

vi.mock("../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		initialize: vi.fn(),
		cleanup: vi.fn(),
	},
}))

vi.mock("../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		cleanup: vi.fn().mockResolvedValue(undefined),
		getInstance: vi.fn().mockResolvedValue(null),
		unregisterProvider: vi.fn(),
	},
}))

vi.mock("../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn().mockReturnValue(null),
	},
}))

vi.mock("../services/mdm/MdmService", () => ({
	MdmService: {
		createInstance: vi.fn().mockResolvedValue(null),
	},
}))

vi.mock("../utils/migrateSettings", () => ({
	migrateSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../utils/autoImportSettings", () => ({
	autoImportSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../utils/path", () => ({}))

vi.mock("../extension/api", () => ({
	API: vi.fn().mockImplementation(() => ({})),
}))

vi.mock("../core/webview/ClineProvider", () => ({
	ClineProvider: vi.fn().mockImplementation(() => ({
		postStateToWebview: vi.fn(),
		remoteControlEnabled: vi.fn().mockResolvedValue(undefined),
		initializeCloudProfileSyncWhenReady: vi.fn().mockResolvedValue(undefined),
		providerSettingsManager: {},
		contextProxy: {},
		customModesManager: {},
		dispose: vi.fn(),
	})),
}))

vi.mock("../activate", () => ({
	handleUri: vi.fn(),
	registerCommandMap: vi.fn().mockResolvedValue(undefined),
	getCoreCommands: vi.fn(),
	getUiCommands: vi.fn(),
	registerCommands: vi.fn(),
	registerCodeActions: vi.fn(),
	registerTerminalActions: vi.fn(),
	CodeActionProvider: vi.fn().mockImplementation(() => ({
		providedCodeActionKinds: [],
	})),
}))

vi.mock("../i18n", () => ({
	initializeI18n: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	readdir: vi.fn().mockResolvedValue([]),
	rm: vi.fn().mockResolvedValue(undefined),
}))

describe("extension.ts", () => {
	let mockContext: vscode.ExtensionContext
	let authStateChangedHandler:
		| ((data: { state: AuthState; previousState: AuthState }) => void | Promise<void>)
		| undefined

	beforeEach(() => {
		vi.clearAllMocks()
		mockBridgeOrchestratorDisconnect.mockClear()

		// Reset the cached module so each test gets a fresh activate().
		vi.resetModules()

		mockContext = {
			extensionPath: "/test/path",
			globalStorageUri: { fsPath: "/test/storage" } as any,
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn(),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		authStateChangedHandler = undefined
	})

	test("authStateChangedHandler invokes remoteControlEnabled(false) when logged-out event fires", async () => {
		const { CloudService } = await import("@roo-code/cloud")

		// Capture the auth state changed handler.
		vi.mocked(CloudService.createInstance).mockImplementation(async (_context, _logger, handlers) => {
			if (handlers?.["auth-state-changed"]) {
				authStateChangedHandler = handlers["auth-state-changed"]
			}

			return {
				off: vi.fn(),
				on: vi.fn(),
				telemetryClient: null,
			} as any
		})

		// Activate the extension.
		const { activate } = await import("../extension")
		await activate(mockContext)

		// Verify handler was registered.
		expect(authStateChangedHandler).toBeDefined()

		// Get the ClineProvider mock instance to check remoteControlEnabled calls.
		const { ClineProvider } = await import("../core/webview/ClineProvider")
		const providerInstance = vi.mocked(ClineProvider).mock.results[0]?.value

		// Trigger logout.
		await authStateChangedHandler!({
			state: "logged-out" as AuthState,
			previousState: "logged-in" as AuthState,
		})

		// The actual authStateChangedHandler calls provider.remoteControlEnabled(false)
		// when the state is "logged-out".
		expect(providerInstance.remoteControlEnabled).toHaveBeenCalledWith(false)
	}, 30_000)

	test("authStateChangedHandler does not call remoteControlEnabled for other states", async () => {
		const { CloudService } = await import("@roo-code/cloud")

		// Capture the auth state changed handler.
		vi.mocked(CloudService.createInstance).mockImplementation(async (_context, _logger, handlers) => {
			if (handlers?.["auth-state-changed"]) {
				authStateChangedHandler = handlers["auth-state-changed"]
			}

			return {
				off: vi.fn(),
				on: vi.fn(),
				telemetryClient: null,
			} as any
		})

		// Activate the extension.
		const { activate } = await import("../extension")
		await activate(mockContext)

		// Get the ClineProvider mock instance.
		const { ClineProvider } = await import("../core/webview/ClineProvider")
		const providerInstance = vi.mocked(ClineProvider).mock.results[0]?.value

		// Clear any calls from activation itself.
		vi.mocked(providerInstance.remoteControlEnabled).mockClear()

		// Trigger login.
		await authStateChangedHandler!({
			state: "logged-in" as AuthState,
			previousState: "logged-out" as AuthState,
		})

		// Verify remoteControlEnabled was NOT called for non-logout states.
		expect(providerInstance.remoteControlEnabled).not.toHaveBeenCalled()
	}, 30_000)
})
