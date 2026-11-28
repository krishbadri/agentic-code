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

const cpState = vi.hoisted(() => ({
	port: undefined as number | undefined,
	managesTaskFolder: undefined as boolean | undefined,
}))

vi.mock("../../control-plane/client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	return {
		...actual,
		waitForControlPlane: vi.fn(async () => cpState.port),
		getCpPort: vi.fn(() => cpState.port),
		isCpHealthy: vi.fn(async () => cpState.managesTaskFolder !== false),
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

/** Auto-approval settings under which planner sub-agents (which cannot prompt) can work. */
const SUB_AGENT_APPROVALS = { autoApprovalEnabled: true, alwaysAllowReadOnly: true, alwaysAllowWrite: true }

function makeProvider(state: Record<string, unknown> = SUB_AGENT_APPROVALS) {
	return {
		context: {
			globalStorageUri: { fsPath: "/tmp/roo-test-storage" },
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
		},
		getState: vi.fn().mockResolvedValue({ mode: "code", ...state }),
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

	it("runs without a transaction when the Control-Plane manages a different folder", async () => {
		// e.g. a multi-root workspace: transacting there would commit to the wrong repository.
		cpState.port = 4000
		cpState.managesTaskFolder = false
		try {
			const { task, say, loop } = makeTask()
			await (task as any).startTask(COMPLEX_TASK)

			expect(cpTx.begin).not.toHaveBeenCalled()
			expect(task.txId).toBeUndefined()
			expect(planner.generatePlan).not.toHaveBeenCalled()
			expect(loop).toHaveBeenCalledTimes(1)
			expect(saidTexts(say).some((t) => t.includes("manages a different one"))).toBe(true)
		} finally {
			cpState.managesTaskFolder = undefined
		}
	})

	it("skips the planner when auto-approval would not let sub-agents read and write", async () => {
		// Sub-agents run in the background and cannot prompt: without auto-approve the task
		// runs as one interactive agent (still inside its transaction).
		cpState.port = 4000
		for (const state of [{}, { ...SUB_AGENT_APPROVALS, alwaysAllowWrite: false }]) {
			planner.generatePlan.mockClear()
			const { task, loop, provider } = makeTask(makeProvider(state))
			await (task as any).startTask(COMPLEX_TASK)

			expect(planner.generatePlan).not.toHaveBeenCalled()
			expect(loop).toHaveBeenCalledTimes(1)
			expect(task.txId).toBe("tx-1")
			expect(provider.log.mock.calls.some((c: unknown[]) => String(c[0]).includes("Skipping planner mode"))).toBe(
				true,
			)
		}
	})

	it("a failure to produce a plan continues as a single agent inside the same transaction", async () => {
		cpState.port = 4000
		planner.generatePlan.mockRejectedValue(new Error("Failed to generate plan: 404 model unavailable"))
		const { task, say, loop } = makeTask()
		await (task as any).startTask(COMPLEX_TASK)

		expect(planner.executePlan).not.toHaveBeenCalled()
		expect(loop).toHaveBeenCalledTimes(1)
		expect(task.txId).toBe("tx-1")
		expect(cpTx.abort).not.toHaveBeenCalled()
		expect(task.finishedSuccessfully).toBeFalsy()
		expect(saidTexts(say).some((t) => t.includes("continuing as a single agent"))).toBe(true)
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

describe("Task transaction lifecycle (EXT-2)", () => {
	let nextTx = 0

	beforeEach(() => {
		vi.clearAllMocks()
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		cpState.port = 4000
		nextTx = 0
		vi.mocked(cpTx.begin).mockImplementation(async () => {
			nextTx++
			return {
				ok: true,
				status: 200,
				data: {
					tx_id: `tx-${nextTx}`,
					base_commit: `base${nextTx}`,
					branch: `tx/tx-${nextTx}`,
					worktree_path: `/ws/.cp/worktrees/tx_tx-${nextTx}`,
				},
			} as any
		})
		vi.mocked(cpTx.abort).mockResolvedValue({ ok: true, status: 200, data: {} } as any)
		planner.generatePlan.mockResolvedValue({ title: "p", summary: "s", subTransactions: [] })
	})

	const historyItem = {
		id: "h1",
		number: 1,
		ts: 1,
		task: COMPLEX_TASK,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		txId: "tx-old",
	}

	it("each top-level task begins its own transaction (no stale global id)", async () => {
		const a = makeTask()
		const b = makeTask()
		await (a.task as any).startTask(COMPLEX_TASK)
		await (b.task as any).startTask(COMPLEX_TASK)

		expect(a.task.txId).toBe("tx-1")
		expect(b.task.txId).toBe("tx-2")
		expect(a.task.cwd).toBe("/ws/.cp/worktrees/tx_tx-1")
		expect(a.task.diffViewProvider.cwd).toBe("/ws/.cp/worktrees/tx_tx-1")
		expect(a.task.originalWorkspacePath).toBe("/ws")
		expect(a.task.historyWorkspace).toBe("/ws")
		expect(cpTx.begin).toHaveBeenCalledWith(4000, expect.objectContaining({ isolation: "hybrid", base: "HEAD" }))
		// The global id is never consulted or written
		expect(a.provider.context.globalState.update).not.toHaveBeenCalledWith("roo.current_tx_id", expect.anything())
	})

	it("passes the detected test command to /tx/begin", async () => {
		const { task } = makeTask()
		await task.ensureTaskTransaction()
		expect(cpTx.begin).toHaveBeenCalledWith(4000, expect.objectContaining({ test_command: "npx vitest run" }))
	})

	it("subtasks never begin their own transaction", async () => {
		const parent = makeTask().task
		const child = makeTask(makeProvider(), { parentTask: parent }).task
		expect(await child.ensureTaskTransaction()).toBeUndefined()
		expect(cpTx.begin).not.toHaveBeenCalled()
	})

	it("commit sends the strategy, clears the tx and restores the workspace on 200", async () => {
		const { task } = makeTask()
		await task.ensureTaskTransaction()
		vi.mocked(cpTx.commit).mockResolvedValue({
			ok: true,
			status: 200,
			data: { merged_sha: "m1", liveness: { ran: true, passed: true } },
		} as any)

		const outcome = await task.commitTaskTransaction()
		expect(cpTx.commit).toHaveBeenCalledWith(4000, "tx-1", { strategy: "rebase" })
		expect(outcome).toEqual({ kind: "committed", mergedSha: "m1", liveness: { ran: true, passed: true } })
		expect(task.txId).toBeUndefined()
		expect(task.cwd).toBe("/ws")
		expect(task.diffViewProvider.cwd).toBe("/ws")
	})

	it("403 LIVENESS_FAILED returns the rollback target and keeps the tx", async () => {
		const { task } = makeTask()
		await task.ensureTaskTransaction()
		vi.mocked(cpTx.commit).mockResolvedValue({
			ok: false,
			status: 403,
			data: { code: "LIVENESS_FAILED", message: "1 failing", rollback_to: "abc123" },
		} as any)
		const outcome = await task.commitTaskTransaction()
		expect(outcome).toMatchObject({ kind: "liveness", rollbackTo: "abc123" })
		expect(task.txId).toBe("tx-1")
	})

	it("409 keeps the tx open", async () => {
		const { task } = makeTask()
		await task.ensureTaskTransaction()
		vi.mocked(cpTx.commit).mockResolvedValue({
			ok: false,
			status: 409,
			data: { code: "WORKSPACE_DIRTY", message: "dirty", files: ["a.ts"] },
		} as any)
		const outcome = await task.commitTaskTransaction()
		expect(outcome).toMatchObject({ kind: "conflict", code: "WORKSPACE_DIRTY", files: ["a.ts"] })
		expect(task.txId).toBe("tx-1")
		expect(task.cwd).toBe("/ws/.cp/worktrees/tx_tx-1")
	})

	it("network errors and 5xx fail closed", async () => {
		const { task } = makeTask()
		await task.ensureTaskTransaction()
		vi.mocked(cpTx.commit).mockRejectedValueOnce(new ControlPlaneUnavailableError("unreachable"))
		expect((await task.commitTaskTransaction()).kind).toBe("error")
		vi.mocked(cpTx.commit).mockResolvedValueOnce({ ok: false, status: 500, data: { message: "boom" } } as any)
		expect((await task.commitTaskTransaction()).kind).toBe("error")
		expect(task.txId).toBe("tx-1")
	})

	it("aborting the task does not discard the transaction", async () => {
		const { task } = makeTask()
		await task.ensureTaskTransaction()
		vi.spyOn(task as any, "saveClineMessages").mockResolvedValue(undefined)
		await task.abortTask()
		expect(cpTx.abort).not.toHaveBeenCalled()
	})

	it("explicit discard aborts the transaction and restores the workspace", async () => {
		const { task } = makeTask()
		await task.ensureTaskTransaction()
		expect(await task.abortTaskTransaction("discarded by user")).toBe(true)
		expect(cpTx.abort).toHaveBeenCalledWith(4000, "tx-1", "discarded by user")
		expect(task.txId).toBeUndefined()
		expect(task.cwd).toBe("/ws")
	})

	it("resume reuses the recorded transaction when it is still active", async () => {
		vi.mocked(cpTx.getTx).mockResolvedValue({
			ok: true,
			status: 200,
			data: { status: "active", worktree_path: "/ws/.cp/worktrees/tx_old", base_commit: "b0" },
		} as any)
		const { task } = makeTask(makeProvider(), { historyItem, task: undefined })
		await task.ensureTaskTransaction()
		expect(cpTx.getTx).toHaveBeenCalledWith(4000, "tx-old")
		expect(cpTx.begin).not.toHaveBeenCalled()
		expect(task.txId).toBe("tx-old")
		expect(task.cwd).toBe("/ws/.cp/worktrees/tx_old")
	})

	it("a resumed task that saves before re-attaching keeps the recorded transaction id", async () => {
		// The resume prompt is saved to history before the transaction is re-attached. Saving
		// without the id orphaned the open transaction (found by the VS Code e2e suite).
		const { task, provider } = makeTask(makeProvider(), { historyItem, task: undefined })
		await (task as any).saveClineMessages()
		const saved = provider.updateTaskHistory.mock.calls.at(-1)?.[0]
		expect(saved?.txId).toBe("tx-old")
	})

	it("resume begins a new transaction when the recorded one is no longer active", async () => {
		vi.mocked(cpTx.getTx).mockResolvedValue({ ok: false, status: 404, data: { code: "TX_NOT_FOUND" } } as any)
		const { task } = makeTask(makeProvider(), { historyItem, task: undefined })
		await task.ensureTaskTransaction()
		expect(cpTx.begin).toHaveBeenCalled()
		expect(task.txId).toBe("tx-1")
	})

	it("planner success commits through the single commit path", async () => {
		planner.generatePlan.mockResolvedValue({
			title: "p",
			summary: "s",
			subTransactions: [{ id: "st1", title: "a", prompt: "x" }],
		})
		planner.executePlan.mockResolvedValue({ success: true, parentTxId: "tx-1" })
		vi.mocked(cpTx.commit).mockResolvedValue({ ok: true, status: 200, data: { merged_sha: "m1" } } as any)
		const { task, loop } = makeTask()
		await (task as any).startTask(COMPLEX_TASK)
		expect(cpTx.commit).toHaveBeenCalledWith(4000, "tx-1", { strategy: "rebase" })
		expect(loop).not.toHaveBeenCalled()
		expect(task.txId).toBeUndefined()
	})

	it("plan failure aborts the transaction and reports ids + reasons", async () => {
		planner.generatePlan.mockResolvedValue({
			title: "p",
			summary: "s",
			subTransactions: [{ id: "st1", title: "a", prompt: "x" }],
		})
		planner.executePlan.mockResolvedValue({
			success: false,
			parentTxId: "tx-1",
			failedSubTransactions: ["st1"],
			failures: [{ subTxId: "st1", reason: "STRUCTURAL_CONFLICT with st0" }],
		})
		const { task, say } = makeTask()
		await (task as any).startTask(COMPLEX_TASK)
		expect(cpTx.commit).not.toHaveBeenCalled()
		expect(cpTx.abort).toHaveBeenCalledWith(4000, "tx-1", "plan failed")
		expect(saidTexts(say).some((t) => t.includes("Plan failed: st1") && t.includes("STRUCTURAL_CONFLICT"))).toBe(
			true,
		)
	})
})

describe("Task.spawnChildTasks (R13)", () => {
	it("refuses to spawn a sub-transaction without a worktree", async () => {
		const { task } = makeTask()
		await expect(
			task.spawnChildTasks({ subTransactions: [{ id: "st1", prompt: "x" } as any], worktrees: new Map() }),
		).rejects.toThrow(/without a worktree: st1/)
	})
})
