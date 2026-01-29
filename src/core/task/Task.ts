import * as path from "path"
import * as vscode from "vscode"
import os from "os"
import crypto from "crypto"
import EventEmitter from "events"
import * as fs from "fs/promises"

import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderSettings,
	type TokenUsage,
	type ToolUsage,
	type ToolName,
	type ContextCondense,
	type ClineMessage,
	type ClineSay,
	type ClineAsk,
	type ToolProgressStatus,
	type HistoryItem,
	type CreateTaskOptions,
	RooCodeEventName,
	TelemetryEventName,
	TaskStatus,
	TodoItem,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	getApiProtocol,
	getModelId,
	toolNames,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	QueuedMessage,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { CloudService, BridgeOrchestrator } from "@roo-code/cloud"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler } from "../../api"
import { ApiStream, GroundingSource } from "../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"

// shared
import { findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { t } from "../../i18n"
import { ClineApiReqCancelReason, ClineApiReqInfo } from "../../shared/ExtensionMessage"
import { getApiMetrics, hasTokenUsageChanged } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { getModelMaxOutputTokens } from "../../shared/api"

// services
import { UrlContentFetcher } from "../../services/browser/UrlContentFetcher"
import { BrowserSession } from "../../services/browser/BrowserSession"
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"
import {
	waitForRateLimit,
	recordRateLimitError,
	clearRateLimit,
	getRateLimitDelay,
	isRateLimitError,
	isAuthenticationError,
	isBillingError,
} from "../rate-limit/RateLimitCoordinator"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { findToolName, formatContentBlockToMarkdown } from "../../integrations/misc/export-markdown"
import { RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"

// utils
import { calculateApiCostAnthropic } from "../../shared/cost"
import { getWorkspacePath } from "../../utils/path"
import { extractFilePathsFromText, validateFilePaths } from "../../utils/fs"

// prompts
import { formatResponse } from "../prompts/responses"
import { SYSTEM_PROMPT } from "../prompts/system"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { restoreTodoListForTask } from "../tools/updateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { RooProtectedController } from "../protect/RooProtectedController"
import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { AssistantMessageParser } from "../assistant-message/AssistantMessageParser"
import { truncateConversationIfNeeded } from "../sliding-window"
import { ClineProvider } from "../webview/ClineProvider"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { MultiFileSearchReplaceDiffStrategy } from "../diff/strategies/multi-file-search-replace"
import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	readTaskMessages,
	saveTaskMessages,
	taskMetadata,
} from "../task-persistence"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { processUserContentMentions } from "../mentions/processUserContentMentions"
import { getMessagesSinceLastSummary, summarizeConversation } from "../condense"
import { Gpt5Metadata, ClineMessageWithMetadata } from "./types"
import { MessageQueueService } from "../message-queue/MessageQueueService"

import { AutoApprovalHandler } from "./AutoApprovalHandler"

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes
const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds
const FORCED_CONTEXT_REDUCTION_PERCENT = 75 // Keep 75% of context (remove 25%) on context window errors
const MAX_CONTEXT_WINDOW_RETRIES = 3 // Maximum retries for context window errors

export interface TaskOptions extends CreateTaskOptions {
	provider: ClineProvider
	apiConfiguration: ProviderSettings
	enableDiff?: boolean
	enableCheckpoints?: boolean
	enableBridge?: boolean
	fuzzyMatchThreshold?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (task: Task) => void
	initialTodos?: TodoItem[]
	workspacePath?: string
}

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	childTaskId?: string // Kept for backward compatibility with single-child tasks
	childTaskIds: string[] = [] // Support multiple children for planner mode

	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	readonly rootTask: Task | undefined = undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string

	/**
	 * The mode associated with this task. Persisted across sessions
	 * to maintain user context when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskMode()`
	 * 3. Falls back to `defaultModeSlug` if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.mode` during construction
	 * 2. Falls back to `defaultModeSlug` if mode is not stored in history
	 *
	 * ## Important
	 * This property should NOT be accessed directly until `taskModeReady` promise resolves.
	 * Use `getTaskMode()` for async access or `taskMode` getter for sync access after initialization.
	 *
	 * @private
	 * @see {@link getTaskMode} - For safe async access
	 * @see {@link taskMode} - For sync access after initialization
	 * @see {@link waitForModeInitialization} - To ensure initialization is complete
	 */
	private _taskMode: string | undefined

	/**
	 * Promise that resolves when the task mode has been initialized.
	 * This ensures async mode initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task mode
	 * - Ensures provider state is properly loaded before mode-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 * @see {@link waitForModeInitialization} - Public method to await this promise
	 */
	private taskModeReady: Promise<void>

	providerRef: WeakRef<ClineProvider>
	private readonly globalStoragePath: string
	abort: boolean = false

	// TaskStatus
	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage

	didFinishAbortingStream = false
	abandoned = false
	abortReason?: ClineApiReqCancelReason
	/** Track if task aborted due to blocked Task#ask in e2e mode (for parent task propagation) */
	e2eBlockedAskAbort?: { type: string }
	isInitialized = false
	isPaused: boolean = false
	pausedModeSlug: string = defaultModeSlug
	private pauseInterval: NodeJS.Timeout | undefined

	// API
	readonly apiConfiguration: ProviderSettings
	api: ApiHandler
	private static lastGlobalApiRequestTime?: number
	private autoApprovalHandler: AutoApprovalHandler

	/**
	 * Reset the global API request timestamp. This should only be used for testing.
	 * @internal
	 */
	static resetGlobalApiRequestTime(): void {
		Task.lastGlobalApiRequestTime = undefined
	}

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: RooIgnoreController
	rooProtectedController?: RooProtectedController
	fileContextTracker: FileContextTracker
	urlContentFetcher: UrlContentFetcher
	terminalProcess?: RooTerminalProcess

	// Computer User
	browserSession: BrowserSession

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	diffEnabled: boolean = false
	fuzzyMatchThreshold: number
	didEditFile: boolean = false

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	// Ask
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	public lastMessageTs?: number

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	toolUsage: ToolUsage = {}

	// Tool Call History for Replay (P3)
	toolCallHistory: {
		toolName: string
		input: Record<string, unknown>
		timestamp: number
		checkpointBefore?: string
	}[] = []

	// Model Call History for Reproducibility (P3)
	modelCallHistory: {
		modelId: string
		promptHash: string // SHA256 of system prompt + messages
		messageCount: number
		timestamp: number
		durationMs?: number
	}[] = []

	// Checkpoints
	enableCheckpoints: boolean
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Sub-Transactions (semantic units of atomicity)
	currentSubTransaction?: import("../checkpoints/types").SubTransaction
	subTransactions: import("../checkpoints/types").SubTransaction[] = []

	// Planner mode
	plan?: import("../planner/types").Plan
	worktreePath?: string
	agentType?: "coder" | "tester" | "reviewer" | "general"
	subTransactionId?: string // Maps child task to sub-transaction ID

	// Task Bridge
	enableBridge: boolean

	// Message Queue Service
	public readonly messageQueueService: MessageQueueService
	private messageQueueStateChangedHandler: (() => void) | undefined

	// Streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	currentStreamingContentIndex = 0
	currentStreamingDidCheckpoint = false
	assistantMessageContent: AssistantMessageContent[] = []
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
	userMessageContentReady = false
	didRejectTool = false
	didAlreadyUseTool = false
	didCompleteReadingStream = false
	assistantMessageParser: AssistantMessageParser
	private lastUsedInstructions?: string
	private skipPrevResponseIdOnce: boolean = false
	// Fix #2: Track if we need to inject hard constraint on next LLM call
	forceConstraintNextTurn: boolean = false
	pendingValidationError: { tool: string; code: string; message: string } | null = null

	// Token Usage Cache
	private tokenUsageSnapshot?: TokenUsage
	private tokenUsageSnapshotAt?: number

	constructor({
		provider,
		apiConfiguration,
		enableDiff = false,
		enableCheckpoints = true,
		enableBridge = false,
		fuzzyMatchThreshold = 1.0,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		task,
		images,
		historyItem,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
		initialTodos,
		workspacePath,
	}: TaskOptions) {
		super()

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		this.taskId = historyItem ? historyItem.id : crypto.randomUUID()
		this.rootTaskId = historyItem ? historyItem.rootTaskId : rootTask?.taskId
		this.parentTaskId = historyItem ? historyItem.parentTaskId : parentTask?.taskId
		this.childTaskId = undefined
		this.childTaskIds = []

		this.metadata = {
			task: historyItem ? historyItem.task : task,
			images: historyItem ? [] : images,
		}

		// Normal use-case is usually retry similar history task with new workspace.
		this.workspacePath = parentTask
			? parentTask.workspacePath
			: (workspacePath ?? getWorkspacePath(path.join(os.homedir(), "Desktop")))

		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.rooProtectedController = new RooProtectedController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId)

		this.rooIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.apiConfiguration = apiConfiguration
		this.api = buildApiHandler(apiConfiguration)
		this.autoApprovalHandler = new AutoApprovalHandler()

		this.urlContentFetcher = new UrlContentFetcher(provider.context)
		this.browserSession = new BrowserSession(provider.context)
		this.diffEnabled = enableDiff
		this.fuzzyMatchThreshold = fuzzyMatchThreshold
		this.consecutiveMistakeLimit = consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
		this.providerRef = new WeakRef(provider)
		this.logApiConfigSummary()
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.diffViewProvider = new DiffViewProvider(this.cwd, this)
		this.enableCheckpoints = enableCheckpoints
		this.enableBridge = enableBridge

		this.parentTask = parentTask
		this.taskNumber = taskNumber

		// Store the task's mode when it's created.
		// For history items, use the stored mode; for new tasks, we'll set it
		// after getting state.
		if (historyItem) {
			this._taskMode = historyItem.mode || defaultModeSlug
			this.taskModeReady = Promise.resolve()
			TelemetryService.instance.captureTaskRestarted(this.taskId)
		} else {
			// For new tasks, don't set the mode yet - wait for async initialization.
			this._taskMode = undefined
			this.taskModeReady = this.initializeTaskMode(provider)
			TelemetryService.instance.captureTaskCreated(this.taskId)
		}

		// Initialize the assistant message parser.
		this.assistantMessageParser = new AssistantMessageParser()

		this.messageQueueService = new MessageQueueService()

		this.messageQueueStateChangedHandler = () => {
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
			this.providerRef.deref()?.postStateToWebview()
		}

		this.messageQueueService.on("stateChanged", this.messageQueueStateChangedHandler)

		// Only set up diff strategy if diff is enabled.
		if (this.diffEnabled) {
			// Default to old strategy, will be updated if experiment is enabled.
			this.diffStrategy = new MultiSearchReplaceDiffStrategy(this.fuzzyMatchThreshold)

			// Check experiment asynchronously and update strategy if needed.
			provider.getState().then((state) => {
				const isMultiFileApplyDiffEnabled = experiments.isEnabled(
					state.experiments ?? {},
					EXPERIMENT_IDS.MULTI_FILE_APPLY_DIFF,
				)

				if (isMultiFileApplyDiffEnabled) {
					this.diffStrategy = new MultiFileSearchReplaceDiffStrategy(this.fuzzyMatchThreshold)
				}
			})
		}

		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)

		// Initialize todo list if provided
		if (initialTodos && initialTodos.length > 0) {
			this.todoList = initialTodos
		}

		onCreated?.(this)

		if (startTask) {
			if (task || images) {
				this.startTask(task, images)
			} else if (historyItem) {
				this.resumeTaskFromHistory()
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	/**
	 * Initialize the task mode from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current mode from provider state
	 * 2. Sets `_taskMode` to the fetched mode or `defaultModeSlug` if unavailable
	 * 3. Handles errors gracefully by falling back to default mode
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to `defaultModeSlug` to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskMode(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this._taskMode = state?.mode || defaultModeSlug
		} catch (error) {
			// If there's an error getting state, use the default mode
			this._taskMode = defaultModeSlug
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task mode: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Wait for the task mode to be initialized before proceeding.
	 * This method ensures that any operations depending on the task mode
	 * will have access to the correct mode value.
	 *
	 * ## When to use
	 * - Before accessing mode-specific configurations
	 * - When switching between tasks with different modes
	 * - Before operations that depend on mode-based permissions
	 *
	 * ## Example usage
	 * ```typescript
	 * // Wait for mode initialization before mode-dependent operations
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Now safe to access synchronously
	 *
	 * // Or use with getTaskMode() for a one-liner
	 * const mode = await task.getTaskMode(); // Internally waits for initialization
	 * ```
	 *
	 * @returns Promise that resolves when the task mode is initialized
	 * @public
	 */
	public async waitForModeInitialization(): Promise<void> {
		return this.taskModeReady
	}

	/**
	 * Get the task mode asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task mode as it guarantees
	 * the mode is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskModeReady` promise to resolve
	 * - Returns the initialized mode or `defaultModeSlug` as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // Safe async access
	 * const mode = await task.getTaskMode();
	 * console.log(`Task is running in ${mode} mode`);
	 *
	 * // Use in conditional logic
	 * if (await task.getTaskMode() === 'architect') {
	 *   // Perform architect-specific operations
	 * }
	 * ```
	 *
	 * @returns Promise resolving to the task mode string
	 * @public
	 */
	public async getTaskMode(): Promise<string> {
		await this.taskModeReady
		return this._taskMode || defaultModeSlug
	}

	/**
	 * Get the task mode synchronously. This should only be used when you're certain
	 * that the mode has already been initialized (e.g., after waitForModeInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForModeInitialization()`
	 * - In event handlers or callbacks where mode is guaranteed to be initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // After ensuring initialization
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Safe synchronous access
	 *
	 * // In an event handler after task is started
	 * task.on('taskStarted', () => {
	 *   console.log(`Task started in ${task.taskMode} mode`); // Safe here
	 * });
	 * ```
	 *
	 * @throws {Error} If the mode hasn't been initialized yet
	 * @returns The task mode string
	 * @public
	 */
	public get taskMode(): string {
		if (this._taskMode === undefined) {
			throw new Error("Task mode accessed before initialization. Use getTaskMode() or wait for taskModeReady.")
		}

		return this._taskMode
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise

		if (images || task) {
			promise = instance.startTask(task, images)
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	// API Messages

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam) {
		const messageWithTs = { ...message, ts: Date.now() }
		this.apiConversationHistory.push(messageWithTs)
		await this.saveApiConversationHistory()
	}

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	private async saveApiConversationHistory() {
		try {
			await saveApiMessages({
				messages: this.apiConversationHistory,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})
		} catch (error) {
			// In the off chance this fails, we don't want to stop the task.
			console.error("Failed to save API conversation history:", error)
		}
	}

	// Cline Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToClineMessages(message: ClineMessage) {
		this.clineMessages.push(message)
		const provider = this.providerRef.deref()
		await provider?.postStateToWebview()
		this.emit(RooCodeEventName.Message, { action: "created", message })
		await this.saveClineMessages()

		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()

		if (shouldCaptureMessage) {
			CloudService.instance.captureEvent({
				event: TelemetryEventName.TASK_MESSAGE,
				properties: { taskId: this.taskId, message },
			})
		}
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages

		// If deletion or history truncation leaves a condense_context as the last message,
		// ensure the next API call suppresses previous_response_id so the condensed context is respected.
		try {
			const last = this.clineMessages.at(-1)
			if (last && last.type === "say" && last.say === "condense_context") {
				this.skipPrevResponseIdOnce = true
			}
		} catch {
			// non-fatal
		}

		restoreTodoListForTask(this)
		await this.saveClineMessages()
	}

	private async updateClineMessage(message: ClineMessage) {
		const provider = this.providerRef.deref()
		await provider?.postMessageToWebview({ type: "messageUpdated", clineMessage: message })
		this.emit(RooCodeEventName.Message, { action: "updated", message })

		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()

		if (shouldCaptureMessage) {
			CloudService.instance.captureEvent({
				event: TelemetryEventName.TASK_MESSAGE,
				properties: { taskId: this.taskId, message },
			})
		}
	}

	private async saveClineMessages() {
		try {
			await saveTaskMessages({
				messages: this.clineMessages,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})

			const { historyItem, tokenUsage } = await taskMetadata({
				taskId: this.taskId,
				rootTaskId: this.rootTaskId,
				parentTaskId: this.parentTaskId,
				taskNumber: this.taskNumber,
				messages: this.clineMessages,
				globalStoragePath: this.globalStoragePath,
				workspace: this.cwd,
				mode: this._taskMode || defaultModeSlug, // Use the task's own mode, not the current provider mode.
			})

			if (hasTokenUsageChanged(tokenUsage, this.tokenUsageSnapshot)) {
				this.emit(RooCodeEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage)
				this.tokenUsageSnapshot = undefined
				this.tokenUsageSnapshotAt = undefined
			}

			await this.providerRef.deref()?.updateTaskHistory(historyItem)
		} catch (error) {
			console.error("Failed to save Roo messages:", error)
		}
	}

	private findMessageByTimestamp(ts: number): ClineMessage | undefined {
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			if (this.clineMessages[i].ts === ts) {
				return this.clineMessages[i]
			}
		}

		return undefined
	}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		// If this Cline instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Cline now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Cline = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[RooCode#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		let askTs: number

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateClineMessage(lastMessage)
					throw new Error("Current ask promise was ignored (#1)")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial, isProtected })
					throw new Error("Current ask promise was ignored (#2)")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined

					// Bug for the history books:
					// In the webview we use the ts as the chatrow key for the
					// virtuoso list. Since we would update this ts right at the
					// end of streaming, it would cause the view to flicker. The
					// key prop has to be stable otherwise react has trouble
					// reconciling items between renders, causing unmounting and
					// remounting of components (flickering).
					// The lesson here is if you see flickering when rendering
					// lists, it's likely because the key prop is not stable.
					// So in this case we must make sure that the message ts is
					// never altered after first setting it.
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					await this.saveClineMessages()
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
		}

		// The state is mutable if the message is complete and the task will
		// block (via the `pWaitFor`).
		const isBlocking = !(this.askResponse !== undefined || this.lastMessageTs !== askTs)
		const isMessageQueued = !this.messageQueueService.isEmpty()
		const isStatusMutable = !partial && isBlocking && !isMessageQueued
		let statusMutationTimeouts: NodeJS.Timeout[] = []

		if (isStatusMutable) {
			console.log(`Task#ask will block -> type: ${type}`)

			if (isInteractiveAsk(type)) {
				statusMutationTimeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.interactiveAsk = message
							this.emit(RooCodeEventName.TaskInteractive, this.taskId)
						}
					}, 1_000),
				)
			} else if (isResumableAsk(type)) {
				statusMutationTimeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.resumableAsk = message
							this.emit(RooCodeEventName.TaskResumable, this.taskId)
						}
					}, 1_000),
				)
			} else if (isIdleAsk(type)) {
				statusMutationTimeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.idleAsk = message
							this.emit(RooCodeEventName.TaskIdle, this.taskId)
						}
					}, 1_000),
				)
			}
		} else if (isMessageQueued) {
			console.log("Task#ask will process message queue")

			const message = this.messageQueueService.dequeueMessage()

			if (message) {
				// Check if this is a tool approval ask that needs to be handled
				if (
					type === "tool" ||
					type === "command" ||
					type === "browser_action_launch" ||
					type === "use_mcp_server"
				) {
					// For tool approvals, we need to approve first, then send the message if there's text/images
					this.handleWebviewAskResponse("yesButtonClicked", message.text, message.images)
				} else {
					// For other ask types (like followup), fulfill the ask directly
					this.setMessageResponse(message.text, message.images)
				}
			}
		}

		// E2E mode: Prevent ALL blocking Task#ask calls
		const isE2EMode = !!(process.env.TEST_TORTURE_REPO || process.env.TEST_TORTURE_REPO_WORKSPACE)
		if (isE2EMode && isBlocking && !isMessageQueued) {
			const provider = this.providerRef.deref()
			const state = await provider?.getState()
			const autoApprovalEnabled = state?.autoApprovalEnabled ?? false
			const alwaysAllowWrite = state?.alwaysAllowWrite ?? false
			const alwaysAllowReadOnly = state?.alwaysAllowReadOnly ?? false
			const alwaysAllowReadOnlyOutsideWorkspace = state?.alwaysAllowReadOnlyOutsideWorkspace ?? false
			const alwaysAllowExecute = state?.alwaysAllowExecute ?? false
			
			// Parse tool message to check if it's outside workspace
			let isOutsideWorkspace = false
			if (type === "tool" && typeof message === "string") {
				try {
					const toolMessage = JSON.parse(message) as { isOutsideWorkspace?: boolean; batchFiles?: Array<{ isOutsideWorkspace?: boolean }> }
					isOutsideWorkspace = toolMessage.isOutsideWorkspace ?? toolMessage.batchFiles?.some(f => f.isOutsideWorkspace) ?? false
				} catch {
					// Not JSON, ignore
				}
			}
			
			if (type === "followup") {
				// Auto-respond to followup questions with deterministic default
				provider?.log(
					`[Task#ask] E2E mode: Auto-responding to followup question with default - Task: ${this.taskId}`
				)
				this.setMessageResponse("Proceed with reasonable defaults")
			} else if (type === "tool" && autoApprovalEnabled) {
				// Parse tool message to check if it's a special case (like finishTask)
				let isFinishTask = false
				if (typeof message === "string") {
					try {
						const toolMessage = JSON.parse(message) as { tool?: string }
						isFinishTask = toolMessage.tool === "finishTask"
					} catch {
						// Not JSON, ignore
					}
				}
				
				// Special case: Always auto-approve finishTask requests in E2E mode
				// This is needed for subtask completion to proceed automatically
				if (isFinishTask) {
					provider?.log(
						`[Task#ask] E2E mode: Auto-approving finishTask tool call (subtask completion) - Task: ${this.taskId}`
					)
					this.handleWebviewAskResponse("yesButtonClicked")
				} else {
					// Check if we should auto-approve based on permissions for regular tool calls
					const shouldApprove = 
						alwaysAllowWrite || 
						alwaysAllowReadOnly || 
						(isOutsideWorkspace && alwaysAllowReadOnlyOutsideWorkspace)
					
					if (shouldApprove) {
						// Auto-approve tool calls when auto-approval is enabled with appropriate permissions
						provider?.log(
							`[Task#ask] E2E mode: Auto-approving tool call (autoApprovalEnabled=${autoApprovalEnabled}, alwaysAllowWrite=${alwaysAllowWrite}, alwaysAllowReadOnly=${alwaysAllowReadOnly}, isOutsideWorkspace=${isOutsideWorkspace}, alwaysAllowReadOnlyOutsideWorkspace=${alwaysAllowReadOnlyOutsideWorkspace}) - Task: ${this.taskId}`
						)
						this.handleWebviewAskResponse("yesButtonClicked")
					} else {
						// Tool call requires approval but we don't have permission - abort
						const errorMessage = `Blocked Task#ask in e2e mode: ${type} (outsideWorkspace=${isOutsideWorkspace}, no permission)`
						provider?.log(`[Task#ask] E2E mode: ${errorMessage} - Task: ${this.taskId}`)
						this.e2eBlockedAskAbort = { type }
						await this.abortTask()
						throw new Error(errorMessage)
					}
				}
			} else if (type === "command" && autoApprovalEnabled && alwaysAllowExecute) {
				// Auto-approve command execution when auto-approval is enabled with execute permission
				provider?.log(
					`[Task#ask] E2E mode: Auto-approving command execution (autoApprovalEnabled=${autoApprovalEnabled}, alwaysAllowExecute=${alwaysAllowExecute}) - Task: ${this.taskId}`
				)
				this.handleWebviewAskResponse("yesButtonClicked")
			} else if (type === "command_output" && autoApprovalEnabled && alwaysAllowExecute) {
				// Auto-approve command output display when auto-approval is enabled with execute permission
				provider?.log(
					`[Task#ask] E2E mode: Auto-approving command_output display (autoApprovalEnabled=${autoApprovalEnabled}, alwaysAllowExecute=${alwaysAllowExecute}) - Task: ${this.taskId}`
				)
				this.handleWebviewAskResponse("yesButtonClicked")
			} else if (type === "mistake_limit_reached") {
				// Auto-reset mistake count in e2e mode to allow continuation
				provider?.log(
					`[Task#ask] E2E mode: Auto-resetting mistake limit (consecutiveMistakeCount=${this.consecutiveMistakeCount}) - Task: ${this.taskId}`
				)
				this.consecutiveMistakeCount = 0
				this.setMessageResponse("Continue")
			} else if (type === "completion_result") {
				// Auto-approve completion_result in e2e mode to allow task completion
				provider?.log(
					`[Task#ask] E2E mode: Auto-approving completion_result - Task: ${this.taskId}`
				)
				this.handleWebviewAskResponse("yesButtonClicked")
			} else if (type === "api_req_failed" && autoApprovalEnabled) {
				// Auto-approve api_req_failed in e2e mode to allow automatic retry
				// The test handler will still catch this and can fail fast if needed
				provider?.log(
					`[Task#ask] E2E mode: Auto-approving api_req_failed (will retry automatically) - Task: ${this.taskId}`
				)
				this.handleWebviewAskResponse("yesButtonClicked")
			} else if (type === "resume_task" || type === "resume_completed_task") {
				// Auto-approve resume asks in e2e mode - these shouldn't happen in tests but handle gracefully
				provider?.log(
					`[Task#ask] E2E mode: Auto-approving ${type} - Task: ${this.taskId}`
				)
				this.handleWebviewAskResponse("yesButtonClicked")
			} else if (type === "browser_action_launch" && autoApprovalEnabled) {
				// Auto-approve browser actions in e2e mode if auto-approval is enabled
				provider?.log(
					`[Task#ask] E2E mode: Auto-approving browser_action_launch - Task: ${this.taskId}`
				)
				this.handleWebviewAskResponse("yesButtonClicked")
			} else if (type === "use_mcp_server" && autoApprovalEnabled) {
				// Auto-approve MCP server usage in e2e mode if auto-approval is enabled
				provider?.log(
					`[Task#ask] E2E mode: Auto-approving use_mcp_server - Task: ${this.taskId}`
				)
				this.handleWebviewAskResponse("yesButtonClicked")
			} else if (type === "auto_approval_max_req_reached") {
				// In E2E mode, ignore auto-approval limits and continue
				provider?.log(
					`[Task#ask] E2E mode: Ignoring auto_approval_max_req_reached - Task: ${this.taskId}`
				)
				this.setMessageResponse("Continue")
			} else {
				// For ALL other blocking ask types in e2e mode: abort immediately
				const errorMessage = `Blocked Task#ask in e2e mode: ${type}`
				provider?.log(`[Task#ask] E2E mode: ${errorMessage} - Task: ${this.taskId}`)
				// Mark this as an e2e blocked ask abort (for parent task detection)
				this.e2eBlockedAskAbort = { type }
				// Abort the task immediately
				await this.abortTask()
				throw new Error(errorMessage)
			}
		}

		// Wait for askResponse to be set.
		await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })

		if (this.lastMessageTs !== askTs) {
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new Error("Current ask promise was ignored")
		}

		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined

		// Cancel the timeouts if they are still running.
		statusMutationTimeouts.forEach((timeout) => clearTimeout(timeout))

		// Switch back to an active state.
		if (this.idleAsk || this.resumableAsk || this.interactiveAsk) {
			this.idleAsk = undefined
			this.resumableAsk = undefined
			this.interactiveAsk = undefined
			this.emit(RooCodeEventName.TaskActive, this.taskId)
		}

		this.emit(RooCodeEventName.TaskAskResponded)
		return result
	}

	public setMessageResponse(text: string, images?: string[]) {
		this.handleWebviewAskResponse("messageResponse", text, images)
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images

		// Create a checkpoint whenever the user sends a message.
		// Use allowEmpty=true to ensure a checkpoint is recorded even if there are no file changes.
		// Suppress the checkpoint_saved chat row for this particular checkpoint to keep the timeline clean.
		if (askResponse === "messageResponse") {
			void this.checkpointSave(false, true)
		}

		// Mark the last follow-up question as answered
		if (askResponse === "messageResponse" || askResponse === "yesButtonClicked") {
			// Find the last unanswered follow-up message using findLastIndex
			const lastFollowUpIndex = findLastIndex(
				this.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "followup" && !msg.isAnswered,
			)

			if (lastFollowUpIndex !== -1) {
				// Mark this follow-up as answered
				this.clineMessages[lastFollowUpIndex].isAnswered = true
				// Save the updated messages
				this.saveClineMessages().catch((error) => {
					console.error("Failed to save answered follow-up state:", error)
				})
			}
		}
	}

	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("yesButtonClicked", text, images)
	}

	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("noButtonClicked", text, images)
	}

	public async submitUserMessage(
		text: string,
		images?: string[],
		mode?: string,
		providerProfile?: string,
	): Promise<void> {
		try {
			text = (text ?? "").trim()
			images = images ?? []

			if (text.length === 0 && images.length === 0) {
				return
			}

			const provider = this.providerRef.deref()

			if (provider) {
				if (mode) {
					await provider.setMode(mode)
				}

				if (providerProfile) {
					await provider.setProviderProfile(providerProfile)
				}

				this.emit(RooCodeEventName.TaskUserMessage, this.taskId)

				provider.postMessageToWebview({ type: "invoke", invoke: "sendMessage", text, images })
			} else {
				console.error("[Task#submitUserMessage] Provider reference lost")
			}
		} catch (error) {
			console.error("[Task#submitUserMessage] Failed to submit user message:", error)
		}
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	public async condenseContext(): Promise<void> {
		const systemPrompt = await this.getSystemPrompt()

		// Get condensing configuration
		const state = await this.providerRef.deref()?.getState()
		// These properties may not exist in the state type yet, but are used for condensing configuration
		const customCondensingPrompt = state?.customCondensingPrompt
		const condensingApiConfigId = state?.condensingApiConfigId
		const listApiConfigMeta = state?.listApiConfigMeta

		// Determine API handler to use
		let condensingApiHandler: ApiHandler | undefined
		if (condensingApiConfigId && listApiConfigMeta && Array.isArray(listApiConfigMeta)) {
			// Find matching config by ID
			const matchingConfig = listApiConfigMeta.find((config) => config.id === condensingApiConfigId)
			if (matchingConfig) {
				const profile = await this.providerRef.deref()?.providerSettingsManager.getProfile({
					id: condensingApiConfigId,
				})
				// Ensure profile and apiProvider exist before trying to build handler
				if (profile && profile.apiProvider) {
					condensingApiHandler = buildApiHandler(profile)
				}
			}
		}

		const { contextTokens: prevContextTokens } = this.getTokenUsage()

		const {
			messages,
			summary,
			cost,
			newContextTokens = 0,
			error,
		} = await summarizeConversation(
			this.apiConversationHistory,
			this.api, // Main API handler (fallback)
			systemPrompt, // Default summarization prompt (fallback)
			this.taskId,
			prevContextTokens,
			false, // manual trigger
			customCondensingPrompt, // User's custom prompt
			condensingApiHandler, // Specific handler for condensing
		)
		if (error) {
			this.say(
				"condense_context_error",
				error,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
			)
			return
		}
		await this.overwriteApiConversationHistory(messages)

		// Set flag to skip previous_response_id on the next API call after manual condense
		this.skipPrevResponseIdOnce = true

		const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
		await this.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			false /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
			contextCondense,
		)
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
			metadata?: Record<string, unknown>
		} = {},
		contextCondense?: ContextCondense,
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[RooCode#say] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
						metadata: options.metadata,
					})
				}
			} else {
				// New now have a complete version of a previously partial message.
				// This is the complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.lastMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					if (options.metadata) {
						// Add metadata to the message
						const messageWithMetadata = lastMessage as ClineMessage & ClineMessageWithMetadata
						if (!messageWithMetadata.metadata) {
							messageWithMetadata.metadata = {}
						}
						Object.assign(messageWithMetadata.metadata, options.metadata)
					}

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages()

					// More performant than an entire `postStateToWebview`.
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						contextCondense,
						metadata: options.metadata,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = Date.now()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options.isNonInteractive) {
				this.lastMessageTs = sayTs
			}

			await this.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
			})
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		const errorMsg = formatResponse.missingToolParameterError(paramName, toolName)
		await this.say(
			"error",
			`Roo tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(errorMsg)
	}

	// Lifecycle
	// Start / Resume / Abort / Dispose

	/**
	 * Detects if a request is a simple informational query that doesn't need planner mode.
	 * Simple requests include: explain, describe, what does, show me, tell me, etc.
	 */
	private isSimpleRequest(task: string): boolean {
		const normalizedTask = task.toLowerCase().trim()
		
		// Patterns that indicate simple informational requests
		const simplePatterns = [
			/^explain\s+/i,
			/^what\s+(does|is|are|do)\s+/i,
			/^describe\s+/i,
			/^show\s+me\s+/i,
			/^tell\s+me\s+/i,
			/^help\s+me\s+understand\s+/i,
			/^can\s+you\s+explain\s+/i,
			/^what\s+is\s+the\s+purpose\s+of\s+/i,
			/^what\s+does\s+this\s+(code|file|function|class)\s+do/i,
			/^how\s+does\s+this\s+(code|file|function|class)\s+work/i,
		]
		
		// Check if task matches any simple pattern
		for (const pattern of simplePatterns) {
			if (pattern.test(normalizedTask)) {
				return true
			}
		}
		
		// Also check if it's a very short request (likely a simple question)
		// But only if it doesn't contain action verbs that suggest complex tasks
		const actionVerbs = ['implement', 'create', 'add', 'fix', 'refactor', 'update', 'modify', 'build', 'write', 'generate']
		const hasActionVerb = actionVerbs.some(verb => normalizedTask.includes(verb))
		
		if (normalizedTask.length < 50 && !hasActionVerb) {
			// Very short requests without action verbs are likely simple
			return true
		}
		
		return false
	}

	/**
	 * Comprehensive heuristic-based complexity detector.
	 * Uses multiple signals to determine if a task likely requires multi-agent planning.
	 * Returns an object with complexity score and reasoning.
	 */
	private detectTaskComplexity(task: string): { isComplex: boolean; confidence: "high" | "medium" | "low"; reasons: string[] } {
		if (!task) {
			return { isComplex: false, confidence: "high", reasons: [] }
		}

		const normalizedTask = task.toLowerCase().trim()
		const reasons: string[] = []
		let complexityScore = 0

		// HEURISTIC 1: Multiple explicit file mentions
		// Pattern: file paths, extensions, or "file" keyword with numbers
		const filePathPattern = /(?:^|\s)(?:\.\/)?[\w\/\-\.]+\.(?:py|ts|js|tsx|jsx|java|go|rs|cpp|c|h|md|txt|json|yaml|yml|xml|html|css|rb|php|swift|kt|scala|r|m|mm|pl|sh|bat|ps1)(?:\s|$)/gi
		const fileMatches = normalizedTask.match(filePathPattern) || []
		const fileCount = fileMatches.length
		
		// Also count explicit mentions of "file" with numbers or lists
		const fileMentions = (normalizedTask.match(/\d+\s+files?|files?.*\d+|file.*file|multiple\s+files?|several\s+files?|many\s+files?/gi) || []).length
		const totalFileSignals = fileCount + fileMentions
		
		if (totalFileSignals >= 3) {
			complexityScore += 3
			reasons.push(`Mentions ${totalFileSignals} file(s) explicitly`)
		} else if (totalFileSignals >= 2) {
			complexityScore += 2
			reasons.push(`Mentions ${totalFileSignals} file(s)`)
		} else if (totalFileSignals >= 1) {
			complexityScore += 1
		}

		// HEURISTIC 2: Multi-step operations and coordination keywords
		const multiStepKeywords = [
			// Coordination verbs
			'and then', 'then', 'after that', 'followed by', 'subsequently',
			'first.*then', 'step 1', 'step 2', 'step one', 'step two',
			// Multi-action coordination
			'implement and test', 'code and document', 'write and review',
			'create and test', 'add and verify', 'build and deploy',
			'refactor and test', 'migrate and verify', 'update and test',
			// Parallel work indicators
			'in parallel', 'simultaneously', 'at the same time', 'concurrently',
			// Sequential work
			'sequentially', 'one by one', 'in order', 'step by step',
		]
		
		const multiStepMatches = multiStepKeywords.filter(keyword => {
			const regex = new RegExp(keyword.replace(/\*/g, '.*'), 'gi')
			return regex.test(normalizedTask)
		}).length
		
		if (multiStepMatches > 0) {
			complexityScore += 2 * multiStepMatches
			reasons.push(`Contains ${multiStepMatches} multi-step coordination signal(s)`)
		}

		// HEURISTIC 3: Large-scale operation keywords
		const largeScaleKeywords = [
			'refactor', 'refactoring', 'restructure', 'restructuring',
			'migrate', 'migration', 'convert', 'conversion',
			'reorganize', 'reorganization', 'restructure',
			'replace all', 'update all', 'modify all', 'change all',
			'across the', 'throughout the', 'entire codebase', 'whole project',
			'all files', 'every file', 'all modules', 'all components',
			'codebase-wide', 'project-wide', 'system-wide',
			'major', 'comprehensive', 'extensive', 'large-scale',
		]
		
		const largeScaleMatches = largeScaleKeywords.filter(keyword => normalizedTask.includes(keyword)).length
		if (largeScaleMatches > 0) {
			complexityScore += 3 * largeScaleMatches
			reasons.push(`Contains ${largeScaleMatches} large-scale operation keyword(s)`)
		}

		// HEURISTIC 4: Multiple components/modules/features mentioned
		const componentPatterns = [
			/\d+\s+(?:modules?|components?|features?|parts?|sections?|areas?)/gi,
			/multiple\s+(?:modules?|components?|features?|parts?|sections?)/gi,
			/several\s+(?:modules?|components?|features?|parts?)/gi,
			/many\s+(?:modules?|components?|features?|parts?)/gi,
			/all\s+(?:modules?|components?|features?|parts?)/gi,
			/every\s+(?:module|component|feature|part)/gi,
		]
		
		const componentMatches = componentPatterns.filter(pattern => pattern.test(normalizedTask)).length
		if (componentMatches > 0) {
			complexityScore += 2 * componentMatches
			reasons.push(`Mentions multiple components/modules`)
		}

		// HEURISTIC 5: Multiple agent types implicitly required
		const agentTypeKeywords = [
			// Coder + Tester
			'code and test', 'implement and test', 'write and test',
			'create and test', 'add and test', 'build and test',
			// Coder + Reviewer
			'code and review', 'implement and review', 'write and review',
			'create and review', 'add and review',
			// Coder + Documentation
			'code and document', 'implement and document', 'write and document',
			'create and document', 'add documentation',
			// All three
			'code, test, and', 'implement, test, and', 'write, test, and review',
			// Reviewer + Tester
			'review and test', 'review all test', 'test and review',
		]
		
		const agentTypeMatches = agentTypeKeywords.filter(keyword => normalizedTask.includes(keyword)).length
		if (agentTypeMatches > 0) {
			complexityScore += 2 * agentTypeMatches
			reasons.push(`Requires ${agentTypeMatches} different agent type(s)`)
		}

		// HEURISTIC 6: Explicit dependency language
		const dependencyKeywords = [
			'depends on', 'dependent on', 'requires.*first', 'must.*before',
			'after.*then', 'once.*then', 'when.*then', 'if.*then',
			'prerequisite', 'precondition', 'before.*can', 'must.*before',
			'order matters', 'sequence', 'chain', 'pipeline',
		]
		
		const dependencyMatches = dependencyKeywords.filter(keyword => {
			const regex = new RegExp(keyword.replace(/\*/g, '.*'), 'gi')
			return regex.test(normalizedTask)
		}).length
		
		if (dependencyMatches > 0) {
			complexityScore += 2 * dependencyMatches
			reasons.push(`Contains ${dependencyMatches} dependency signal(s)`)
		}

		// HEURISTIC 7: Multiple action verbs (indicates multi-step work)
		const actionVerbs = [
			'implement', 'create', 'add', 'fix', 'refactor', 'update', 'modify',
			'build', 'write', 'generate', 'remove', 'delete', 'replace',
			'migrate', 'convert', 'restructure', 'reorganize', 'rewrite',
			'test', 'review', 'document', 'verify', 'validate', 'check',
		]
		
		const verbCount = actionVerbs.filter(verb => {
			// Use word boundaries to avoid partial matches
			const regex = new RegExp(`\\b${verb}\\w*\\b`, 'gi')
			return regex.test(normalizedTask)
		}).length
		
		if (verbCount >= 3) {
			complexityScore += 2
			reasons.push(`Contains ${verbCount} different action verbs`)
		} else if (verbCount >= 2) {
			complexityScore += 1
		}

		// HEURISTIC 8: Task length and structure (very long tasks are often complex)
		if (normalizedTask.length > 200) {
			complexityScore += 1
			reasons.push(`Task is very long (${normalizedTask.length} chars)`)
		}

		// HEURISTIC 9: List-like structures (numbered lists, bullet points, "and" chains)
		const listPatterns = [
			/\d+\.\s+/g,  // Numbered list
			/-\s+/g,      // Bullet points
			/\*\s+/g,     // Asterisk bullets
			/,\s+and\s+/gi,  // Comma-separated with "and"
			/;\s+/g,      // Semicolon-separated
		]
		
		const listMatches = listPatterns.reduce((count, pattern) => {
			const matches = normalizedTask.match(pattern) || []
			return count + matches.length
		}, 0)
		
		if (listMatches >= 3) {
			complexityScore += 2
			reasons.push(`Contains list-like structure (${listMatches} items)`)
		} else if (listMatches >= 2) {
			complexityScore += 1
		}

		// HEURISTIC 10: Review/audit operations (often need multiple reviewers)
		const reviewKeywords = [
			'review all', 'review every', 'audit all', 'check all',
			'review.*files', 'review.*test', 'review.*code',
			'comprehensive review', 'full review', 'complete review',
			'code review', 'test review', 'documentation review',
		]
		
		const reviewMatches = reviewKeywords.filter(keyword => {
			const regex = new RegExp(keyword.replace(/\*/g, '.*'), 'gi')
			return regex.test(normalizedTask)
		}).length
		
		if (reviewMatches > 0 && (fileCount >= 2 || normalizedTask.includes('all') || normalizedTask.includes('every'))) {
			complexityScore += 2
			reasons.push(`Review operation with multiple targets`)
		}

		// HEURISTIC 11: Testing operations (often need multiple test files)
		const testKeywords = [
			'test all', 'test every', 'all tests', 'every test',
			'write tests for', 'add tests for', 'create tests for',
			'test coverage', 'test suite', 'test cases',
		]
		
		const testMatches = testKeywords.filter(keyword => normalizedTask.includes(keyword)).length
		if (testMatches > 0 && (fileCount >= 2 || normalizedTask.includes('all') || normalizedTask.includes('every'))) {
			complexityScore += 2
			reasons.push(`Testing operation with multiple targets`)
		}

		// HEURISTIC 12: Database/persistence operations (often multi-file)
		const dbKeywords = [
			'add.*persistence', 'add.*database', 'sqlite', 'postgres', 'mysql',
			'database.*backend', 'persistence.*layer', 'data.*storage',
			'migration.*database', 'schema.*change',
		]
		
		const dbMatches = dbKeywords.filter(keyword => {
			const regex = new RegExp(keyword.replace(/\*/g, '.*'), 'gi')
			return regex.test(normalizedTask)
		}).length
		
		if (dbMatches > 0) {
			complexityScore += 2
			reasons.push(`Database/persistence operation (typically multi-file)`)
		}

		// Determine final complexity
		const isComplex = complexityScore >= 3
		let confidence: "high" | "medium" | "low" = "low"
		
		if (complexityScore >= 6) {
			confidence = "high"
		} else if (complexityScore >= 4) {
			confidence = "medium"
		}

		return { isComplex, confidence, reasons }
	}

	/**
	 * Generates context for implementation tasks by finding and reading relevant files.
	 * When a task mentions implementing something (e.g., "implementing ResultStore"),
	 * this function will try to find and read the interface/protocol definition
	 * and any existing implementations to provide context to the LLM.
	 */
	private async generateImplementationContext(task: string): Promise<string> {
		const provider = this.providerRef.deref()
		
		provider?.log(`[Task#generateImplementationContext] Starting context generation for task (${task.length} chars)`)
		
		// Detect if this is an implementation task
		const implementationPatterns = [
			/implement(?:ing|s)?\s+(?:a\s+)?(\w+)/i,
			/create\s+(?:a\s+)?(\w+)\s+(?:class|implementation|backend|store)/i,
			/add\s+(?:a\s+)?(\w+)\s+(?:backend|store|implementation)/i,
			/(\w+)\s+implement(?:ation|ing)/i,
			/implementing\s+`?(\w+)`?/i,
		]

		const matches: string[] = []
		for (const pattern of implementationPatterns) {
			const match = task.match(pattern)
			if (match && match[1]) {
				provider?.log(`[Task#generateImplementationContext] Pattern matched: ${match[1]}`)
				matches.push(match[1])
			}
		}

		// Also extract quoted identifiers like `ResultStore` or "ResultStore"
		const quotedPattern = /[`"'](\w+)[`"']/g
		let quotedMatch
		while ((quotedMatch = quotedPattern.exec(task)) !== null) {
			if (quotedMatch[1] && !matches.includes(quotedMatch[1])) {
				provider?.log(`[Task#generateImplementationContext] Quoted identifier found: ${quotedMatch[1]}`)
				matches.push(quotedMatch[1])
			}
		}
		
		// Extract module paths like txn_demo.store.build_store - look for the parent module
		const modulePathPattern = /(\w+(?:\.\w+)+)\s*\(/g
		let moduleMatch
		while ((moduleMatch = modulePathPattern.exec(task)) !== null) {
			const parts = moduleMatch[1].split(".")
			// Add the last few parts as potential identifiers to search for
			for (const part of parts.slice(-2)) {
				if (part && !matches.includes(part) && part.length > 2) {
					provider?.log(`[Task#generateImplementationContext] Module part found: ${part}`)
					matches.push(part)
				}
			}
		}
		
		// For "ResultStore" specifically - common patterns
		if (task.toLowerCase().includes("resultstore") && !matches.includes("ResultStore")) {
			provider?.log(`[Task#generateImplementationContext] Adding ResultStore from keyword match`)
			matches.push("ResultStore")
		}
		if (task.toLowerCase().includes("store") && !matches.includes("store")) {
			provider?.log(`[Task#generateImplementationContext] Adding store from keyword match`)
			matches.push("store")
		}
		
		provider?.log(`[Task#generateImplementationContext] Total matches: ${matches.join(", ")}`)

		if (matches.length === 0) {
			return ""
		}

		provider?.log(`[Task#generateImplementationContext] Detected implementation task for: ${matches.join(", ")}`)

		// Try to find relevant files containing these identifiers
		const contextParts: string[] = []
		const fs = await import("fs/promises")
		const path = await import("path")

		for (const identifier of matches) {
			try {
				// Use glob to find files that might contain the interface/class definition
				const { listFiles } = await import("../../services/glob/list-files")
				const [allFiles] = await listFiles(this.cwd, false, 500)
				
				// Filter to source files that might contain the definition
				const sourceExtensions = [".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".go", ".rs", ".cs"]
				const sourceFiles = allFiles.filter(f => 
					sourceExtensions.some(ext => f.endsWith(ext)) &&
					!f.includes("node_modules") &&
					!f.includes("__pycache__") &&
					!f.includes(".git")
				)

				// Search for files containing the identifier as a class/interface/protocol
				for (const file of sourceFiles.slice(0, 100)) { // Limit to first 100 files
					try {
						const fullPath = path.join(this.cwd, file)
						const content = await fs.readFile(fullPath, "utf-8")
						
						// Check if this file defines the identifier we're looking for
						const definitionPatterns = [
							new RegExp(`class\\s+${identifier}\\s*[:\\(\\{]`, "i"),
							new RegExp(`interface\\s+${identifier}\\s*[:\\{<]`, "i"),
							new RegExp(`protocol\\s+${identifier}\\s*[:\\(\\{]`, "i"),
							new RegExp(`class\\s+${identifier}\\s*\\(Protocol\\)`, "i"),
							new RegExp(`type\\s+${identifier}\\s*=`, "i"),
							new RegExp(`abstract\\s+class\\s+${identifier}`, "i"),
						]

						// Also match if the filename contains the identifier (e.g., "store" matches "store.py")
						const fileBaseName = file.split("/").pop()?.split("\\").pop()?.replace(/\.\w+$/, "") || ""
						const isFileNameMatch = fileBaseName.toLowerCase() === identifier.toLowerCase()
						
						// Check for Protocol definitions in Python files
						const hasProtocolDefinition = content.includes("(Protocol)") || content.includes("Protocol[")

						const isDefinition = definitionPatterns.some(p => p.test(content)) || 
							(isFileNameMatch && hasProtocolDefinition)
						
						if (isDefinition) {
							provider?.log(`[Task#generateImplementationContext] Found definition for ${identifier} in ${file}`)
							contextParts.push(`<relevant_file path="${file}" reason="Contains ${identifier} definition">
${content.slice(0, 5000)}${content.length > 5000 ? "\n... (truncated)" : ""}
</relevant_file>`)
							break // Found the definition, no need to keep searching
						}
					} catch {
						// Skip files that can't be read
					}
				}
			} catch (error) {
				provider?.log(`[Task#generateImplementationContext] Error searching for ${identifier}: ${error}`)
			}
		}

		if (contextParts.length === 0) {
			return ""
		}

		return `<implementation_context>
⚠️ CRITICAL: READ THIS CAREFULLY BEFORE IMPLEMENTING ⚠️

The following files contain the EXACT interface/protocol/class definitions you MUST conform to:

${contextParts.join("\n\n")}

MANDATORY REQUIREMENTS:
1. Your implementation MUST match the EXACT method signatures shown above
2. If the interface defines \`put(self, r: SequenceResult)\`, you MUST implement \`put(self, r: SequenceResult)\` - NOT \`put(self, name, n, value)\`
3. If the interface defines \`get(self, name: str, n: int) -> SequenceResult | None\`, you MUST return a SequenceResult object, NOT just a value
4. Study the existing implementations (like InMemoryStore) to understand the expected patterns
5. Import all required types from the same module
6. Your tests MUST use the same API signatures as the interface

DO NOT invent your own API - match the existing interface EXACTLY.
</implementation_context>`
	}

	private logApiConfigSummary() {
		const summary = this.getApiConfigSummary()
		const baseUrl = summary.baseUrl || "default"
		const keyField = summary.keyField || "n/a"
		this.providerRef
			.deref()
			?.log(
				`[Task#config] Provider: ${summary.provider}, Model: ${summary.modelId}, BaseURL: ${baseUrl}, KeyField: ${keyField}, KeyPresent: ${summary.keyPresent}`,
			)
	}

	private getApiConfigSummary() {
		const provider = this.apiConfiguration.apiProvider || "unknown"
		const modelId = getModelId(this.apiConfiguration) || "unknown"
		const settings = this.apiConfiguration as any

		const baseUrlByProvider: Record<string, string | undefined> = {
			openrouter: settings.openRouterBaseUrl,
			openai: settings.openAiBaseUrl,
			"openai-native": settings.openAiNativeBaseUrl,
			gemini: settings.googleGeminiBaseUrl,
			anthropic: settings.anthropicBaseUrl,
			requesty: settings.requestyBaseUrl,
			deepinfra: settings.deepInfraBaseUrl,
			litellm: settings.litellmBaseUrl,
			ollama: settings.ollamaBaseUrl,
			"lm-studio": settings.lmStudioBaseUrl,
			deepseek: settings.deepSeekBaseUrl,
			moonshot: settings.moonshotBaseUrl,
			doubao: settings.doubaoBaseUrl,
		}

		const keyFieldByProvider: Record<string, string> = {
			openrouter: "openRouterApiKey",
			openai: "openAiApiKey",
			"openai-native": "openAiNativeApiKey",
			gemini: "geminiApiKey",
			anthropic: "anthropicApiKey",
			requesty: "requestyApiKey",
			deepinfra: "deepInfraApiKey",
			litellm: "litellmApiKey",
			groq: "groqApiKey",
			xai: "xaiApiKey",
			mistral: "mistralApiKey",
			moonshot: "moonshotApiKey",
			cerebras: "cerebrasApiKey",
			glama: "glamaApiKey",
			huggingface: "huggingFaceApiKey",
			"lm-studio": "lmStudioApiKey",
			ollama: "ollamaApiKey",
			deepseek: "deepSeekApiKey",
			doubao: "doubaoApiKey",
		}

		let keyField = keyFieldByProvider[provider]
		let keyPresent = false
		if (provider === "vertex") {
			keyField = "vertexJsonCredentials/vertexKeyFile"
			keyPresent = Boolean(settings.vertexJsonCredentials || settings.vertexKeyFile)
		} else if (provider === "bedrock") {
			keyField = "awsAccessKeyId"
			keyPresent = Boolean(settings.awsAccessKeyId)
		} else if (keyField) {
			keyPresent = Boolean(settings[keyField])
		}

		const baseUrl = baseUrlByProvider[provider] ?? settings.baseUrl

		return { provider, modelId, baseUrl, keyField, keyPresent }
	}

	private getHeaderValue(headers: unknown, headerName: string): string | undefined {
		if (!headers) {
			return undefined
		}
		const target = headerName.toLowerCase()
		if (typeof (headers as any).get === "function") {
			return (headers as any).get(headerName) ?? (headers as any).get(target)
		}
		if (typeof headers === "object") {
			for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
				if (key.toLowerCase() === target) {
					return typeof value === "string" ? value : JSON.stringify(value)
				}
			}
		}
		return undefined
	}

	private redactSensitive(value: string): string {
		return value
			.replace(/sk-[a-zA-Z0-9_-]{10,}/g, "sk-***REDACTED***")
			.replace(/gsk_[a-zA-Z0-9_-]{10,}/g, "gsk_***REDACTED***")
			.replace(/AIza[0-9A-Za-z_-]{10,}/g, "AIza***REDACTED***")
			.replace(/Bearer\s+[a-zA-Z0-9._-]{10,}/gi, "Bearer ***REDACTED***")
	}

	private formatErrorBody(value: unknown, maxLength = 2000): string | undefined {
		if (value === undefined || value === null) {
			return undefined
		}
		const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2)
		const redacted = this.redactSensitive(raw)
		return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...(truncated)` : redacted
	}

	private extractApiErrorDetails(error: unknown) {
		const root: any = (error as any)?.cause ?? error
		const response = root?.response
		const status = root?.status ?? root?.statusCode ?? response?.status ?? root?.$metadata?.httpStatusCode
		const statusText = response?.statusText
		const url = response?.config?.url ?? root?.config?.url ?? root?.request?.url
		const method = response?.config?.method ?? root?.config?.method
		const requestId =
			root?.requestId ??
			root?.request_id ??
			root?.$metadata?.requestId ??
			this.getHeaderValue(response?.headers, "x-request-id") ??
			this.getHeaderValue(response?.headers, "x-amzn-requestid")
		const bodyRaw = response?.data ?? root?.error?.metadata?.raw ?? root?.error?.data ?? root?.body
		const body = this.formatErrorBody(bodyRaw)
		const message = root?.message ?? String(root)
		const retryable = Boolean(
			isRateLimitError(error) ||
				(status !== undefined && (status === 408 || status === 409 || status === 429 || status >= 500)),
		)

		return { status, statusText, url, method, requestId, body, message, retryable }
	}

	private async logApiFailure(error: unknown, provider: string, modelId: string, endpoint: string) {
		const summary = this.getApiConfigSummary()
		const details = this.extractApiErrorDetails(error)
		const payload = {
			timestamp: new Date().toISOString(),
			taskId: this.taskId,
			provider,
			modelId,
			endpoint,
			baseUrl: summary.baseUrl || "default",
			keyPresent: summary.keyPresent,
			...details,
		}

		try {
			this.providerRef.deref()?.log(`[LLM] API failure details: ${JSON.stringify(payload)}`)
		} catch {
			// Ignore logging errors
		}

		try {
			if (this.globalStoragePath) {
				await fs.mkdir(this.globalStoragePath, { recursive: true })
				const logPath = path.join(this.globalStoragePath, "api_failures.log")
				await fs.appendFile(logPath, `${JSON.stringify(payload)}\n`, "utf8")
			}
		} catch {
			// Ignore persistence errors
		}
	}

	private async startTask(task?: string, images?: string[]): Promise<void> {
		if (this.enableBridge) {
			try {
				await BridgeOrchestrator.subscribeToTask(this)
			} catch (error) {
				console.error(
					`[Task#startTask] BridgeOrchestrator.subscribeToTask() failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		// `conversationHistory` (for API) and `clineMessages` (for webview)
		// need to be in sync.
		// If the extension process were killed, then on restart the
		// `clineMessages` might not be empty, so we need to set it to [] when
		// we create a new Cline client (otherwise webview would show stale
		// messages from previous session).
		this.clineMessages = []
		this.apiConversationHistory = []

		// The todo list is already set in the constructor if initialTodos were provided
		// No need to add any messages - the todoList property is already set

		await this.providerRef.deref()?.postStateToWebview()

		// task parameter contains the prompt (enhanced for subtasks, original for user tasks)
		await this.say("text", task, images)
		this.isInitialized = true

		// Calculate nesting depth to prevent infinite recursion
		// Allow subtasks to use planner mode if they're complex enough, but limit depth
		let nestingDepth = 0
		let current: Task | undefined = this.parentTask
		while (current) {
			nestingDepth++
			current = current.parentTask
		}
		const MAX_PLANNER_DEPTH = 2 // Allow up to 2 levels of nested planning
		const isSubtask = this.parentTask !== undefined
		const exceedsMaxDepth = nestingDepth >= MAX_PLANNER_DEPTH

		// Check if planner mode is enabled (read from configuration)
		const cfg = vscode.workspace.getConfiguration()
		const plannerModeEnabled = cfg.get<boolean>("roo.experimental.plannerMode") || cfg.get<boolean>("roo-cline.experimental.plannerMode")
		
		// Allow planner mode for:
		// 1. Root tasks (not subtasks)
		// 2. Subtasks that are complex enough to need their own plan, but haven't exceeded max depth
		const plannerMode = plannerModeEnabled && !exceedsMaxDepth

		// Skip planner mode for simple requests (explain, describe, what does, show me)
		// These are informational queries that don't need multi-agent planning
		const isSimpleRequest = task && this.isSimpleRequest(task)

		// Log when planner mode is skipped due to depth limit
		if (plannerModeEnabled && exceedsMaxDepth && task && !isSimpleRequest) {
			this.providerRef.deref()?.log(
				`[Task#startTask] Skipping planner mode for subtask at depth ${nestingDepth} (max depth: ${MAX_PLANNER_DEPTH}). Executing directly.`
			)
		}

		// Log when a subtask uses planner mode
		if (plannerMode && isSubtask && task && !isSimpleRequest) {
			this.providerRef.deref()?.log(
				`[Task#startTask] Subtask at depth ${nestingDepth} using planner mode to break down complex work.`
			)
		}

		if (plannerMode && task && !isSimpleRequest) {
			try {
				const { PlannerAgent, shouldOpenCircuitBreaker } = await import("../planner/PlannerAgent")
				const { PlanExecutor } = await import("../planner/PlanExecutor")

				// Check circuit breaker before starting planner
				if (shouldOpenCircuitBreaker && shouldOpenCircuitBreaker()) {
					this.providerRef.deref()?.log(
						`[Task#startTask] Circuit breaker is open - skipping planner mode to prevent rate limit cascade. Falling back to normal execution.`
					)
					// Fall through to normal execution instead of throwing
				} else {
					// Pre-check: Use heuristics to detect likely complexity
					const complexityCheck = task ? this.detectTaskComplexity(task) : { isComplex: false, confidence: "low" as const, reasons: [] }
					
					if (complexityCheck.isComplex && complexityCheck.confidence === "high") {
						this.providerRef.deref()?.log(
							`[Task#startTask] Heuristics indicate HIGH confidence this task is complex: ${complexityCheck.reasons.join(", ")}`
						)
					}

					const planner = new PlannerAgent(this)
					let plan = await planner.generatePlan(task, 0, false) // First attempt: normal prompt
					this.plan = plan

					// Post-check: Validate LLM decision against heuristics
					const isEmptyPlan = !plan.subTransactions || plan.subTransactions.length === 0
					
					if (isEmptyPlan && complexityCheck.isComplex && complexityCheck.confidence !== "low") {
						// LLM returned empty plan but heuristics say it's complex - retry with stronger prompt
						this.providerRef.deref()?.log(
							`[Task#startTask] VALIDATION FAILED: LLM returned empty plan, but heuristics indicate complexity (${complexityCheck.confidence} confidence, reasons: ${complexityCheck.reasons.join(", ")}). Retrying with stronger prompt.`
						)
						
						try {
							plan = await planner.generatePlan(task, 0, true) // Retry with forceComplex flag
							this.plan = plan
							
							// Check again after retry
							if (!plan.subTransactions || plan.subTransactions.length === 0) {
								this.providerRef.deref()?.log(
									`[Task#startTask] Retry also returned empty plan. Heuristics may be incorrect, or task is genuinely simple. Proceeding with direct execution.`
								)
							} else {
								this.providerRef.deref()?.log(
									`[Task#startTask] Retry succeeded - LLM now created plan with ${plan.subTransactions.length} sub-transaction(s)`
								)
							}
						} catch (retryError) {
							const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError)
							this.providerRef.deref()?.log(
								`[Task#startTask] Retry failed: ${retryErrorMessage}. Proceeding with original empty plan.`
							)
						}
					}

					// Check if plan is empty (simple query) - fall through to normal execution
					if (!plan.subTransactions || plan.subTransactions.length === 0) {
						this.providerRef.deref()?.log(
							`[Task#startTask] Planner returned empty plan for simple query, falling through to normal execution`
						)
						// Fall through to normal execution below
					} else {
						const executor = new PlanExecutor(this)
						const result = await executor.executePlan(plan)

						if (result.success) {
							await this.say("text", "Plan executed successfully. All sub-transactions completed.")
						} else {
							await this.say(
								"text",
								`Plan execution completed with failures. Failed sub-transactions: ${result.failedSubTransactions?.join(", ") || "unknown"}`,
							)
						}

						// Planner mode execution complete
						return
					}
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				this.providerRef.deref()?.log(`[Task#startTask] Planner mode failed: ${errorMessage}`)
				
				// E2E mode: If error is due to blocked Task#ask in child, abort task immediately
				const isE2EMode = !!(process.env.TEST_TORTURE_REPO || process.env.TEST_TORTURE_REPO_WORKSPACE)
				if (isE2EMode && errorMessage.includes("Blocked Task#ask in e2e mode")) {
					this.providerRef.deref()?.log(`[Task#startTask] E2E mode: Planner failed due to blocked Task#ask - Aborting task ${this.taskId}`)
					// Abort the task immediately - do not fall through to normal execution
					await this.abortTask()
					return
				}
				
				// Cancel all spawned child tasks to prevent them from continuing to make API calls
				await this.cancelAllChildTasks()
				
				// Clean up worktrees and parent transaction
				const provider = this.providerRef.deref()
				const parentTxId = provider?.context?.globalState.get<string>("roo.current_tx_id")
				if (parentTxId && this.plan) {
					try {
						const { PlanExecutor } = await import("../planner/PlanExecutor")
						const executor = new PlanExecutor(this)
						
						// Rollback all sub-transaction worktrees to prevent orphaned worktrees
						await executor.rollbackAllSubTransactions(this.plan, parentTxId)
						
						// Clean up parent transaction
						await (executor as any).cleanupParentTransaction(parentTxId)
					} catch (cleanupError) {
						const cleanupErrorMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
						provider?.log(`[Task#startTask] Error during planner cleanup: ${cleanupErrorMessage}`)
						// Continue - don't block fallthrough to normal execution
					}
				} else if (parentTxId) {
					// No plan but we have a parent transaction - just clean it up
					try {
						const { PlanExecutor } = await import("../planner/PlanExecutor")
						const executor = new PlanExecutor(this)
						await (executor as any).cleanupParentTransaction(parentTxId)
					} catch (cleanupError) {
						// Ignore cleanup errors
					}
				}
				// Fall through to normal execution
			}
		}

		// Normal execution (existing flow)
		let imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

		// Pre-flight context injection: Add relevant file context for implementation tasks
		let contextPrefix = ""
		if (task) {
			contextPrefix = await this.generateImplementationContext(task)
		}

		// Task starting
		const taskText = contextPrefix 
			? `${contextPrefix}\n\n<task>\n${task}\n</task>`
			: `<task>\n${task}\n</task>`

		await this.initiateTaskLoop([
			{
				type: "text",
				text: taskText,
			},
			...imageBlocks,
		])
	}

	private async resumeTaskFromHistory() {
		if (this.enableBridge) {
			try {
				await BridgeOrchestrator.subscribeToTask(this)
			} catch (error) {
				console.error(
					`[Task#resumeTaskFromHistory] BridgeOrchestrator.subscribeToTask() failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		const modifiedClineMessages = await this.getSavedClineMessages()

		// Check for any stored GPT-5 response IDs in the message history.
		const gpt5Messages = modifiedClineMessages.filter(
			(m): m is ClineMessage & ClineMessageWithMetadata =>
				m.type === "say" &&
				m.say === "text" &&
				!!(m as ClineMessageWithMetadata).metadata?.gpt5?.previous_response_id,
		)

		if (gpt5Messages.length > 0) {
			const lastGpt5Message = gpt5Messages[gpt5Messages.length - 1]
			// The lastGpt5Message contains the previous_response_id that can be
			// used for continuity.
		}

		// Remove any resume messages that may have been added before.
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)

		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// Remove any trailing reasoning-only UI messages that were not part of the persisted API conversation
		while (modifiedClineMessages.length > 0) {
			const last = modifiedClineMessages[modifiedClineMessages.length - 1]
			if (last.type === "say" && last.say === "reasoning") {
				modifiedClineMessages.pop()
			} else {
				break
			}
		}

		// Since we don't use `api_req_finished` anymore, we need to check if the
		// last `api_req_started` has a cost value, if it doesn't and no
		// cancellation reason to present, then we remove it since it indicates
		// an api request without any partial content streamed.
		const lastApiReqStartedIndex = findLastIndex(
			modifiedClineMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)

		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

			if (cost === undefined && cancelReason === undefined) {
				modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.overwriteClineMessages(modifiedClineMessages)
		this.clineMessages = await this.getSavedClineMessages()

		// Now present the cline messages to the user and ask if they want to
		// resume (NOTE: we ran into a bug before where the
		// apiConversationHistory wouldn't be initialized when opening a old
		// task, and it was because we were waiting for resume).
		// This is important in case the user deletes messages without resuming
		// the task first.
		this.apiConversationHistory = await this.getSavedApiConversationHistory()

		const lastClineMessage = this.clineMessages
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // Could be multiple resume tasks.

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.isInitialized = true

		const { response, text, images } = await this.ask(askType) // Calls `postStateToWebview`.

		let responseText: string | undefined
		let responseImages: string[] | undefined

		if (response === "messageResponse") {
			await this.say("user_feedback", text, images)
			responseText = text
			responseImages = images
		}

		// Make sure that the api conversation history can be resumed by the API,
		// even if it goes out of sync with cline messages.
		let existingApiConversationHistory: ApiMessage[] = await this.getSavedApiConversationHistory()

		// v2.0 xml tags refactor caveat: since we don't use tools anymore, we need to replace all tool use blocks with a text block since the API disallows conversations with tool uses and no tool schema
		const conversationWithoutToolBlocks = existingApiConversationHistory.map((message) => {
			if (Array.isArray(message.content)) {
				const newContent = message.content.map((block) => {
					if (block.type === "tool_use") {
						// It's important we convert to the new tool schema
						// format so the model doesn't get confused about how to
						// invoke tools.
						const inputAsXml = Object.entries(block.input as Record<string, string>)
							.map(([key, value]) => `<${key}>\n${value}\n</${key}>`)
							.join("\n")
						return {
							type: "text",
							text: `<${block.name}>\n${inputAsXml}\n</${block.name}>`,
						} as Anthropic.Messages.TextBlockParam
					} else if (block.type === "tool_result") {
						// Convert block.content to text block array, removing images
						const contentAsTextBlocks = Array.isArray(block.content)
							? block.content.filter((item) => item.type === "text")
							: [{ type: "text", text: block.content }]
						const textContent = contentAsTextBlocks.map((item) => item.text).join("\n\n")
						const toolName = findToolName(block.tool_use_id, existingApiConversationHistory)
						return {
							type: "text",
							text: `[${toolName} Result]\n\n${textContent}`,
						} as Anthropic.Messages.TextBlockParam
					}
					return block
				})
				return { ...message, content: newContent }
			}
			return message
		})
		existingApiConversationHistory = conversationWithoutToolBlocks

		// FIXME: remove tool use blocks altogether

		// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
		// if there's no tool use and only a text block, then we can just add a user message
		// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

		// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

		let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[] // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: ApiMessage[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.role === "assistant") {
				const content = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				const hasToolUse = content.some((block) => block.type === "tool_use")

				if (hasToolUse) {
					const toolUseBlocks = content.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]
					const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
						type: "tool_result",
						tool_use_id: block.id,
						content: "Task was interrupted before this tool call could be completed.",
					}))
					modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
					modifiedOldUserContent = [...toolResponses]
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			} else if (lastMessage.role === "user") {
				const previousAssistantMessage: ApiMessage | undefined =
					existingApiConversationHistory[existingApiConversationHistory.length - 2]

				const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
					const assistantContent = Array.isArray(previousAssistantMessage.content)
						? previousAssistantMessage.content
						: [{ type: "text", text: previousAssistantMessage.content }]

					const toolUseBlocks = assistantContent.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]

					if (toolUseBlocks.length > 0) {
						const existingToolResults = existingUserContent.filter(
							(block) => block.type === "tool_result",
						) as Anthropic.ToolResultBlockParam[]

						const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
							.filter(
								(toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id),
							)
							.map((toolUse) => ({
								type: "tool_result",
								tool_use_id: toolUse.id,
								content: "Task was interrupted before this tool call could be completed.",
							}))

						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
						modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
					modifiedOldUserContent = [...existingUserContent]
				}
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		let newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

		const agoText = ((): string => {
			const timestamp = lastClineMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		if (responseText) {
			newUserContent.push({
				type: "text",
				text: `\n\nNew instructions for task continuation:\n<user_message>\n${responseText}\n</user_message>`,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		// Ensure we have at least some content to send to the API.
		// If newUserContent is empty, add a minimal resumption message.
		if (newUserContent.length === 0) {
			newUserContent.push({
				type: "text",
				text: "[TASK RESUMPTION] Resuming task...",
			})
		}

		await this.overwriteApiConversationHistory(modifiedApiConversationHistory)

		// Task resuming from history item.
		await this.initiateTaskLoop(newUserContent)
	}

	public async abortTask(isAbandoned = false) {
		// Aborting task

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.abandoned = true
		}

		this.abort = true
		this.emit(RooCodeEventName.TaskAborted)

		try {
			this.dispose() // Call the centralized dispose method
		} catch (error) {
			console.error(`Error during task ${this.taskId}.${this.instanceId} disposal:`, error)
			// Don't rethrow - we want abort to always succeed
		}
		// Save the countdown message in the automatic retry or other content.
		try {
			// Save the countdown message in the automatic retry or other content.
			await this.saveClineMessages()
		} catch (error) {
			console.error(`Error saving messages during abort for task ${this.taskId}.${this.instanceId}:`, error)
		}
	}

	public dispose(): void {
		console.log(`[Task#dispose] disposing task ${this.taskId}.${this.instanceId}`)

		// Dispose message queue and remove event listeners.
		try {
			if (this.messageQueueStateChangedHandler) {
				this.messageQueueService.removeListener("stateChanged", this.messageQueueStateChangedHandler)
				this.messageQueueStateChangedHandler = undefined
			}

			this.messageQueueService.dispose()
		} catch (error) {
			console.error("Error disposing message queue:", error)
		}

		// Remove all event listeners to prevent memory leaks.
		try {
			this.removeAllListeners()
		} catch (error) {
			console.error("Error removing event listeners:", error)
		}

		// Stop waiting for child task completion.
		if (this.pauseInterval) {
			clearInterval(this.pauseInterval)
			this.pauseInterval = undefined
		}

		if (this.enableBridge) {
			BridgeOrchestrator.getInstance()
				?.unsubscribeFromTask(this.taskId)
				.catch((error) =>
					console.error(
						`[Task#dispose] BridgeOrchestrator#unsubscribeFromTask() failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				)
		}

		// Release any terminals associated with this task.
		try {
			// Release any terminals associated with this task.
			TerminalRegistry.releaseTerminalsForTask(this.taskId)
		} catch (error) {
			console.error("Error releasing terminals:", error)
		}

		try {
			this.urlContentFetcher.closeBrowser()
		} catch (error) {
			console.error("Error closing URL content fetcher browser:", error)
		}

		try {
			this.browserSession.closeBrowser()
		} catch (error) {
			console.error("Error closing browser session:", error)
		}

		try {
			if (this.rooIgnoreController) {
				this.rooIgnoreController.dispose()
				this.rooIgnoreController = undefined
			}
		} catch (error) {
			console.error("Error disposing RooIgnoreController:", error)
			// This is the critical one for the leak fix.
		}

		try {
			this.fileContextTracker.dispose()
		} catch (error) {
			console.error("Error disposing file context tracker:", error)
		}

		try {
			// If we're not streaming then `abortStream` won't be called.
			if (this.isStreaming && this.diffViewProvider.isEditing) {
				this.diffViewProvider.revertChanges().catch(console.error)
			}
		} catch (error) {
			console.error("Error reverting diff changes:", error)
		}
	}

	// Subtasks
	// Spawn / Wait / Complete

	public async startSubtask(message: string, initialTodos: TodoItem[], mode: string) {
		const provider = this.providerRef.deref()

		if (!provider) {
			throw new Error("Provider not available")
		}

		// Enhance prompt using shared helper to prevent asking user for information
		const enhancedMessage = this.enhanceSubtaskPrompt(message)

		const newTask = await provider.createTask(enhancedMessage, undefined, this, { initialTodos })

		if (newTask) {
			this.isPaused = true // Pause parent.
			this.childTaskId = newTask.taskId // Backward compatibility
			this.childTaskIds.push(newTask.taskId) // Add to array

			await provider.handleModeSwitch(mode) // Set child's mode.
			await delay(500) // Allow mode change to take effect.

			this.emit(RooCodeEventName.TaskPaused, this.taskId)
			this.emit(RooCodeEventName.TaskSpawned, newTask.taskId)
		}

		return newTask
	}

	// Used when a sub-task is launched and the parent task is waiting for it to
	// finish.
	// TBD: Add a timeout to prevent infinite waiting.
	public async waitForSubtask() {
		await new Promise<void>((resolve) => {
			this.pauseInterval = setInterval(() => {
				if (!this.isPaused) {
					clearInterval(this.pauseInterval)
					this.pauseInterval = undefined
					resolve()
				}
			}, 1000)
		})
	}

	public async completeSubtask(lastMessage: string) {
		const provider = this.providerRef.deref()
		const isE2EMode = !!(process.env.TEST_TORTURE_REPO || process.env.TEST_TORTURE_REPO_WORKSPACE)
		
		if (isE2EMode) {
			provider?.log(
				`[Task#completeSubtask] E2E mode: Completing subtask and resuming parent task - Task: ${this.taskId}, Subtask result length: ${lastMessage.length}`
			)
		}
		
		this.isPaused = false
		this.childTaskId = undefined // Backward compatibility
		// Note: childTaskIds array is managed by removeChildTaskId() method

		this.emit(RooCodeEventName.TaskUnpaused, this.taskId)

		// Fake an answer from the subtask that it has completed running and
		// this is the result of what it has done add the message to the chat
		// history and to the webview ui.
		try {
			await this.say("subtask_result", lastMessage)

			await this.addToApiConversationHistory({
				role: "user",
				content: [{ type: "text", text: `[new_task completed] Result: ${lastMessage}` }],
			})

			// Set skipPrevResponseIdOnce to ensure the next API call sends the full conversation
			// including the subtask result, not just from before the subtask was created
			this.skipPrevResponseIdOnce = true
			
			if (isE2EMode) {
				provider?.log(
					`[Task#completeSubtask] E2E mode: Subtask result added to conversation, parent task should resume - Task: ${this.taskId}`
				)
			}
		} catch (error) {
			this.providerRef
				.deref()
				?.log(`Error failed to add reply from subtask into conversation of parent task, error: ${error}`)

			throw error
		}
	}

	/**
	 * Cancel all child tasks (used when planner fails to prevent cascading API calls)
	 */
	private async cancelAllChildTasks(): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider || this.childTaskIds.length === 0) {
			return
		}

		const childTaskIdsToCancel = [...this.childTaskIds] // Copy array to avoid modification during iteration
		provider.log(`[Task#cancelAllChildTasks] Cancelling ${childTaskIdsToCancel.length} child tasks due to planner failure`)

		// Cancel each child task
		for (const childTaskId of childTaskIdsToCancel) {
			try {
				const childTask = provider.getTaskById(childTaskId)
				if (childTask && !childTask.abort) {
					await childTask.abortTask(true) // true = isAbandoned
					provider.log(`[Task#cancelAllChildTasks] Cancelled child task ${childTaskId}`)
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`[Task#cancelAllChildTasks] Failed to cancel child task ${childTaskId}: ${errorMessage}`)
			}
		}

		// Clear the child task IDs array
		this.childTaskIds = []
	}

	/**
	 * Remove a child task ID from the array (used when child completes)
	 */
	public removeChildTaskId(childTaskId: string): void {
		const index = this.childTaskIds.indexOf(childTaskId)
		if (index > -1) {
			this.childTaskIds.splice(index, 1)
		}
		// Also clear single childTaskId if it matches (backward compatibility)
		if (this.childTaskId === childTaskId) {
			this.childTaskId = undefined
		}
	}

	/**
	 * Comprehensive tool call repairer - fixes ALL common mistakes automatically
	 * This ensures deterministic, error-free tool execution for research-grade systems.
	 * 
	 * Repairs:
	 * - Function-call syntax: read_file(["path"]) → <read_file><args>...</args></read_file>
	 * - Wrong case: <ReadFile> → <read_file>
	 * - Missing tags: <read_file><path>...</path> → adds </read_file> and <args> wrapper
	 * - Malformed structure: fixes missing args, file wrappers, etc.
	 */
	private repairToolCalls(text: string): string {
		// Use dynamic import to avoid circular dependencies and ensure proper module loading
		const { repairToolCalls: repair } = require("../assistant-message/toolCallRepairer")
		const result = repair(text)
		
		// Log repairs for debugging
		if (result.repaired && result.repairs.length > 0) {
			const provider = this.providerRef.deref()
			if (provider && process.env.ROO_DEBUG_TOOL_EXECUTION) {
				provider.log(
					`[Task#${this.taskId}] Tool call repairs applied:\n${result.repairs.map((r: string) => `  - ${r}`).join("\n")}`
				)
			}
		}
		
		return result.text
	}

	// Legacy function - kept for compatibility, now delegates to repairToolCalls
	private convertFunctionCallSyntaxToXml(text: string): string {
		return this.repairToolCalls(text)
	}

	/**
	 * Shared helper to enhance subtask prompts with tool usage instructions.
	 * Prevents models from asking users for information they can get via tools.
	 */
	private enhanceSubtaskPrompt(
		prompt: string,
		agentType?: string,
		fileTargetsFromSteps?: string[]
	): string {
		let enhancedPrompt = prompt || ""
		
		// ===== ALWAYS ADD CRITICAL TOOL USAGE INSTRUCTIONS (UNCONDITIONAL) =====
		// This ensures models NEVER ask users for information they can get from tools
		const criticalToolInstructions = `\n\n⚠️⚠️⚠️ CRITICAL INSTRUCTIONS FOR THIS SUBTASK ⚠️⚠️⚠️

YOU MUST USE TOOLS - DO NOT ASK THE USER FOR INFORMATION:

1. **ALWAYS use tools to gather information** - You have access to read_file, search_files, list_files, codebase_search, and execute_command tools.

2. **NEVER ask the user to:**
   - Provide file contents or paste files
   - Use "Show file" commands
   - Manually share code or information
   - Read files for you

3. **If you need file contents:**
   - Use read_file tool immediately if you know the file path
   - If you don't know the file path, use search_files or list_files first
   - **CRITICAL for search_files:** ALWAYS provide the <path> parameter - use "." for workspace root if unsure
   - Example: <search_files><path>.</path><regex>.*</regex><file_pattern>*test*.py</file_pattern></search_files>
   - Then use read_file with the discovered paths

4. **Tool format requirement:**
   - MUST use XML format: <read_file><args><file><path>file.py</path></file></args></read_file>
   - MUST use XML format: <search_files><path>.</path><regex>pattern</regex></search_files>
   - NEVER use function-call syntax: read_file(["file.py"]) ❌ or search_files({path: "src"}) ❌

5. **Your first action should be:** Use the appropriate tool (read_file, search_files, etc.) to gather the information you need, then proceed with the task.

REMEMBER: You are an autonomous agent. Use your tools. Do not ask the user for information you can obtain yourself.`
		
		// If file targets are provided from steps, add them explicitly with strong instruction
		if (fileTargetsFromSteps && fileTargetsFromSteps.length > 0) {
			enhancedPrompt = `${enhancedPrompt}\n\n📁 FILES TO WORK WITH (from plan steps):\n${fileTargetsFromSteps.map((f: string) => `- ${f}`).join("\n")}\n\n🚨 ACTION REQUIRED: You MUST use read_file tool NOW to read these files. Do NOT ask the user. Start immediately with:\n<read_file>\n<args>\n${fileTargetsFromSteps.slice(0, 5).map(f => `  <file>\n    <path>${f}</path>\n  </file>`).join("\n")}\n</args>\n</read_file>`
		}
		
		// Check if prompt contains file-like paths (has / or common extensions)
		const hasFilePaths = /\/|\.(py|ts|js|tsx|jsx|java|go|rs|cpp|c|h|md|txt|json|yaml|yml|xml|html|css)$/i.test(enhancedPrompt)
		
		// Extract file paths from the prompt using comprehensive pattern
		const filePathPattern = /(?:^|\s)(?:\.\/)?[\w\/\-\.]+\.(?:py|ts|js|tsx|jsx|java|go|rs|cpp|c|h|md|txt|json|yaml|yml|xml|html|css|rb|php|swift|kt|scala|r|m|mm|pl|sh|bat|ps1)(?:\s|$)/gi
		const extractedFilePaths = (enhancedPrompt.match(filePathPattern) || []).map(p => p.trim()).filter((p, i, arr) => arr.indexOf(p) === i) // dedupe
		
		// If file paths are mentioned in the prompt, add STRONG instruction to use read_file
		if (hasFilePaths && extractedFilePaths.length > 0) {
			enhancedPrompt = `${enhancedPrompt}\n\n📄 FILES DETECTED IN TASK:\n${extractedFilePaths.map(f => `- ${f}`).join("\n")}\n\n🚨 IMMEDIATE ACTION: Use read_file tool NOW to read these files. Example:\n<read_file>\n<args>\n${extractedFilePaths.slice(0, 5).map(f => `  <file>\n    <path>${f}</path>\n  </file>`).join("\n")}\n</args>\n</read_file>\n\nIf there are more than 5 files, make additional read_file calls.`
		} else if (!hasFilePaths) {
			// If no file paths detected, add instruction to search for files
			const searchInstruction = agentType === "reviewer" || enhancedPrompt.toLowerCase().includes("review")
				? `\n\n🔍 NO FILE PATHS DETECTED - SEARCH REQUIRED:\nBefore starting, use search_files to find the relevant files. IMPORTANT: search_files REQUIRES a <path> parameter - use "." for workspace root if unsure. Example:\n<search_files>\n<path>.</path>\n<regex>.*</regex>\n<file_pattern>*test*.py</file_pattern>\n</search_files>\nThen use read_file to examine the found files. Do NOT ask the user.`
				: `\n\n🔍 INFORMATION GATHERING:\nIf this task requires file access, use search_files, list_files, or codebase_search to find relevant files, then use read_file to examine them. CRITICAL: When using search_files, ALWAYS provide the <path> parameter - use "." for workspace root if unsure. Do NOT ask the user for file contents.`
			enhancedPrompt = `${enhancedPrompt}${searchInstruction}`
		}
		
		// Always append the critical instructions at the end (most prominent position)
		enhancedPrompt = `${enhancedPrompt}${criticalToolInstructions}`
		
		return enhancedPrompt
	}

	/**
	 * Spawn multiple child tasks from a plan's sub-transactions
	 */
	public async spawnChildTasks(plan: {
		subTransactions: import("@roo-code/types").SubTransaction[]
	}): Promise<Task[]> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}

		const children: Task[] = []
		for (const subTx of plan.subTransactions) {
			try {
				// Extract file targets from steps if available
				let fileTargetsFromSteps: string[] | undefined
				if (subTx.steps && subTx.steps.length > 0) {
					fileTargetsFromSteps = subTx.steps
						.filter((step: any) => step.target && (step.type === "edit_file" || step.type === "read_file" || step.type === "review_file"))
						.map((step: any) => step.target)
						.filter((target: string, index: number, self: string[]) => self.indexOf(target) === index) // dedupe
				}
				
				// VALIDATION: Check that file targets from plan steps actually exist
				// This prevents LLM hallucinations where the planner references non-existent files
				if (fileTargetsFromSteps && fileTargetsFromSteps.length > 0) {
					const { existing, nonExistent } = await validateFilePaths(fileTargetsFromSteps, this.cwd)
					
					if (nonExistent.length > 0) {
						provider.log(
							`[Task.spawnChildTasks] Warning: Sub-transaction ${subTx.id} references non-existent files: ${nonExistent.join(", ")}`
						)
						// Filter out non-existent files from targets
						// The subtask will need to use search_files to find the right files
						fileTargetsFromSteps = existing.length > 0 ? existing : undefined
					}
				}
				
				// Also validate file paths mentioned in the prompt itself
				const promptPaths = extractFilePathsFromText(subTx.prompt || "")
				if (promptPaths.length > 0) {
					const { nonExistent } = await validateFilePaths(promptPaths, this.cwd)
					if (nonExistent.length > 0) {
						provider.log(
							`[Task.spawnChildTasks] Warning: Sub-transaction ${subTx.id} prompt references non-existent files: ${nonExistent.join(", ")}`
						)
						// We don't block the task, but we'll add a warning to the prompt
					}
				}
				
				// Store original prompt for user display (without internal instructions)
				const originalPrompt = subTx.prompt || ""
				
				// Enhance prompt for LLM (with internal tool usage instructions)
				const enhancedPrompt = this.enhanceSubtaskPrompt(
					originalPrompt,
					subTx.agentType,
					fileTargetsFromSteps
				)
				
				// Create task with enhanced prompt (for LLM execution)
				// The enhanced prompt includes tool usage instructions that prevent the model from asking for files
				const child = await provider.createTask(
					enhancedPrompt, // LLM uses this (with tool instructions)
					undefined,
					this, // parent
					{
						initialTodos: [],
					},
				)
				if (child) {
					// Set agent type and sub-transaction ID
					child.agentType = subTx.agentType
					child.subTransactionId = subTx.id
					this.childTaskIds.push(child.taskId)
					children.push(child)
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`[Task.spawnChildTasks] Failed to create child task for ${subTx.id}: ${errorMessage}`)
				// Continue with next sub-transaction
			}
		}
		return children
	}

	/**
	 * Wait for all child tasks to complete
	 */
	public async waitForAllChildren(): Promise<Map<string, import("../planner/types").ChildResult>> {
		return this.waitForChildren(this.childTaskIds)
	}

	/**
	 * Wait for specific child tasks to complete
	 */
	public async waitForChildren(childIds: string[]): Promise<Map<string, import("../planner/types").ChildResult>> {
		const results = new Map<string, import("../planner/types").ChildResult>()
		const provider = this.providerRef.deref()
		if (!provider) {
			return results
		}

		const TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

		await Promise.all(
			childIds.map(async (childId) => {
				const startTime = Date.now()
				const child = provider.getTaskById(childId)
				if (!child) {
					results.set(childId, { success: false, error: "Child task not found" })
					return
				}

				// Wait for task to start if it hasn't yet
				if (child.taskStatus === TaskStatus.None) {
					await delay(1000) // Give task time to start
					// Re-check status
					if (child.taskStatus === TaskStatus.None) {
						// Task never started, mark as failed
						results.set(childId, { success: false, error: "Task never started" })
						return
					}
				}

				// Wait for child to complete (check status) - handle all active states
				while (
					(child.taskStatus === TaskStatus.Running ||
						child.taskStatus === TaskStatus.Interactive ||
						child.taskStatus === TaskStatus.Resumable) &&
					!child.abandoned &&
					!child.abort &&
					Date.now() - startTime < TIMEOUT_MS
				) {
					await delay(500)
				}

				// Check for timeout
				if (Date.now() - startTime >= TIMEOUT_MS) {
					results.set(childId, {
						success: false,
						error: "Task timeout after 30 minutes",
						worktreePath: child.worktreePath,
						checkpointHash: child.checkpointService?.baseHash,
					})
					return
				}

				// Check if task completed successfully
				// Note: TaskStatus.None means task never started, Idle means completed normally
				const success = !child.abandoned && !child.abort && child.taskStatus === TaskStatus.Idle

				// E2E mode: If child aborted due to blocked Task#ask, immediately abort parent
				if (child.e2eBlockedAskAbort) {
					const isE2EMode = !!(process.env.TEST_TORTURE_REPO || process.env.TEST_TORTURE_REPO_WORKSPACE)
					if (isE2EMode) {
						const errorMessage = `Blocked Task#ask in e2e mode: ${child.e2eBlockedAskAbort.type} (child task)`
						provider.log(`[Task#waitForChildren] E2E mode: ${errorMessage} - Aborting parent task ${this.taskId}`)
						// Abort parent task immediately
						await this.abortTask()
						throw new Error(errorMessage)
					}
				}

				results.set(childId, {
					success,
					worktreePath: child.worktreePath,
					checkpointHash: child.checkpointService?.baseHash,
					error: !success ? "Task failed or was aborted" : undefined,
				})
			}),
		)

		return results
	}

	/**
	 * Find a child task by ID
	 */
	public async findChildTask(taskId: string): Promise<Task | undefined> {
		const provider = this.providerRef.deref()
		if (!provider) {
			return undefined
		}
		return provider.getTaskById(taskId)
	}

	/**
	 * Merge child task results (worktrees) into parent
	 * This is a placeholder - actual merging logic will be in PlanExecutor
	 */
	public async mergeChildResults(results: Map<string, import("../planner/types").ChildResult>): Promise<void> {
		// Actual merging logic delegated to PlanExecutor
		// This method exists for interface completeness
	}

	// Task Loop

	private async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		const checkpointServicePromise = getCheckpointService(this)

		// Initialize sub-transaction once checkpoint service is ready
		checkpointServicePromise
			.then(async (service) => {
				if (service && this.enableCheckpoints) {
					try {
						const { SubTransactionManager } = await import("../checkpoints/SubTransactionManager")
						const manager = new SubTransactionManager(this)

						// Get current HEAD as baseCheckpoint
						const simpleGit = (await import("simple-git")).default
						const workspaceDir = this.cwd || getWorkspacePath()
						if (workspaceDir) {
							const git = simpleGit(workspaceDir, { binary: "git" })
							const baseCheckpoint = await git.revparse(["HEAD"])
							await manager.createSubTransaction(baseCheckpoint)
						}
					} catch (error) {
						const provider = this.providerRef.deref()
						provider?.log(
							`[Task#initiateTaskLoop] Failed to initialize sub-transaction: ${error instanceof Error ? error.message : String(error)}`,
						)
					}
				}
			})
			.catch(() => {
				// Ignore errors - checkpoint service may not be available
			})

		let nextUserContent = userContent
		let includeFileDetails = true

		this.emit(RooCodeEventName.TaskStarted)

		while (!this.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // We only need file details the first time.

			// The way this agentic loop works is that cline will be given a
			// task that he then calls tools to complete. Unless there's an
			// attempt_completion call, we keep responding back to him with his
			// tool's responses until he either attempt_completion or does not
			// use anymore tools. If he does not use anymore tools, we ask him
			// to consider if he's completed the task and then call
			// attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
			// requests, but Cline is prompted to finish the task as efficiently
			// as he can.

			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if
				// the user hits max requests and denies resetting the count.
				break
			} else {
				nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
				this.consecutiveMistakeCount++
			}
		}
	}

	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		interface StackItem {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
		}

		const stack: StackItem[] = [{ userContent, includeFileDetails }]

		while (stack.length > 0) {
			const currentItem = stack.pop()!
			const currentUserContent = currentItem.userContent
			const currentIncludeFileDetails = currentItem.includeFileDetails

			if (this.abort) {
				throw new Error(`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`)
			}

			if (this.consecutiveMistakeLimit > 0 && this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
				const { response, text, images } = await this.ask(
					"mistake_limit_reached",
					t("common:errors.mistake_limit_guidance"),
				)

				if (response === "messageResponse") {
					currentUserContent.push(
						...[
							{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
							...formatResponse.imageBlocks(images),
						],
					)

					await this.say("user_feedback", text, images)

					// Track consecutive mistake errors in telemetry.
					TelemetryService.instance.captureConsecutiveMistakeError(this.taskId)
				}

				this.consecutiveMistakeCount = 0
			}

			// In this Cline request loop, we need to check if this task instance
			// has been asked to wait for a subtask to finish before continuing.
			const provider = this.providerRef.deref()

			if (this.isPaused && provider) {
				provider.log(`[subtasks] paused ${this.taskId}.${this.instanceId}`)
				await this.waitForSubtask()
				provider.log(`[subtasks] resumed ${this.taskId}.${this.instanceId}`)
				const currentMode = (await provider.getState())?.mode ?? defaultModeSlug

				if (currentMode !== this.pausedModeSlug) {
					// The mode has changed, we need to switch back to the paused mode.
					await provider.handleModeSwitch(this.pausedModeSlug)

					// Delay to allow mode change to take effect before next tool is executed.
					await delay(500)

					provider.log(
						`[subtasks] task ${this.taskId}.${this.instanceId} has switched back to '${this.pausedModeSlug}' from '${currentMode}'`,
					)
				}
			}

			// Getting verbose details is an expensive operation, it uses ripgrep to
			// top-down build file structure of project which for large projects can
			// take a few seconds. For the best UX we show a placeholder api_req_started
			// message with a loading spinner as this happens.

			// Determine API protocol based on provider and model
			const modelId = getModelId(this.apiConfiguration)
			const apiProtocol = getApiProtocol(this.apiConfiguration.apiProvider, modelId)

			await this.say(
				"api_req_started",
				JSON.stringify({
					apiProtocol,
				}),
			)

			const {
				showRooIgnoredFiles = false,
				includeDiagnosticMessages = true,
				maxDiagnosticMessages = 50,
				maxReadFileLine = -1,
			} = (await this.providerRef.deref()?.getState()) ?? {}

			const parsedUserContent = await processUserContentMentions({
				userContent: currentUserContent,
				cwd: this.cwd,
				urlContentFetcher: this.urlContentFetcher,
				fileContextTracker: this.fileContextTracker,
				rooIgnoreController: this.rooIgnoreController,
				showRooIgnoredFiles,
				includeDiagnosticMessages,
				maxDiagnosticMessages,
				maxReadFileLine,
			})

			const environmentDetails = await getEnvironmentDetails(this, currentIncludeFileDetails)

			// Add environment details as its own text block, separate from tool
			// results.
			let finalUserContent = [...parsedUserContent, { type: "text" as const, text: environmentDetails }]
			
			// Fix #2: Inject hard constraint message before next LLM call if validation error occurred
			if (this.forceConstraintNextTurn && this.pendingValidationError) {
				let constraintMessage: string
				
				// Fix #3: Enhanced constraint for consecutive read_file validation errors
				if (this.pendingValidationError.tool === "read_file") {
					if (this.consecutiveReadFileValidationErrors >= 2) {
						// After 2+ consecutive errors, force discovery tool
						constraintMessage = `SYSTEM: You have called <read_file> without a path ${this.consecutiveReadFileValidationErrors} times. You MUST NOT call <read_file> again until you have a valid path. 

REQUIRED NEXT STEP: Call a discovery tool first:
- <list_files><path>.</path></list_files> to see available files, OR
- <search_files><path>.</path><regex>.*</regex></search_files> to search for files

Only AFTER you have a valid file path from the discovery tool results should you call <read_file> with that path.`
					} else {
						constraintMessage = `SYSTEM: Tool call invalid last turn. When calling <read_file> you MUST include <args><file><path>...</path></file></args> with a non-empty path value. If you do not know the path, call <list_files><path>.</path></list_files> or <search_files><path>.</path><regex>.*</regex></search_files> first. Do NOT call <read_file> without a path.`
					}
				} else {
					constraintMessage = `SYSTEM: Tool call invalid last turn. ${this.pendingValidationError.message}`
				}
				
				// Prepend constraint as high-priority system message
				finalUserContent = [
					{ type: "text" as const, text: constraintMessage },
					...finalUserContent,
				]
				
				// Clear flag after injection (one-turn only)
				this.forceConstraintNextTurn = false
				this.pendingValidationError = null
			}

			await this.addToApiConversationHistory({ role: "user", content: finalUserContent })
			TelemetryService.instance.captureConversationMessage(this.taskId, "user")

			// Since we sent off a placeholder api_req_started message to update the
			// webview while waiting to actually start the API request (to load
			// potential details for example), we need to update the text of that
			// message.
			const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

			this.clineMessages[lastApiReqIndex].text = JSON.stringify({
				apiProtocol,
			} satisfies ClineApiReqInfo)

			await this.saveClineMessages()
			await provider?.postStateToWebview()

			try {
				let cacheWriteTokens = 0
				let cacheReadTokens = 0
				let inputTokens = 0
				let outputTokens = 0
				let totalCost: number | undefined

				// We can't use `api_req_finished` anymore since it's a unique case
				// where it could come after a streaming message (i.e. in the middle
				// of being updated or executed).
				// Fortunately `api_req_finished` was always parsed out for the GUI
				// anyways, so it remains solely for legacy purposes to keep track
				// of prices in tasks from history (it's worth removing a few months
				// from now).
				const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (lastApiReqIndex < 0 || !this.clineMessages[lastApiReqIndex]) {
						return
					}

					const existingData = JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}")
					this.clineMessages[lastApiReqIndex].text = JSON.stringify({
						...existingData,
						tokensIn: inputTokens,
						tokensOut: outputTokens,
						cacheWrites: cacheWriteTokens,
						cacheReads: cacheReadTokens,
						cost:
							totalCost ??
							calculateApiCostAnthropic(
								this.api.getModel().info,
								inputTokens,
								outputTokens,
								cacheWriteTokens,
								cacheReadTokens,
							),
						cancelReason,
						streamingFailedMessage,
					} satisfies ClineApiReqInfo)
				}

				const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (this.diffViewProvider.isEditing) {
						await this.diffViewProvider.revertChanges() // closes diff view
					}

					// if last message is a partial we need to update and save it
					const lastMessage = this.clineMessages.at(-1)

					if (lastMessage && lastMessage.partial) {
						// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
						lastMessage.partial = false
						// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
						console.log("updating partial message", lastMessage)
					}

					// Update `api_req_started` to have cancelled and cost, so that
					// we can display the cost of the partial stream and the cancellation reason
					updateApiReqMsg(cancelReason, streamingFailedMessage)
					await this.saveClineMessages()

					// Signals to provider that it can retrieve the saved messages
					// from disk, as abortTask can not be awaited on in nature.
					this.didFinishAbortingStream = true
				}

				// Reset streaming state for each new API request
				this.currentStreamingContentIndex = 0
				this.currentStreamingDidCheckpoint = false
				this.assistantMessageContent = []
				this.didCompleteReadingStream = false
				this.userMessageContent = []
				this.userMessageContentReady = false
				this.didRejectTool = false
				this.didAlreadyUseTool = false
				this.presentAssistantMessageLocked = false
				this.presentAssistantMessageHasPendingUpdates = false
				this.assistantMessageParser.reset()

				await this.diffViewProvider.reset()

				// Yields only if the first chunk is successful, otherwise will
				// allow the user to retry the request (most likely due to rate
				// limit error, which gets thrown on the first chunk).
				const stream = this.attemptApiRequest()
				let assistantMessage = ""
				let reasoningMessage = ""
				let pendingGroundingSources: GroundingSource[] = []
				this.isStreaming = true

				try {
					const iterator = stream[Symbol.asyncIterator]()
					let item = await iterator.next()
					let chunkCount = 0
					while (!item.done) {
						const chunk = item.value
						item = await iterator.next()
						if (!chunk) {
							// Sometimes chunk is undefined, no idea that can cause
							// it, but this workaround seems to fix it.
							continue
						}

						chunkCount++
						// Log first chunk and every 10th chunk thereafter
						if (chunkCount === 1 || chunkCount % 10 === 0) {
							const provider = this.providerRef.deref()
							const modelId = this.api.getModel().id
							provider?.log(
								`[LLM] Response chunk received - Provider: ${this.apiConfiguration.apiProvider}, Model: ${modelId}, Task: ${this.taskId}, Chunk #${chunkCount}, Type: ${chunk.type}`
							)
						}

						switch (chunk.type) {
							case "reasoning": {
								reasoningMessage += chunk.text
								// Only apply formatting if the message contains sentence-ending punctuation followed by **
								let formattedReasoning = reasoningMessage
								if (reasoningMessage.includes("**")) {
									// Add line breaks before **Title** patterns that appear after sentence endings
									// This targets section headers like "...end of sentence.**Title Here**"
									// Handles periods, exclamation marks, and question marks
									formattedReasoning = reasoningMessage.replace(
										/([.!?])\*\*([^*\n]+)\*\*/g,
										"$1\n\n**$2**",
									)
								}
								await this.say("reasoning", formattedReasoning, undefined, true)
								break
							}
							case "usage":
								inputTokens += chunk.inputTokens
								outputTokens += chunk.outputTokens
								cacheWriteTokens += chunk.cacheWriteTokens ?? 0
								cacheReadTokens += chunk.cacheReadTokens ?? 0
								totalCost = chunk.totalCost
								break
							case "grounding":
								// Handle grounding sources separately from regular content
								// to prevent state persistence issues - store them separately
								if (chunk.sources && chunk.sources.length > 0) {
									pendingGroundingSources.push(...chunk.sources)
								}
								break
			case "text": {
				assistantMessage += chunk.text

				// Logging: Track tool protocol and model for debugging
				const modelId = getModelId(this.apiConfiguration)
				const apiProtocol = getApiProtocol(this.apiConfiguration.apiProvider, modelId)
				const provider = await this.providerRef.deref()
				
				// Fix #4: Comprehensive audit logging - Raw model output
				if (provider && process.env.ROO_DEBUG_TOOL_EXECUTION) {
					provider.log(
						`[Task#${this.taskId}] [AUDIT:RAW] Raw model output chunk - Provider: ${this.apiConfiguration.apiProvider}, Model: ${modelId}, Protocol: ${apiProtocol}, Chunk length: ${chunk.text.length}`,
					)
					if (chunk.text.length < 500) {
						provider.log(`[Task#${this.taskId}] [AUDIT:RAW] Content: ${JSON.stringify(chunk.text)}`)
					}
				}

				// Pre-process: Comprehensive tool call repairer
				// Automatically fixes ALL common mistakes (function-call syntax, wrong case, missing tags, etc.)
				// This ensures deterministic, error-free tool execution
				let processedChunk = this.repairToolCalls(chunk.text)
				
				// Fix #4: Audit logging - Post-repair output
				if (provider && process.env.ROO_DEBUG_TOOL_EXECUTION && processedChunk !== chunk.text) {
					provider.log(
						`[Task#${this.taskId}] [AUDIT:REPAIRED] Tool call repairer modified output. Original length: ${chunk.text.length}, Repaired length: ${processedChunk.length}`,
					)
					if (processedChunk.length < 500) {
						provider.log(`[Task#${this.taskId}] [AUDIT:REPAIRED] Repaired content: ${JSON.stringify(processedChunk)}`)
					}
				}
				
				// Parse raw assistant message chunk into content blocks.
				const prevLength = this.assistantMessageContent.length
				this.assistantMessageContent = this.assistantMessageParser.processChunk(processedChunk)
				
				// Fix #4: Audit logging - Parsed tool calls
				if (this.assistantMessageContent.length > prevLength) {
					const newBlocks = this.assistantMessageContent.slice(prevLength)
					const toolCalls = newBlocks.filter((b) => b.type === "tool_use")
					if (toolCalls.length > 0 && provider && process.env.ROO_DEBUG_TOOL_EXECUTION) {
						provider.log(
							`[Task#${this.taskId}] [AUDIT:PARSED] Parsed ${toolCalls.length} tool call(s): ${toolCalls.map((b) => `${b.name}(${JSON.stringify(b.params)})`).join(", ")}`,
						)
					}
				}
				
				// Fix #2 & #5: Check for validation errors during streaming
				const validationErrors = this.assistantMessageParser.getValidationErrors()
				if (validationErrors.length > 0 && !this.pendingValidationError) {
					this.pendingValidationError = validationErrors[0]
					this.forceConstraintNextTurn = true
				}

				// Fix #2: Detect malformed XML tool tags for OpenAI providers
				// If we're using OpenAI protocol and see XML-like tags that look like tool calls
				// but aren't properly parsed, warn and potentially reject them
				if (apiProtocol === "openai" && chunk.text) {
					// Check for XML tags that look like tool calls but might be malformed
					const xmlTagPattern = /<(\w+)>/g
					const matches = [...chunk.text.matchAll(xmlTagPattern)]
					const potentialToolNames = matches.map((m) => m[1])
					const knownToolNames = ["bash", "command", "execute_command", "read_file", "write_to_file"]
					const suspiciousTags = potentialToolNames.filter(
						(tag) => knownToolNames.some((known) => tag.toLowerCase().includes(known.toLowerCase())) && !toolNames.includes(tag as any),
					)

					if (suspiciousTags.length > 0 && provider && process.env.ROO_DEBUG_TOOL_EXECUTION) {
						provider.log(
							`[Task#${this.taskId}] WARNING: Detected suspicious XML-like tags that might be malformed tool calls: ${suspiciousTags.join(", ")}. These will be parsed as text, not executed as tools.`,
						)
					}
				}

				// Logging: Track tool call detection
				if (this.assistantMessageContent.length > prevLength) {
					const newBlocks = this.assistantMessageContent.slice(prevLength)
					const toolCalls = newBlocks.filter((b) => b.type === "tool_use")
					if (toolCalls.length > 0 && provider && process.env.ROO_DEBUG_TOOL_EXECUTION) {
						provider.log(
							`[Task#${this.taskId}] Detected ${toolCalls.length} tool call(s) via XML parsing: ${toolCalls.map((b) => b.name).join(", ")}`,
						)
					}
					// New content we need to present, reset to
					// false in case previous content set this to true.
					this.userMessageContentReady = false
				}

				// Present content to user.
				presentAssistantMessage(this)
				break
			}
						}

						if (this.abort) {
							console.log(`aborting stream, this.abandoned = ${this.abandoned}`)

							if (!this.abandoned) {
								// Only need to gracefully abort if this instance
								// isn't abandoned (sometimes OpenRouter stream
								// hangs, in which case this would affect future
								// instances of Cline).
								await abortStream("user_cancelled")
							}

							break // Aborts the stream.
						}

						if (this.didRejectTool) {
							// `userContent` has a tool rejection, so interrupt the
							// assistant's response to present the user's feedback.
							assistantMessage += "\n\n[Response interrupted by user feedback]"
							// Instead of setting this preemptively, we allow the
							// present iterator to finish and set
							// userMessageContentReady when its ready.
							// this.userMessageContentReady = true
							break
						}

						if (this.didAlreadyUseTool) {
							assistantMessage +=
								"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
							break
						}
					}

					// Create a copy of current token values to avoid race conditions
					const currentTokens = {
						input: inputTokens,
						output: outputTokens,
						cacheWrite: cacheWriteTokens,
						cacheRead: cacheReadTokens,
						total: totalCost,
					}

					const drainStreamInBackgroundToFindAllUsage = async (apiReqIndex: number) => {
						const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
						const startTime = Date.now()
						const modelId = getModelId(this.apiConfiguration)

						// Local variables to accumulate usage data without affecting the main flow
						let bgInputTokens = currentTokens.input
						let bgOutputTokens = currentTokens.output
						let bgCacheWriteTokens = currentTokens.cacheWrite
						let bgCacheReadTokens = currentTokens.cacheRead
						let bgTotalCost = currentTokens.total

						// Helper function to capture telemetry and update messages
						const captureUsageData = async (
							tokens: {
								input: number
								output: number
								cacheWrite: number
								cacheRead: number
								total?: number
							},
							messageIndex: number = apiReqIndex,
						) => {
							if (
								tokens.input > 0 ||
								tokens.output > 0 ||
								tokens.cacheWrite > 0 ||
								tokens.cacheRead > 0
							) {
								// Update the shared variables atomically
								inputTokens = tokens.input
								outputTokens = tokens.output
								cacheWriteTokens = tokens.cacheWrite
								cacheReadTokens = tokens.cacheRead
								totalCost = tokens.total

								// Update the API request message with the latest usage data
								updateApiReqMsg()
								await this.saveClineMessages()

								// Update the specific message in the webview
								const apiReqMessage = this.clineMessages[messageIndex]
								if (apiReqMessage) {
									await this.updateClineMessage(apiReqMessage)
								}

								// Capture telemetry
								TelemetryService.instance.captureLlmCompletion(this.taskId, {
									inputTokens: tokens.input,
									outputTokens: tokens.output,
									cacheWriteTokens: tokens.cacheWrite,
									cacheReadTokens: tokens.cacheRead,
									cost:
										tokens.total ??
										calculateApiCostAnthropic(
											this.api.getModel().info,
											tokens.input,
											tokens.output,
											tokens.cacheWrite,
											tokens.cacheRead,
										),
								})
							}
						}

						try {
							// Continue processing the original stream from where the main loop left off
							let usageFound = false
							let chunkCount = 0

							// Use the same iterator that the main loop was using
							while (!item.done) {
								// Check for timeout
								if (Date.now() - startTime > timeoutMs) {
									console.warn(
										`[Background Usage Collection] Timed out after ${timeoutMs}ms for model: ${modelId}, processed ${chunkCount} chunks`,
									)
									// Clean up the iterator before breaking
									if (iterator.return) {
										await iterator.return(undefined)
									}
									break
								}

								const chunk = item.value
								item = await iterator.next()
								chunkCount++

								if (chunk && chunk.type === "usage") {
									usageFound = true
									bgInputTokens += chunk.inputTokens
									bgOutputTokens += chunk.outputTokens
									bgCacheWriteTokens += chunk.cacheWriteTokens ?? 0
									bgCacheReadTokens += chunk.cacheReadTokens ?? 0
									bgTotalCost = chunk.totalCost
								}
							}

							if (
								usageFound ||
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								// We have usage data either from a usage chunk or accumulated tokens
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							} else {
								console.warn(
									`[Background Usage Collection] Suspicious: request ${apiReqIndex} is complete, but no usage info was found. Model: ${modelId}`,
								)
							}
						} catch (error) {
							console.error("Error draining stream for usage data:", error)
							// Still try to capture whatever usage data we have collected so far
							if (
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							}
						}
					}

					// Start the background task and handle any errors
					drainStreamInBackgroundToFindAllUsage(lastApiReqIndex).catch((error) => {
						console.error("Background usage collection failed:", error)
					})
				} catch (error) {
					// Abandoned happens when extension is no longer waiting for the
					// Cline instance to finish aborting (error is thrown here when
					// any function in the for loop throws due to this.abort).
					if (!this.abandoned) {
						// If the stream failed, there's various states the task
						// could be in (i.e. could have streamed some tools the user
						// may have executed), so we just resort to replicating a
						// cancel task.

						// Determine cancellation reason BEFORE aborting to ensure correct persistence
						const cancelReason: ClineApiReqCancelReason = this.abort ? "user_cancelled" : "streaming_failed"

						const streamingFailedMessage = this.abort
							? undefined
							: (error.message ?? JSON.stringify(serializeError(error), null, 2))

						// Persist interruption details first to both UI and API histories
						await abortStream(cancelReason, streamingFailedMessage)

						// Record reason for provider to decide rehydration path
						this.abortReason = cancelReason

						// Now abort (emits TaskAborted which provider listens to)
						await this.abortTask()

						// Do not rehydrate here; provider owns rehydration to avoid duplication races
					}
				} finally {
					this.isStreaming = false
					const provider = this.providerRef.deref()
					const modelId = this.api.getModel().id
					provider?.log(
						`[LLM] Stream consumption completed - Provider: ${this.apiConfiguration.apiProvider}, Model: ${modelId}, Task: ${this.taskId}`
					)
				}

				// Need to call here in case the stream was aborted.
				if (this.abort || this.abandoned) {
					throw new Error(
						`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`,
					)
				}

				this.didCompleteReadingStream = true
				const provider = this.providerRef.deref()
				const modelId = this.api.getModel().id
				provider?.log(
					`[LLM] State machine resumed after LLM call - Provider: ${this.apiConfiguration.apiProvider}, Model: ${modelId}, Task: ${this.taskId}`
				)

				// Set any blocks to be complete to allow `presentAssistantMessage`
				// to finish and set `userMessageContentReady` to true.
				// (Could be a text block that had no subsequent tool uses, or a
				// text block at the very end, or an invalid tool use, etc. Whatever
				// the case, `presentAssistantMessage` relies on these blocks either
				// to be completed or the user to reject a block in order to proceed
				// and eventually set userMessageContentReady to true.)
				const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
				partialBlocks.forEach((block) => (block.partial = false))

				// Can't just do this b/c a tool could be in the middle of executing.
				// this.assistantMessageContent.forEach((e) => (e.partial = false))

				// Now that the stream is complete, finalize any remaining partial content blocks
				this.assistantMessageParser.finalizeContentBlocks()
				this.assistantMessageContent = this.assistantMessageParser.getContentBlocks()
				
				// Fix #2 & #5: Check for validation errors and set flag for hard constraint injection
				const validationErrors = this.assistantMessageParser.getValidationErrors()
				if (validationErrors.length > 0) {
					// Store the first validation error for constraint injection
					this.pendingValidationError = validationErrors[0]
					this.forceConstraintNextTurn = true
					this.assistantMessageParser.clearValidationErrors()
				}

				if (partialBlocks.length > 0) {
					// If there is content to update then it will complete and
					// update `this.userMessageContentReady` to true, which we
					// `pWaitFor` before making the next request. All this is really
					// doing is presenting the last partial message that we just set
					// to complete.
					presentAssistantMessage(this)
				}

				// Note: updateApiReqMsg() is now called from within drainStreamInBackgroundToFindAllUsage
				// to ensure usage data is captured even when the stream is interrupted. The background task
				// uses local variables to accumulate usage data before atomically updating the shared state.

				// Complete the reasoning message if it exists
				// We can't use say() here because the reasoning message may not be the last message
				// (other messages like text blocks or tool uses may have been added after it during streaming)
				if (reasoningMessage) {
					const lastReasoningIndex = findLastIndex(
						this.clineMessages,
						(m) => m.type === "say" && m.say === "reasoning",
					)

					if (lastReasoningIndex !== -1 && this.clineMessages[lastReasoningIndex].partial) {
						this.clineMessages[lastReasoningIndex].partial = false
						await this.updateClineMessage(this.clineMessages[lastReasoningIndex])
					}
				}

				await this.persistGpt5Metadata(reasoningMessage)
				await this.saveClineMessages()
				await this.providerRef.deref()?.postStateToWebview()

				// Reset parser after each complete conversation round
				this.assistantMessageParser.reset()

				// Now add to apiConversationHistory.
				// Need to save assistant responses to file before proceeding to
				// tool use since user can exit at any moment and we wouldn't be
				// able to save the assistant's response.
				let didEndLoop = false

				if (assistantMessage.length > 0) {
					// Display grounding sources to the user if they exist
					if (pendingGroundingSources.length > 0) {
						const citationLinks = pendingGroundingSources.map((source, i) => `[${i + 1}](${source.url})`)
						const sourcesText = `${t("common:gemini.sources")} ${citationLinks.join(", ")}`

						await this.say("text", sourcesText, undefined, false, undefined, undefined, {
							isNonInteractive: true,
						})
					}

					await this.addToApiConversationHistory({
						role: "assistant",
						content: [{ type: "text", text: assistantMessage }],
					})

					TelemetryService.instance.captureConversationMessage(this.taskId, "assistant")

					// NOTE: This comment is here for future reference - this was a
					// workaround for `userMessageContent` not getting set to true.
					// It was due to it not recursively calling for partial blocks
					// when `didRejectTool`, so it would get stuck waiting for a
					// partial block to complete before it could continue.
					// In case the content blocks finished it may be the api stream
					// finished after the last parsed content block was executed, so
					// we are able to detect out of bounds and set
					// `userMessageContentReady` to true (note you should not call
					// `presentAssistantMessage` since if the last block i
					//  completed it will be presented again).
					// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // If there are any partial blocks after the stream ended we can consider them invalid.
					// if (this.currentStreamingContentIndex >= completeBlocks.length) {
					// 	this.userMessageContentReady = true
					// }

					await pWaitFor(() => this.userMessageContentReady)

					// If the model did not tool use, then we need to tell it to
					// either use a tool or attempt_completion.
					const didToolUse = this.assistantMessageContent.some((block) => block.type === "tool_use")

					if (!didToolUse) {
						// FALLBACK REPAIR: Try to repair the entire accumulated message
						// This catches cases where repair didn't work on chunks but might work on full message
						const fullText = this.assistantMessageContent
							.filter((block) => block.type === "text")
							.map((block) => (block.type === "text" ? block.content : ""))
							.join(" ")
						
						if (fullText.trim().length > 0) {
							const { repairToolCalls, validateRepairedToolCalls } = require("../assistant-message/toolCallRepairer")
							const repairResult = repairToolCalls(fullText)
							
							if (repairResult.repaired && validateRepairedToolCalls(repairResult.text)) {
								// Repair found valid tool calls - reparse the repaired text
								const provider = this.providerRef.deref()
								if (provider && process.env.ROO_DEBUG_TOOL_EXECUTION) {
									provider.log(
										`[Task#${this.taskId}] Fallback repair succeeded! Repairs: ${repairResult.repairs.join(", ")}`
									)
								}
								
								// Reset parser and reparse the repaired text
								this.assistantMessageParser.reset()
								this.assistantMessageContent = this.assistantMessageParser.processChunk(repairResult.text)
								this.assistantMessageParser.finalizeContentBlocks()
								this.assistantMessageContent = this.assistantMessageParser.getContentBlocks()
								
								// Check again if tools were detected after repair
								const didToolUseAfterRepair = this.assistantMessageContent.some((block) => block.type === "tool_use")
								if (didToolUseAfterRepair) {
									// Success! Tools were detected after repair - continue normally
									continue
								}
							}
						}
						
						// Check if model is giving up with "cannot read" or "technical issues" excuses
						const textContent = this.assistantMessageContent
							.filter((block) => block.type === "text")
							.map((block) => (block.type === "text" ? block.content : ""))
							.join(" ")
							.toLowerCase()
						
						const isGivingUp = /cannot.*read|unable.*read|technical.*issue|tooling.*issue|cannot.*search|unable.*search|cannot.*file|unable.*file/.test(textContent)
						
						if (isGivingUp) {
							// Model is giving up - force it to use tools with very explicit instructions
							this.userMessageContent.push({
								type: "text",
								text: `[ERROR] You stated you cannot read files or search the codebase, but you MUST use tools to do this. The tools are working - you need to use them correctly.

⚠️ CRITICAL: You MUST use the read_file or search_files tools. Do NOT say you cannot use them.

For reading files, use:
<read_file>
<args>
  <file>
    <path>README.md</path>
  </file>
</args>
</read_file>

For searching files, use:
<search_files>
<path>.</path>
<regex>.*</regex>
<file_pattern>*test*.py</file_pattern>
</search_files>

The tools are available and working. Use them now.`,
							})
							this.consecutiveMistakeCount++
						} else {
							this.userMessageContent.push({ type: "text", text: formatResponse.noToolsUsed() })
							this.consecutiveMistakeCount++
						}
					}

					if (this.userMessageContent.length > 0) {
						stack.push({
							userContent: [...this.userMessageContent], // Create a copy to avoid mutation issues
							includeFileDetails: false, // Subsequent iterations don't need file details
						})

						// Add periodic yielding to prevent blocking
						await new Promise((resolve) => setImmediate(resolve))
					}
					// Continue to next iteration instead of setting didEndLoop from recursive call
					continue
				} else {
					// If there's no assistant_responses, that means we got no text
					// or tool_use content blocks from API which we should assume is
					// an error.
					await this.say(
						"error",
						"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
					)

					await this.addToApiConversationHistory({
						role: "assistant",
						content: [{ type: "text", text: "Failure: I did not provide a response." }],
					})
				}

				// If we reach here without continuing, return false (will always be false for now)
				return false
			} catch (error) {
				// This should never happen since the only thing that can throw an
				// error is the attemptApiRequest, which is wrapped in a try catch
				// that sends an ask where if noButtonClicked, will clear current
				// task and destroy this instance. However to avoid unhandled
				// promise rejection, we will end this loop which will end execution
				// of this instance (see `startTask`).
				return true // Needs to be true so parent loop knows to end task.
			}
		}

		// If we exit the while loop normally (stack is empty), return false
		return false
	}

	private async getSystemPrompt(): Promise<string> {
		const { mcpEnabled } = (await this.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// Wait for MCP hub initialization through McpServerManager
			mcpHub = await McpServerManager.getInstance(provider.context, provider)

			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}

			// Wait for MCP servers to be connected before generating system prompt
			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const state = await this.providerRef.deref()?.getState()

		const {
			browserViewportSize,
			mode,
			customModes,
			customModePrompts,
			customInstructions,
			experiments,
			enableMcpServerCreation,
			browserToolEnabled,
			language,
			maxConcurrentFileReads,
			maxReadFileLine,
			apiConfiguration,
		} = state ?? {}

		return await (async () => {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider not available")
			}

			// Get base system prompt first
			const baseSystemPrompt = SYSTEM_PROMPT(
				provider.context,
				this.cwd,
				(this.api.getModel().info.supportsComputerUse ?? false) && (browserToolEnabled ?? true),
				mcpHub,
				this.diffStrategy,
				browserViewportSize,
				mode,
				customModePrompts,
				customModes,
				customInstructions,
				this.diffEnabled,
				experiments,
				enableMcpServerCreation,
				language,
				rooIgnoreInstructions,
				maxReadFileLine !== -1,
				{
					maxConcurrentFileReads: maxConcurrentFileReads ?? 5,
					todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
					useAgentRules: vscode.workspace.getConfiguration("roo-cline").get<boolean>("useAgentRules") ?? true,
					newTaskRequireTodos: vscode.workspace
						.getConfiguration("roo-cline")
						.get<boolean>("newTaskRequireTodos", false),
				},
				undefined, // todoList
				this.api.getModel().id,
			)

			// If agent type is set, combine agent-specific prompt with base prompt
			if (this.agentType && this.agentType !== "general") {
				const { getAgentPrompt } = await import("../planner/AgentSpecialization")
				const agentPrompt = getAgentPrompt(this.agentType)
				// Prepend agent-specific instructions to base prompt with proper formatting
				return `${agentPrompt}\n\n---\n\n${baseSystemPrompt}`
			}

			return baseSystemPrompt
		})()
	}

	private getCurrentProfileId(state: any): string {
		return (
			state?.listApiConfigMeta?.find((profile: any) => profile.name === state?.currentApiConfigName)?.id ??
			"default"
		)
	}

	private async handleContextWindowExceededError(): Promise<void> {
		const state = await this.providerRef.deref()?.getState()
		const { profileThresholds = {} } = state ?? {}

		const { contextTokens } = this.getTokenUsage()
		const modelInfo = this.api.getModel().info

		const maxTokens = getModelMaxOutputTokens({
			modelId: this.api.getModel().id,
			model: modelInfo,
			settings: this.apiConfiguration,
		})

		const contextWindow = modelInfo.contextWindow

		// Get the current profile ID using the helper method
		const currentProfileId = this.getCurrentProfileId(state)

		// Log the context window error for debugging
		console.warn(
			`[Task#${this.taskId}] Context window exceeded for model ${this.api.getModel().id}. ` +
				`Current tokens: ${contextTokens}, Context window: ${contextWindow}. ` +
				`Forcing truncation to ${FORCED_CONTEXT_REDUCTION_PERCENT}% of current context.`,
		)

		// Force aggressive truncation by keeping only 75% of the conversation history
		const truncateResult = await truncateConversationIfNeeded({
			messages: this.apiConversationHistory,
			totalTokens: contextTokens || 0,
			maxTokens,
			contextWindow,
			apiHandler: this.api,
			autoCondenseContext: true,
			autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT,
			systemPrompt: await this.getSystemPrompt(),
			taskId: this.taskId,
			profileThresholds,
			currentProfileId,
		})

		if (truncateResult.messages !== this.apiConversationHistory) {
			await this.overwriteApiConversationHistory(truncateResult.messages)
		}

		if (truncateResult.summary) {
			const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
			const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
			await this.say(
				"condense_context",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				contextCondense,
			)
		}
	}

	public async *attemptApiRequest(retryAttempt: number = 0): ApiStream {
		const state = await this.providerRef.deref()?.getState()

		const {
			apiConfiguration,
			autoApprovalEnabled,
			alwaysApproveResubmit,
			requestDelaySeconds,
			mode,
			autoCondenseContext = true,
			autoCondenseContextPercent = 100,
			profileThresholds = {},
		} = state ?? {}

		// Get condensing configuration for automatic triggers.
		const customCondensingPrompt = state?.customCondensingPrompt
		const condensingApiConfigId = state?.condensingApiConfigId
		const listApiConfigMeta = state?.listApiConfigMeta

		// Determine API handler to use for condensing.
		let condensingApiHandler: ApiHandler | undefined

		if (condensingApiConfigId && listApiConfigMeta && Array.isArray(listApiConfigMeta)) {
			// Find matching config by ID
			const matchingConfig = listApiConfigMeta.find((config) => config.id === condensingApiConfigId)

			if (matchingConfig) {
				const profile = await this.providerRef.deref()?.providerSettingsManager.getProfile({
					id: condensingApiConfigId,
				})

				// Ensure profile and apiProvider exist before trying to build handler.
				if (profile && profile.apiProvider) {
					condensingApiHandler = buildApiHandler(profile)
				}
			}
		}

		let rateLimitDelay = 0

		// Use the shared timestamp so that subtasks respect the same rate-limit
		// window as their parent tasks.
		if (Task.lastGlobalApiRequestTime) {
			const now = Date.now()
			const timeSinceLastRequest = now - Task.lastGlobalApiRequestTime
			const rateLimit = apiConfiguration?.rateLimitSeconds || 0
			rateLimitDelay = Math.ceil(Math.max(0, rateLimit * 1000 - timeSinceLastRequest) / 1000)
		}

		// Only show rate limiting message if we're not retrying. If retrying, we'll include the delay there.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			// Show countdown timer
			for (let i = rateLimitDelay; i > 0; i--) {
				const delayMessage = `Rate limiting for ${i} seconds...`
				await this.say("api_req_retry_delayed", delayMessage, undefined, true)
				await delay(1000)
			}
		}

		// Update last request time before making the request so that subsequent
		// requests — even from new subtasks — will honour the provider's rate-limit.
		Task.lastGlobalApiRequestTime = Date.now()

		const systemPrompt = await this.getSystemPrompt()
		this.lastUsedInstructions = systemPrompt
		const { contextTokens } = this.getTokenUsage()

		if (contextTokens) {
			const modelInfo = this.api.getModel().info

			const maxTokens = getModelMaxOutputTokens({
				modelId: this.api.getModel().id,
				model: modelInfo,
				settings: this.apiConfiguration,
			})

			const contextWindow = modelInfo.contextWindow

			// Get the current profile ID using the helper method
			const currentProfileId = this.getCurrentProfileId(state)

			const truncateResult = await truncateConversationIfNeeded({
				messages: this.apiConversationHistory,
				totalTokens: contextTokens,
				maxTokens,
				contextWindow,
				apiHandler: this.api,
				autoCondenseContext,
				autoCondenseContextPercent,
				systemPrompt,
				taskId: this.taskId,
				customCondensingPrompt,
				condensingApiHandler,
				profileThresholds,
				currentProfileId,
			})
			if (truncateResult.messages !== this.apiConversationHistory) {
				await this.overwriteApiConversationHistory(truncateResult.messages)
			}
			if (truncateResult.error) {
				await this.say("condense_context_error", truncateResult.error)
			} else if (truncateResult.summary) {
				// A condense operation occurred; for the next GPT‑5 API call we should NOT
				// send previous_response_id so the request reflects the fresh condensed context.
				this.skipPrevResponseIdOnce = true

				const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
				const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
				await this.say(
					"condense_context",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					contextCondense,
				)
			}
		}

		const messagesSinceLastSummary = getMessagesSinceLastSummary(this.apiConversationHistory)
		let cleanConversationHistory = maybeRemoveImageBlocks(messagesSinceLastSummary, this.api).map(
			({ role, content }) => ({ role, content }),
		)

		// Check auto-approval limits
		const approvalResult = await this.autoApprovalHandler.checkAutoApprovalLimits(
			state,
			this.combineMessages(this.clineMessages.slice(1)),
			async (type, data) => this.ask(type, data),
		)

		if (!approvalResult.shouldProceed) {
			// User did not approve, task should be aborted
			throw new Error("Auto-approval limit reached and user did not approve continuation")
		}

		// Determine GPT‑5 previous_response_id from last persisted assistant turn (if available),
		// unless a condense just occurred (skip once after condense).
		let previousResponseId: string | undefined = undefined
		try {
			const modelId = this.api.getModel().id
			if (modelId && modelId.startsWith("gpt-5") && !this.skipPrevResponseIdOnce) {
				// Find the last assistant message that has a previous_response_id stored
				const idx = findLastIndex(
					this.clineMessages,
					(m): m is ClineMessage & ClineMessageWithMetadata =>
						m.type === "say" &&
						m.say === "text" &&
						!!(m as ClineMessageWithMetadata).metadata?.gpt5?.previous_response_id,
				)
				if (idx !== -1) {
					// Use the previous_response_id from the last assistant message for this request
					const message = this.clineMessages[idx] as ClineMessage & ClineMessageWithMetadata
					previousResponseId = message.metadata?.gpt5?.previous_response_id
				}
			} else if (this.skipPrevResponseIdOnce) {
				// Skipping previous_response_id due to recent condense operation - will send full conversation context
			}
		} catch (error) {
			console.error(`[Task#${this.taskId}] Error retrieving GPT-5 response ID:`, error)
			// non-fatal
		}

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: this.taskId,
			// Only include previousResponseId if we're NOT suppressing it
			...(previousResponseId && !this.skipPrevResponseIdOnce ? { previousResponseId } : {}),
			// If a condense just occurred, explicitly suppress continuity fallback for the next call
			...(this.skipPrevResponseIdOnce ? { suppressPreviousResponseId: true } : {}),
		}

		// Reset skip flag after applying (it only affects the immediate next call)
		if (this.skipPrevResponseIdOnce) {
			this.skipPrevResponseIdOnce = false
		}

		// P3 Reproducibility: Log model call start time
		const modelCallStartTime = Date.now()

		// Get provider and model ID for rate limit coordination (needed in catch block)
		const provider: string = this.apiConfiguration.apiProvider || "unknown"
		const modelId: string = this.api.getModel().id || "unknown"

		// Check and wait for rate limits before making the request
		await waitForRateLimit(provider, modelId)

		// LLM Request Lifecycle Instrumentation
		const requestStartTime = Date.now()
		this.providerRef.deref()?.log(`[LLM] Request sent - Provider: ${provider}, Model: ${modelId}, Task: ${this.taskId}`)
		
		// Set up 30-second timeout for response
		let responseTimeout: NodeJS.Timeout | null = null
		let firstChunkReceived = false
		let streamCompleted = false
		
		const LLM_RESPONSE_TIMEOUT_MS = 30_000 // 30 seconds
		let timeoutError: Error | null = null
		responseTimeout = setTimeout(() => {
			if (!firstChunkReceived && !streamCompleted) {
				const elapsed = Date.now() - requestStartTime
				this.providerRef.deref()?.log(
					`[LLM] TIMEOUT - No response received within 30s. Provider: ${provider}, Model: ${modelId}, Task: ${this.taskId}, Elapsed: ${elapsed}ms`
				)
				// Create error that will be thrown when iterator is accessed
				timeoutError = new Error("LLM request stalled (no response/stream completion)")
				// Abort the task
				this.abortTask().catch(() => {
					// Ignore abort errors
				})
			}
		}, LLM_RESPONSE_TIMEOUT_MS)

		const stream = this.api.createMessage(systemPrompt, cleanConversationHistory, metadata)
		const iterator = stream[Symbol.asyncIterator]()

		// P3 Reproducibility: Log the model call for research analysis
		this.logModelCall(modelId, systemPrompt, cleanConversationHistory, modelCallStartTime)

		try {
			// Check for timeout error before awaiting first chunk
			if (timeoutError) {
				throw timeoutError
			}
			
			// Awaiting first chunk to see if it will throw an error.
			this.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			
			// Check for timeout error after awaiting (timeout might have fired during await)
			if (timeoutError) {
				throw timeoutError
			}
			
			firstChunkReceived = true
			if (responseTimeout) {
				clearTimeout(responseTimeout)
				responseTimeout = null
			}
			const firstChunkElapsed = Date.now() - requestStartTime
			this.providerRef.deref()?.log(
				`[LLM] First chunk received - Provider: ${provider}, Model: ${modelId}, Task: ${this.taskId}, Elapsed: ${firstChunkElapsed}ms`
			)
			yield firstChunk.value
			this.isWaitingForFirstChunk = false
			
			// Clear rate limit on successful first chunk
			await clearRateLimit(provider, modelId)
		} catch (error) {
			this.isWaitingForFirstChunk = false
			streamCompleted = true
			if (responseTimeout) {
				clearTimeout(responseTimeout)
				responseTimeout = null
			}
			await this.logApiFailure(error, provider, modelId, "stream:first-chunk")
			const isContextWindowExceededError = checkContextWindowExceededError(error)
			
			// Check for authentication errors (401) - these should fail fast, not retry
			const isAuthError = isAuthenticationError(error)
			if (isAuthError) {
				const errorMsg = error.message || JSON.stringify(error)
				this.providerRef.deref()?.log(
					`[Task#${this.taskId}] Authentication error (401) detected - failing fast. Error: ${errorMsg}`
				)
				// Abort the task immediately - authentication errors won't succeed on retry
				await this.abortTask()
				throw new Error(`Authentication failed: ${errorMsg}. Check your API key configuration.`)
			}

			// Check for billing/credits errors (402) - these should fail fast, not retry
			const isBillingError = isBillingError(error)
			if (isBillingError) {
				const errorMsg = error.message || JSON.stringify(error)
				this.providerRef.deref()?.log(
					`[Task#${this.taskId}] Billing error (402) detected - failing fast. Error: ${errorMsg}`
				)
				// Abort the task immediately - billing errors won't succeed on retry without adding credits
				await this.abortTask()
				throw new Error(`Insufficient credits: ${errorMsg}. Please add credits to your account.`)
			}

			// If it's a context window error and we haven't exceeded max retries for this error type
			if (isContextWindowExceededError && retryAttempt < MAX_CONTEXT_WINDOW_RETRIES) {
				console.warn(
					`[Task#${this.taskId}] Context window exceeded for model ${this.api.getModel().id}. ` +
						`Retry attempt ${retryAttempt + 1}/${MAX_CONTEXT_WINDOW_RETRIES}. ` +
						`Attempting automatic truncation...`,
				)
				await this.handleContextWindowExceededError()
				// Retry the request after handling the context window error
				yield* this.attemptApiRequest(retryAttempt + 1)
				return
			}

			// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.
			if (autoApprovalEnabled && alwaysApproveResubmit) {
				let errorMsg

				if (error.error?.metadata?.raw) {
					errorMsg = JSON.stringify(error.error.metadata.raw, null, 2)
				} else if (error.message) {
					errorMsg = error.message
				} else {
					errorMsg = "Unknown error"
				}

				const baseDelay = requestDelaySeconds || 5
				let exponentialDelay = Math.min(
					Math.ceil(baseDelay * Math.pow(2, retryAttempt)),
					MAX_EXPONENTIAL_BACKOFF_SECONDS,
				)

				// If the error is a 429, record it in the global coordinator
				// Check both status code and error message (some APIs throw plain Error objects)
				let coordinatorHandled = false
				if (isRateLimitError(error)) {
					await recordRateLimitError(provider, modelId, error)
					
					// Get the delay from coordinator and show countdown
					const coordinatorDelayMs = await getRateLimitDelay(provider, modelId)
					
					if (coordinatorDelayMs > 0) {
						const delaySeconds = Math.ceil(coordinatorDelayMs / 1000)
						for (let i = delaySeconds; i > 0; i--) {
							await this.say(
								"api_req_retry_delayed",
								`${errorMsg}\n\nRate limit: waiting ${i} seconds for reset...`,
								undefined,
								true,
							)
							await delay(1000)
						}
						// Now wait for the actual reset
						await waitForRateLimit(provider, modelId)
						coordinatorHandled = true
					}
					
					// Also handle Gemini-specific retry details if present
					const geminiRetryDetails = error.errorDetails?.find(
						(detail: any) => detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
					)
					if (geminiRetryDetails) {
						const match = geminiRetryDetails?.retryDelay?.match(/^(\d+)s$/)
						if (match) {
							exponentialDelay = Number(match[1]) + 1
						}
					}
				}

				// Only use exponential backoff if coordinator didn't handle it
				// Wait for the greater of the exponential delay or the rate limit delay
				const finalDelay = coordinatorHandled ? 0 : Math.max(exponentialDelay, rateLimitDelay)

				// Only show countdown if we still need to wait (coordinator already waited)
				if (finalDelay > 0) {
					// Show countdown timer with exponential backoff
					for (let i = finalDelay; i > 0; i--) {
						await this.say(
							"api_req_retry_delayed",
							`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying in ${i} seconds...`,
							undefined,
							true,
						)
						await delay(1000)
					}

					await this.say(
						"api_req_retry_delayed",
						`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying now...`,
						undefined,
						false,
					)
				}

				// Delegate generator output from the recursive call with
				// incremented retry count.
				yield* this.attemptApiRequest(retryAttempt + 1)

				return
			} else {
				const errorMessage = error.message ?? JSON.stringify(serializeError(error), null, 2)
				const { response } = await this.ask(
					"api_req_failed",
					errorMessage,
				)

				if (response !== "yesButtonClicked") {
					// This will never happen since if noButtonClicked, we will
					// clear current task, aborting this instance.
					throw new Error("API request failed")
				}

				// Include the error message in the retry notification so LLM sees what went wrong
				await this.say("api_req_retried", `Previous error: ${errorMessage}`)

				// Delegate generator output from the recursive call.
				yield* this.attemptApiRequest()
				return
			}
		}

		// No error, so we can continue to yield all remaining chunks.
		// (Needs to be placed outside of try/catch since it we want caller to
		// handle errors not with api_req_failed as that is reserved for first
		// chunk failures only.)
		// This delegates to another generator or iterable object. In this case,
		// it's saying "yield all remaining values from this iterator". This
		// effectively passes along all subsequent chunks from the original
		// stream.
		
		// Track stream completion by wrapping iterator consumption
		let chunkCount = 1 // First chunk already received
		try {
			for await (const chunk of iterator) {
				chunkCount++
				yield chunk
			}
			// Stream completed successfully
			streamCompleted = true
			if (responseTimeout) {
				clearTimeout(responseTimeout)
				responseTimeout = null
			}
			const streamCompleteElapsed = Date.now() - requestStartTime
			this.providerRef.deref()?.log(
				`[LLM] Stream completed - Provider: ${provider}, Model: ${modelId}, Task: ${this.taskId}, ` +
				`Chunks: ${chunkCount}, Elapsed: ${streamCompleteElapsed}ms`
			)
		} catch (streamError) {
			streamCompleted = true
			if (responseTimeout) {
				clearTimeout(responseTimeout)
				responseTimeout = null
			}
			await this.logApiFailure(streamError, provider, modelId, "stream:consume")
			const streamErrorElapsed = Date.now() - requestStartTime
			this.providerRef.deref()?.log(
				`[LLM] Stream error - Provider: ${provider}, Model: ${modelId}, Task: ${this.taskId}, ` +
				`Elapsed: ${streamErrorElapsed}ms, Error: ${streamError}`
			)
			throw streamError
		}
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false) {
		return checkpointSave(this, force, suppressMessage)
	}

	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	// Metrics

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.clineMessages.slice(1)))
	}

	public recordToolUsage(toolName: ToolName) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].attempts++
	}

	/**
	 * Log a tool call with its full input for replay purposes (P3).
	 * This captures the complete tool invocation for reproducibility research.
	 * Also persists to Control-Plane database if available.
	 */
	public logToolCall(toolName: string, input: Record<string, unknown>, checkpointBefore?: string) {
		const timestamp = Date.now()
		this.toolCallHistory.push({
			toolName,
			input,
			timestamp,
			checkpointBefore,
		})

		// Log for debugging/research
		this.providerRef.deref()?.log(`[Task#logToolCall] ${toolName} with ${Object.keys(input).length} params`)

		// Persist to Control-Plane if available (fire and forget)
		this.persistToolCallToControlPlane(toolName, input, checkpointBefore).catch(() => {
			// Ignore errors - persistence is best-effort
		})
	}

	/**
	 * Persist tool call to Control-Plane database
	 */
	private async persistToolCallToControlPlane(
		toolName: string,
		input: Record<string, unknown>,
		checkpointBefore?: string,
	): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return

		const cpPort = provider.context?.globalState.get<number>("roo.cpPort")
		const txId = provider.context?.globalState.get<string>("roo.current_tx_id")

		if (!cpPort || !txId) return

		try {
			await fetch(`http://127.0.0.1:${cpPort}/tx/${txId}/tool-call`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify({
					sub_tx_id: this.subTransactionId,
					tool_name: toolName,
					args_json: input,
					checkpoint_before: checkpointBefore,
				}),
			})
		} catch {
			// Ignore network errors - persistence is best-effort
		}
	}

	/**
	 * Get the full tool call history for this task (P3 replay).
	 */
	public getToolCallHistory() {
		return this.toolCallHistory
	}

	/**
	 * Log a model API call for reproducibility research (P3).
	 * Captures model ID and a hash of the prompt for reproducibility without storing full prompts.
	 * Also persists to Control-Plane database if available.
	 */
	public logModelCall(modelId: string, systemPrompt: string, messages: unknown[], startTime: number) {
		// Create a simple hash of the prompt content for reproducibility tracking
		// Uses a deterministic string representation
		const promptContent = JSON.stringify({ systemPrompt, messageCount: messages.length })
		const promptHash = crypto.createHash("sha256").update(promptContent).digest("hex")

		const durationMs = Date.now() - startTime

		this.modelCallHistory.push({
			modelId,
			promptHash: promptHash.slice(0, 16), // Keep short version in memory
			messageCount: messages.length,
			timestamp: startTime,
			durationMs,
		})

		this.providerRef
			.deref()
			?.log?.(
				`[Task#logModelCall] ${modelId} with ${messages.length} messages (hash: ${promptHash.slice(0, 16)})`,
			)

		// Persist to Control-Plane if available (fire and forget)
		this.persistModelCallToControlPlane(modelId, promptHash, messages.length, durationMs).catch(() => {
			// Ignore errors - persistence is best-effort
		})
	}

	/**
	 * Persist model call to Control-Plane database
	 */
	private async persistModelCallToControlPlane(
		modelId: string,
		promptHash: string,
		messageCount: number,
		durationMs: number,
	): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return

		const cpPort = provider.context?.globalState.get<number>("roo.cpPort")
		const txId = provider.context?.globalState.get<string>("roo.current_tx_id")

		if (!cpPort || !txId) return

		try {
			await fetch(`http://127.0.0.1:${cpPort}/tx/${txId}/model-call`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "human",
				},
				body: JSON.stringify({
					sub_tx_id: this.subTransactionId,
					model_id: modelId,
					prompt_hash: promptHash,
					message_count: messageCount,
					duration_ms: durationMs,
				}),
			})
		} catch {
			// Ignore network errors - persistence is best-effort
		}
	}

	/**
	 * Get the full model call history for this task (P3 reproducibility).
	 */
	public getModelCallHistory() {
		return this.modelCallHistory
	}

	public recordToolError(toolName: ToolName, error?: string) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].failures++

		if (error) {
			this.emit(RooCodeEventName.TaskToolFailed, this.taskId, toolName, error)
		}
	}

	/**
	 * Persist GPT-5 per-turn metadata (previous_response_id, instructions, reasoning_summary)
	 * onto the last complete assistant say("text") message.
	 */
	private async persistGpt5Metadata(reasoningMessage?: string): Promise<void> {
		try {
			const modelId = this.api.getModel().id
			if (!modelId || !modelId.startsWith("gpt-5")) return

			// Check if the API handler has a getLastResponseId method (OpenAiNativeHandler specific)
			const handler = this.api as ApiHandler & { getLastResponseId?: () => string | undefined }
			const lastResponseId = handler.getLastResponseId?.()
			const idx = findLastIndex(
				this.clineMessages,
				(m) => m.type === "say" && m.say === "text" && m.partial !== true,
			)
			if (idx !== -1) {
				const msg = this.clineMessages[idx] as ClineMessage & ClineMessageWithMetadata
				if (!msg.metadata) {
					msg.metadata = {}
				}
				const gpt5Metadata: Gpt5Metadata = {
					...(msg.metadata.gpt5 ?? {}),
					previous_response_id: lastResponseId,
					instructions: this.lastUsedInstructions,
					reasoning_summary: (reasoningMessage ?? "").trim() || undefined,
				}
				msg.metadata.gpt5 = gpt5Metadata
			}
		} catch (error) {
			console.error(`[Task#${this.taskId}] Error persisting GPT-5 metadata:`, error)
			// Non-fatal error in metadata persistence
		}
	}

	// Getters

	public get taskStatus(): TaskStatus {
		if (this.interactiveAsk) {
			return TaskStatus.Interactive
		}

		if (this.resumableAsk) {
			return TaskStatus.Resumable
		}

		if (this.idleAsk) {
			return TaskStatus.Idle
		}

		return TaskStatus.Running
	}

	public get taskAsk(): ClineMessage | undefined {
		return this.idleAsk || this.resumableAsk || this.interactiveAsk
	}

	public get queuedMessages(): QueuedMessage[] {
		return this.messageQueueService.messages
	}

	public get tokenUsage(): TokenUsage | undefined {
		if (this.tokenUsageSnapshot && this.tokenUsageSnapshotAt) {
			return this.tokenUsageSnapshot
		}

		this.tokenUsageSnapshot = this.getTokenUsage()
		this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts

		return this.tokenUsageSnapshot
	}

	public get cwd() {
		return this.workspacePath
	}

	/**
	 * Process any queued messages by dequeuing and submitting them.
	 * This ensures that queued user messages are sent when appropriate,
	 * preventing them from getting stuck in the queue.
	 *
	 * @param context - Context string for logging (e.g., the calling tool name)
	 */
	public processQueuedMessages(): void {
		try {
			if (!this.messageQueueService.isEmpty()) {
				const queued = this.messageQueueService.dequeueMessage()
				if (queued) {
					setTimeout(() => {
						this.submitUserMessage(queued.text, queued.images).catch((err) =>
							console.error(`[Task] Failed to submit queued message:`, err),
						)
					}, 0)
				}
			}
		} catch (e) {
			console.error(`[Task] Queue processing error:`, e)
		}
	}
}
