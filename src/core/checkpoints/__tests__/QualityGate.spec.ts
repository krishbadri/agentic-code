// npx vitest run core/checkpoints/__tests__/QualityGate.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("execa", () => ({ execa: vi.fn() }))

vi.mock("fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const existsSync = vi.fn((p: string) => /package\.json$/.test(String(p).replace(/\\/g, "/")))
	const readFileSync = vi.fn(() => JSON.stringify({ devDependencies: { vitest: "^3" } }))
	return { ...actual, existsSync, readFileSync, default: { ...actual, existsSync, readFileSync } }
})

vi.mock("../index", () => ({ rollbackToCheckpointManual: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../../../utils/path", () => ({ getWorkspacePath: vi.fn(() => "/ws") }))

import { execa } from "execa"
import { rollbackToCheckpointManual } from "../index"
import {
	capturePreEditBaseline,
	runPostEditQualityGate,
	detectProjectCommands,
	clearQualityGateState,
} from "../QualityGate"

const vitestOutput = (passing: number, failing: number) => ({
	stdout: JSON.stringify({
		numPassedTests: passing,
		numFailedTests: failing,
		numTotalTests: passing + failing,
	}),
	stderr: "",
	exitCode: failing ? 1 : 0,
})

let taskCounter = 0
function makeTask(extra: Record<string, unknown> = {}) {
	const hashes = ["post1", "post2", "post3"]
	return {
		taskId: `qg-task-${++taskCounter}`,
		cwd: "/ws",
		enableCheckpoints: true,
		worktreeTxId: undefined as string | undefined,
		currentStreamingDidCheckpoint: true,
		userMessageContent: [] as any[],
		providerRef: { deref: () => ({ log: vi.fn() }) },
		checkpointSave: vi.fn(async () => ({ hash: hashes.shift() })),
		...extra,
	} as any
}

describe("detectProjectCommands", () => {
	it("checks package.json before Python markers and returns plain commands", () => {
		expect(detectProjectCommands("/ws")).toEqual({
			type: "node",
			testCommand: "npx vitest run",
			compileCommand: null,
		})
	})
})

describe("QualityGate edit loop (local mode)", () => {
	beforeEach(() => {
		vi.mocked(execa).mockReset()
		vi.mocked(rollbackToCheckpointManual).mockClear()
	})

	it("records a pre-edit baseline, then the POST-edit checkpoint hash", async () => {
		const task = makeTask()
		vi.mocked(execa).mockResolvedValue(vitestOutput(5, 0) as any)

		await capturePreEditBaseline(task, "pre0")
		expect(execa).toHaveBeenCalledWith("npx vitest run --reporter=json", expect.objectContaining({ cwd: "/ws" }))

		await runPostEditQualityGate(task)
		// No regression → a post-edit checkpoint is taken
		expect(task.checkpointSave).toHaveBeenCalledWith(true)
		expect(task.userMessageContent).toEqual([])

		// A regression now rolls back to the post-edit hash recorded above (not "pre0")
		vi.mocked(execa).mockResolvedValue(vitestOutput(3, 2) as any)
		await runPostEditQualityGate(task)
		expect(rollbackToCheckpointManual).toHaveBeenCalledWith(task, "post1")
		clearQualityGateState(task.taskId)
	})

	it("a regression on the first edit rolls back to the pre-edit baseline", async () => {
		const task = makeTask()
		vi.mocked(execa).mockResolvedValueOnce(vitestOutput(5, 0) as any)
		await capturePreEditBaseline(task, "pre0")

		vi.mocked(execa).mockResolvedValue(vitestOutput(4, 1) as any)
		await runPostEditQualityGate(task)

		expect(rollbackToCheckpointManual).toHaveBeenCalledWith(task, "pre0")
		expect(task.checkpointSave).not.toHaveBeenCalled()
		expect(task.currentStreamingDidCheckpoint).toBe(false)
		expect(task.userMessageContent[0].text).toMatch(/AUTOMATIC ROLLBACK/)
		clearQualityGateState(task.taskId)
	})
})

describe("QualityGate edit loop (Control-Plane mode)", () => {
	beforeEach(() => {
		vi.mocked(execa).mockReset()
		vi.mocked(rollbackToCheckpointManual).mockClear()
	})

	it("runs no local tests; the CP checkpoint is the gate", async () => {
		const task = makeTask({ worktreeTxId: "tx-1", checkpointSave: vi.fn(async () => ({ hash: "cp1" })) })
		await capturePreEditBaseline(task, "pre0")
		await runPostEditQualityGate(task)

		expect(execa).not.toHaveBeenCalled()
		expect(task.checkpointSave).toHaveBeenCalledTimes(1)
		expect(task.userMessageContent).toEqual([])
	})

	it("a PROGRESS_VIOLATION shows the automatic rollback notice", async () => {
		const task = makeTask({
			worktreeTxId: "tx-1",
			checkpointSave: vi.fn(async () => ({
				progressViolation: {
					kind: "tests",
					rollbackTo: "abcdef1234",
					currentCount: 3,
					lastCount: 5,
					message: "PROGRESS_VIOLATION: passing tests decreased",
				},
			})),
		})
		await runPostEditQualityGate(task)

		expect(execa).not.toHaveBeenCalled()
		expect(rollbackToCheckpointManual).not.toHaveBeenCalled() // the CP already rolled back
		expect(task.userMessageContent[0].text).toMatch(/AUTOMATIC ROLLBACK/)
		expect(task.userMessageContent[0].text).toMatch(/abcdef1/)
		expect(task.currentStreamingDidCheckpoint).toBe(false)
	})
})
