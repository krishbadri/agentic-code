// npx vitest run core/tools/__tests__/saveCheckpointTool.spec.ts

const saveCheckpoint = vi.fn()
const simpleGitFactory = vi.fn()

vi.mock("../../checkpoints", () => ({
	checkpointSaveManual: vi.fn(),
	getCheckpointService: vi.fn(async () => ({ saveCheckpoint })),
}))

vi.mock("../../checkpoints/QualityGate", () => ({
	evaluateQualityGate: vi.fn(async () => ({ action: "skip", reason: "no project" })),
	recordCheckpointSaved: vi.fn(),
	executeQualityGateRollback: vi.fn(),
}))

vi.mock("simple-git", () => ({ default: simpleGitFactory, simpleGit: simpleGitFactory }))

import { saveCheckpointTool, lookupCheckpointName } from "../saveCheckpointTool"

describe("saveCheckpointTool without a transaction", () => {
	beforeEach(() => {
		saveCheckpoint.mockReset()
		simpleGitFactory.mockReset()
	})

	it("returns the shadow checkpoint hash and never commits in the user's repository", async () => {
		saveCheckpoint.mockResolvedValue({ commit: "a".repeat(40) })
		const task: any = {
			taskId: "t1",
			enableCheckpoints: true,
			worktreeTxId: undefined,
			cwd: "/workspace",
			providerRef: { deref: () => ({ log: vi.fn(), postMessageToWebview: vi.fn() }) },
		}
		const pushToolResult = vi.fn()

		await saveCheckpointTool(
			task,
			{ type: "tool_use", name: "save_checkpoint", params: { name: "C1" }, partial: false } as any,
			vi.fn(),
			vi.fn(),
			pushToolResult,
			vi.fn(),
		)

		// No git client was ever opened on the workspace: the old code ran
		// `git add -A && git commit` there, sweeping up the user's uncommitted work.
		expect(simpleGitFactory).not.toHaveBeenCalled()
		expect(saveCheckpoint).toHaveBeenCalledTimes(1)
		// The hash handed to the model is the one the shadow service can restore.
		expect(lookupCheckpointName(task, "C1")).toBe("a".repeat(40))
		expect(pushToolResult.mock.calls[0]![0]).toContain("a".repeat(40))
	})
})
