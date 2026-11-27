// npx vitest run core/tools/__tests__/executeCommandTool.cp.spec.ts
//
// Control-Plane shell routing of execute_command (R31/R32/R37).

import * as path from "path"

vi.mock("vscode", () => ({
	workspace: { getConfiguration: vi.fn(() => ({ get: (_k: string, d: unknown) => d })) },
	window: { showWarningMessage: vi.fn() },
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: { toolError: vi.fn((msg: string) => `Error: ${msg}`), rooIgnoreError: vi.fn() },
}))

vi.mock("../../../integrations/terminal/Terminal", () => ({
	Terminal: { compressTerminalOutput: vi.fn((s: string) => s) },
}))
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({ TerminalRegistry: {} }))
vi.mock("../../../utils/shell", () => ({ getShell: vi.fn(() => "/bin/bash") }))
vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: {} } }))

vi.mock("../../control-plane/tx", () => ({ shellExec: vi.fn() }))
const cp = vi.hoisted(() => ({ port: 4000 as number | undefined }))
vi.mock("../../control-plane/client", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	getCpPort: vi.fn(() => cp.port),
}))

import * as cpTx from "../../control-plane/tx"
import { executeCommandTool } from "../executeCommandTool"
import { ControlPlaneUnavailableError } from "../../control-plane/client"

const WT = path.join(path.sep, "ws", ".cp", "worktrees", "tx_p_sub_st1")

function makeTask(extra: Record<string, unknown> = {}) {
	return {
		cwd: WT,
		worktreeTxId: "p_sub_st1",
		enableCheckpoints: false,
		consecutiveMistakeCount: 0,
		providerRef: { deref: () => ({ getState: vi.fn().mockResolvedValue({}), context: {}, log: vi.fn() }) },
		rooIgnoreController: { validateCommand: vi.fn(() => undefined) },
		ask: vi.fn(),
		say: vi.fn(),
		recordToolError: vi.fn(),
		...extra,
	} as any
}

async function run(task: any, params: Record<string, string>) {
	const pushToolResult = vi.fn()
	await executeCommandTool(
		task,
		{ type: "tool_use", name: "execute_command", params, partial: false } as any,
		vi.fn().mockResolvedValue(true),
		vi.fn(),
		pushToolResult,
		vi.fn((_t: string, s?: string) => s ?? ""),
	)
	return pushToolResult
}

describe("executeCommandTool Control-Plane routing", () => {
	beforeEach(() => {
		vi.mocked(cpTx.shellExec).mockReset()
		cp.port = 4000
	})

	it("routes a planner child's command to /shell/exec on its own worktree tx with cwd_rel", async () => {
		vi.mocked(cpTx.shellExec).mockResolvedValue({
			ok: true,
			status: 200,
			data: {
				exit_code: 0,
				stdout_base64: Buffer.from("hello").toString("base64"),
				stderr_base64: "",
			},
		} as any)
		const push = await run(makeTask(), { command: "npm test", cwd: path.join(WT, "pkg", "a") })

		expect(cpTx.shellExec).toHaveBeenCalledWith(4000, "p_sub_st1", {
			command: "npm test",
			shell: "bash",
			cwd_rel: "pkg/a",
			timeout_ms: 600_000,
		})
		expect(push).toHaveBeenCalledWith("hello\nExit code: 0")
	})

	it("surfaces a 403 as a tool error with the CP code and message", async () => {
		vi.mocked(cpTx.shellExec).mockResolvedValue({
			ok: false,
			status: 403,
			data: { code: "ACTION_BLOCKED", message: "recursive rm outside worktree" },
		} as any)
		const task = makeTask()
		const push = await run(task, { command: "rm -rf ~" })
		expect(push).toHaveBeenCalledWith(expect.stringMatching(/ACTION_BLOCKED: recursive rm outside worktree/))
		expect(push).not.toHaveBeenCalledWith("<no output>")
	})

	it("never runs locally when the CP is unreachable", async () => {
		vi.mocked(cpTx.shellExec).mockRejectedValue(new ControlPlaneUnavailableError("unreachable"))
		const push = await run(makeTask(), { command: "ls" })
		expect(push).toHaveBeenCalledWith(expect.stringMatching(/NOT run/))
	})

	it("never runs locally when the CP port is unknown", async () => {
		cp.port = undefined
		const push = await run(makeTask(), { command: "ls" })
		expect(cpTx.shellExec).not.toHaveBeenCalled()
		expect(push).toHaveBeenCalledWith(expect.stringMatching(/NOT run/))
	})
})
