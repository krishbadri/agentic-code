// npx vitest run core/task/__tests__/Task.transaction.spec.ts
//
// Control-Plane integration of Task: planner fallback (EXT-1) and the per-task
// transaction lifecycle (EXT-2).

import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ControlPlaneUnavailableError } from "../../control-plane/client"

vi.mock("delay", () => ({ __esModule: true, default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("execa", () => ({ execa: vi.fn() }))
vi.mock("p-wait-for", () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../../ignore/RooIgnoreController")
vi.mock("../../environment/getEnvironmentDetails", () => ({ getEnvironmentDetails: vi.fn().mockResolvedValue("") }))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: { QuickFix: { value: "quickfix" }, RefactorRewrite: { value: "refactor.rewrite" } },
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [],
			tabGroups: { all: [], close: vi.fn(), onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })) },
			showErrorMessage: vi.fn(),
			showWarningMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: "/ws" }, name: "ws", index: 0 }],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: { stat: vi.fn().mockResolvedValue({ type: 1 }) },
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: any) => defaultValue })),
		},
		env: { uriScheme: "vscode", language: "en" },
		EventEmitter: vi.fn().mockImplementation(() => ({ event: vi.fn(), fire: vi.fn() })),
		Disposable: { from: vi.fn() },
		TabInputText: vi.fn(),
		Uri: { file: (p: string) => ({ fsPath: p }) },
		RelativePattern: vi.fn(),
	}
})

const cpState = vi.hoisted(() => ({ port: undefined as number | undefined }))

vi.mock("../../control-plane/client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	return {
		...actual,
		waitForControlPlane: vi.fn(async () => cpState.port),
		getCpPort: vi.fn(() => cpState.port),
		isTransactionalModeEnabled: vi.fn(() => true),
		isPlannerModeEnabled: vi.fn(() => true),
	}
})

vi.mock("../../control-plane/tx", () => ({
	begin: vi.fn(),
	getTx: vi.fn(),
	abort: vi.fn(),
	commit: vi.fn(),
	toolCall: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
	modelCall: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
	rollback: vi.fn(),
}))

const planner = vi.hoisted(() => ({
	generatePlan: vi.fn(),
	executePlan: vi.fn(),
	rollbackAllSubTransactions: vi.fn(),
}))

vi.mock("../../planner/PlannerAgent", () => ({
	PlannerAgent: vi.fn().mockImplementation(() => ({ generatePlan: planner.generatePlan })),
	shouldOpenCircuitBreaker: () => false,
}))

vi.mock("../../planner/PlanExecutor", () => ({
	PlanExecutor: vi.fn().mockImplementation(() => ({
		executePlan: planner.executePlan,
		rollbackAllSubTransactions: planner.rollbackAllSubTransactions,
	})),
}))

vi.mock("../../checkpoints/QualityGate", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	return {
		...actual,
		detectProjectCommands: vi.fn(() => ({ type: "node", testCommand: "npx vitest run", compileCommand: null })),
	}
})

import * as cpTx from "../../control-plane/tx"

const COMPLEX_TASK = "Implement a new authentication module in src/auth.ts and add routes in src/routes.ts"

function makeProvider() {
	return {
		context: {
			globalStorageUri: { fsPath: "/tmp/roo-test-storage" },
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
		},
		getState: vi.fn().mockResolvedValue({ mode: "code" }),
		log: vi.fn(),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue(undefined),
	} as any
}

function makeTask(provider = makeProvider(), extra: Record<string, unknown> = {}) {
	const task = new Task({
		provider,
		apiConfiguration: { apiProvider: "anthropic", apiKey: "k", apiModelId: "claude-3-5-sonnet-20241022" },
		task: COMPLEX_TASK,
		startTask: false,
		workspacePath: "/ws",
		...extra,
	} as any)
	const say = vi.spyOn(task, "say").mockResolvedValue(undefined as any)
	const loop = vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)
	vi.spyOn(task as any, "generateImplementationContext").mockResolvedValue("")
	vi.spyOn(task as any, "cancelAllChildTasks").mockResolvedValue(undefined)
	return { task, say, loop, provider }
}

const saidTexts = (say: { mock: { calls: unknown[][] } }) => say.mock.calls.map((c) => String(c[1] ?? ""))

describe("Task planner fallback (EXT-1)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		cpState.port = undefined
		planner.generatePlan.mockResolvedValue({
			title: "p",
			summary: "s",
			subTransactions: [{ id: "st1", title: "a", prompt: "do a" }],
		})
		planner.executePlan.mockResolvedValue({ success: true, parentTxId: "tx-1" })
		vi.mocked(cpTx.begin).mockResolvedValue({
			ok: true,
			status: 200,
			data: {
				tx_id: "tx-1",
				base_commit: "base1",
				branch: "tx/tx-1",
				worktree_path: "/ws/.cp/worktrees/tx_tx-1",
			},
		} as any)
		vi.mocked(cpTx.commit).mockResolvedValue({
			ok: true,
			status: 200,
			data: { merged_sha: "m1", liveness: { ran: false } },
		} as any)
		vi.mocked(cpTx.abort).mockResolvedValue({ ok: true, status: 200, data: {} } as any)
	})

	it("with the CP down there is no planner call and the normal loop runs", async () => {
		const { task, say, loop } = makeTask()
		await (task as any).startTask(COMPLEX_TASK)

		expect(planner.generatePlan).not.toHaveBeenCalled()
		expect(planner.executePlan).not.toHaveBeenCalled()
		expect(loop).toHaveBeenCalledTimes(1)
		expect(saidTexts(say).some((t) => t.includes("Control-Plane unavailable; executing as single agent"))).toBe(
			true,
		)
	})

	it("the CP failing mid-plan falls through to the normal loop", async () => {
		cpState.port = 4000
		planner.executePlan.mockRejectedValue(new ControlPlaneUnavailableError("Control-Plane unreachable"))
		const { task, say, loop } = makeTask()
		await (task as any).startTask(COMPLEX_TASK)

		expect(planner.executePlan).toHaveBeenCalled()
		expect(loop).toHaveBeenCalledTimes(1)
		expect(task.finishedSuccessfully).toBeFalsy()
		expect(saidTexts(say).some((t) => t.includes("executing as single agent"))).toBe(true)
	})

	it("any other planner error stops the task", async () => {
		cpState.port = 4000
		planner.executePlan.mockRejectedValue(new Error("Sub-transaction creation failed"))
		const { task, say, loop } = makeTask()
		await (task as any).startTask(COMPLEX_TASK)

		expect(loop).not.toHaveBeenCalled()
		expect(task.finishedSuccessfully).toBe(true)
		expect(saidTexts(say).some((t) => t.includes("Planner mode failed"))).toBe(true)
	})
})
