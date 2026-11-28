// npx vitest run core/task/__tests__/headlessApproval.spec.ts

import {
	canRunHeadlessSubAgents,
	decideHeadlessAsk,
	isCommandAllowed,
	splitCommandParts,
	type HeadlessApprovalSettings,
} from "../headlessApproval"

const ALL: HeadlessApprovalSettings = {
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: true,
	alwaysAllowWrite: true,
	alwaysAllowExecute: true,
	allowedCommands: ["*"],
}
const tool = (t: Record<string, unknown>) => JSON.stringify(t)

describe("decideHeadlessAsk", () => {
	it("approves reads and writes only when the matching auto-approve setting is on", () => {
		expect(decideHeadlessAsk("tool", tool({ tool: "readFile" }), false, ALL).kind).toBe("approve")
		expect(decideHeadlessAsk("tool", tool({ tool: "newFileCreated" }), false, ALL).kind).toBe("approve")
		expect(decideHeadlessAsk("tool", tool({ tool: "appliedDiff" }), false, ALL).kind).toBe("approve")

		const readOnly = { ...ALL, alwaysAllowWrite: false }
		expect(decideHeadlessAsk("tool", tool({ tool: "readFile" }), false, readOnly).kind).toBe("approve")
		const d = decideHeadlessAsk("tool", tool({ tool: "editedExistingFile" }), false, readOnly)
		expect(d.kind).toBe("block")
		expect((d as any).reason).toMatch(/'write' is not enabled/)

		expect(
			decideHeadlessAsk("tool", tool({ tool: "readFile" }), false, { ...ALL, autoApprovalEnabled: false }).kind,
		).toBe("block")
	})

	it("respects outside-workspace and protected-file settings", () => {
		const outside = tool({ tool: "editedExistingFile", isOutsideWorkspace: true })
		expect(decideHeadlessAsk("tool", outside, false, ALL).kind).toBe("block")
		expect(decideHeadlessAsk("tool", outside, false, { ...ALL, alwaysAllowWriteOutsideWorkspace: true }).kind).toBe(
			"approve",
		)
		const edit = tool({ tool: "editedExistingFile" })
		expect(decideHeadlessAsk("tool", edit, true, ALL).kind).toBe("block")
		expect(decideHeadlessAsk("tool", edit, true, { ...ALL, alwaysAllowWriteProtected: true }).kind).toBe("approve")
		const batch = tool({ tool: "readFile", batchFiles: [{ isOutsideWorkspace: true }] })
		expect(decideHeadlessAsk("tool", batch, false, ALL).kind).toBe("block")
	})

	it("always lets a sub-agent finish, and never lets it wait for a human", () => {
		const none: HeadlessApprovalSettings = {}
		expect(decideHeadlessAsk("tool", tool({ tool: "finishTask" }), false, none).kind).toBe("approve")
		expect(decideHeadlessAsk("completion_result", "", false, none).kind).toBe("approve")
		expect(decideHeadlessAsk("followup", "which db?", false, none).kind).toBe("respond")
		expect(decideHeadlessAsk("mistake_limit_reached", "", false, ALL).kind).toBe("block")
		expect(decideHeadlessAsk("auto_approval_max_req_reached", "", false, ALL).kind).toBe("block")
		expect(decideHeadlessAsk("tool", "not json", false, ALL).kind).toBe("block")
		expect(decideHeadlessAsk("tool", tool({ tool: "somethingNew" }), false, ALL).kind).toBe("block")
	})

	it("approves commands only with execute + allow-list", () => {
		expect(decideHeadlessAsk("command", "npm test", false, ALL).kind).toBe("approve")
		expect(decideHeadlessAsk("command", "npm test", false, { ...ALL, alwaysAllowExecute: false }).kind).toBe(
			"block",
		)
		const listed = { ...ALL, allowedCommands: ["npm test", "git log"] }
		expect(decideHeadlessAsk("command", "npm test -- --watch=false", false, listed).kind).toBe("approve")
		expect(decideHeadlessAsk("command", "npm install left-pad", false, listed).kind).toBe("block")
		expect(decideHeadlessAsk("command", "git log && npm install x", false, listed).kind).toBe("block")
		expect(decideHeadlessAsk("command", "npm test", false, { ...ALL, allowedCommands: [] }).kind).toBe("block")
	})

	it("gates retries, browser and MCP on their settings", () => {
		expect(decideHeadlessAsk("api_req_failed", "", false, ALL).kind).toBe("block")
		expect(decideHeadlessAsk("api_req_failed", "", false, { ...ALL, alwaysApproveResubmit: true }).kind).toBe(
			"approve",
		)
		expect(decideHeadlessAsk("browser_action_launch", "", false, ALL).kind).toBe("block")
		expect(decideHeadlessAsk("use_mcp_server", "", false, { ...ALL, alwaysAllowMcp: true }).kind).toBe("approve")
	})
})

describe("isCommandAllowed", () => {
	it("splits on shell operators outside quotes", () => {
		expect(splitCommandParts('echo "a && b" && ls | wc -l; pwd')).toEqual(['echo "a && b"', "ls", "wc -l", "pwd"])
	})

	it("requires every part to be allowed and lets a more specific deny win", () => {
		expect(isCommandAllowed("git status", ["git"], [])).toBe(true)
		expect(isCommandAllowed("git push --force", ["git"], ["git push"])).toBe(false)
		expect(isCommandAllowed("git push", ["git push origin"], ["git"])).toBe(false)
		expect(isCommandAllowed("git push origin main", ["git push origin"], ["git"])).toBe(true)
		expect(isCommandAllowed("anything", ["*"], ["rm"])).toBe(true)
		expect(isCommandAllowed("rm -rf x", ["*"], ["rm"])).toBe(false)
		expect(isCommandAllowed("", ["*"], [])).toBe(false)
	})
})

describe("canRunHeadlessSubAgents", () => {
	it("needs auto-approval with read and write", () => {
		expect(canRunHeadlessSubAgents(ALL)).toEqual({ ok: true })
		expect(canRunHeadlessSubAgents({ ...ALL, autoApprovalEnabled: false })).toMatchObject({ ok: false })
		expect(canRunHeadlessSubAgents({ ...ALL, alwaysAllowWrite: false })).toMatchObject({ ok: false })
		expect(canRunHeadlessSubAgents({})).toMatchObject({ ok: false })
	})
})
