/**
 * Approval decisions for planner sub-agents.
 *
 * A planner sub-agent runs in the background inside its own sub-transaction
 * worktree. The chat view only shows — and only answers asks for — the task on
 * top of the stack, so with several sub-agents running in parallel nobody
 * answers their asks: approvals collide and edits are silently dropped.
 *
 * Sub-agents therefore never wait for the webview. Each ask is decided here,
 * in the extension host, from the user's auto-approval settings (the same
 * rules the chat view applies). Anything the settings do not allow BLOCKS the
 * sub-agent with a reason, which fails its sub-transaction visibly instead of
 * hanging or guessing.
 */
import type { ClineAsk } from "@roo-code/types"

export type HeadlessDecision =
	| { kind: "approve" }
	| { kind: "respond"; text: string }
	| { kind: "block"; reason: string }

export interface HeadlessApprovalSettings {
	autoApprovalEnabled?: boolean
	alwaysAllowReadOnly?: boolean
	alwaysAllowReadOnlyOutsideWorkspace?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowWriteOutsideWorkspace?: boolean
	alwaysAllowWriteProtected?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowBrowser?: boolean
	alwaysAllowMcp?: boolean
	alwaysAllowModeSwitch?: boolean
	alwaysAllowSubtasks?: boolean
	alwaysAllowFollowupQuestions?: boolean
	alwaysAllowUpdateTodoList?: boolean
	alwaysApproveResubmit?: boolean
	allowedCommands?: string[]
	deniedCommands?: string[]
}

const READ_ONLY_TOOLS = new Set([
	"readFile",
	"listFiles",
	"listFilesTopLevel",
	"listFilesRecursive",
	"listCodeDefinitionNames",
	"searchFiles",
	"codebaseSearch",
	"runSlashCommand",
])

const WRITE_TOOLS = new Set([
	"editedExistingFile",
	"appliedDiff",
	"newFileCreated",
	"searchAndReplace",
	"insertContent",
	"generateImage",
])

const block = (reason: string): HeadlessDecision => ({ kind: "block", reason })
const approve: HeadlessDecision = { kind: "approve" }

/** Split a command line on shell operators (outside quotes) into its simple commands. */
export function splitCommandParts(command: string): string[] {
	const parts: string[] = []
	let current = ""
	let quote: '"' | "'" | null = null
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!
		if (quote) {
			current += ch
			if (ch === quote) quote = null
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			current += ch
			continue
		}
		const two = command.slice(i, i + 2)
		if (two === "&&" || two === "||") {
			parts.push(current)
			current = ""
			i++
			continue
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			parts.push(current)
			current = ""
			continue
		}
		current += ch
	}
	parts.push(current)
	return parts.map((p) => p.trim()).filter(Boolean)
}

/**
 * Allow-list check for a command: every simple command must match an allowed
 * prefix (or "*") and none may match a denied prefix that is at least as specific.
 */
export function isCommandAllowed(command: string, allowed: string[] = [], denied: string[] = []): boolean {
	const parts = splitCommandParts(command)
	if (parts.length === 0) return false
	const longest = (part: string, prefixes: string[]) => {
		let best = -1
		for (const raw of prefixes) {
			const prefix = raw.trim().toLowerCase()
			if (!prefix) continue
			if (prefix === "*") best = Math.max(best, 0)
			else if (part.startsWith(prefix)) best = Math.max(best, prefix.length)
		}
		return best
	}
	return parts.every((raw) => {
		const part = raw.toLowerCase()
		const allow = longest(part, allowed)
		if (allow < 0) return false
		return longest(part, denied) < Math.max(allow, 1)
	})
}

export function decideHeadlessAsk(
	type: ClineAsk,
	text: string | undefined,
	isProtected: boolean | undefined,
	s: HeadlessApprovalSettings,
): HeadlessDecision {
	const auto = !!s.autoApprovalEnabled
	const needs = (setting: string) =>
		`'${type}' needs approval, but planner sub-agents run in the background and ${setting} is not enabled in auto-approve`

	switch (type) {
		case "tool": {
			let tool: any = {}
			try {
				tool = JSON.parse(text || "{}") ?? {}
			} catch {
				tool = {}
			}
			const name: string | undefined = tool.tool
			// Finishing is how a sub-agent hands its work back to the plan.
			if (name === "finishTask") return approve
			if (name === "updateTodoList") return approve
			if (!auto) return block(needs("auto-approval"))
			if (name === "newTask") return s.alwaysAllowSubtasks ? approve : block(needs("'subtasks'"))
			if (name === "switchMode") return s.alwaysAllowModeSwitch ? approve : block(needs("'mode switching'"))
			if (name === "fetchInstructions") {
				if (tool.content === "create_mode")
					return s.alwaysAllowModeSwitch ? approve : block(needs("'mode switching'"))
				if (tool.content === "create_mcp_server") return s.alwaysAllowMcp ? approve : block(needs("'MCP'"))
				return block(needs("this instruction fetch"))
			}
			const outside =
				!!tool.isOutsideWorkspace ||
				(Array.isArray(tool.batchFiles) && tool.batchFiles.some((f: any) => f?.isOutsideWorkspace))
			if (name && READ_ONLY_TOOLS.has(name)) {
				if (!s.alwaysAllowReadOnly) return block(needs("'read'"))
				if (outside && !s.alwaysAllowReadOnlyOutsideWorkspace)
					return block(needs("'read outside the workspace'"))
				return approve
			}
			if (name && WRITE_TOOLS.has(name)) {
				if (!s.alwaysAllowWrite) return block(needs("'write'"))
				if (outside && !s.alwaysAllowWriteOutsideWorkspace) return block(needs("'write outside the workspace'"))
				if (isProtected && !s.alwaysAllowWriteProtected) return block(needs("'write protected files'"))
				return approve
			}
			return block(`'${name ?? "unknown tool"}' cannot be approved for a background sub-agent`)
		}
		case "command": {
			if (!auto || !s.alwaysAllowExecute) return block(needs("'execute'"))
			if (!isCommandAllowed(text ?? "", s.allowedCommands, s.deniedCommands))
				return block(`command is not in the allowed-commands list: ${(text ?? "").slice(0, 120)}`)
			return approve
		}
		case "command_output":
			return approve
		case "followup":
			return {
				kind: "respond",
				text: "No user is available to answer: you are a background sub-agent. Proceed with reasonable defaults.",
			}
		case "completion_result":
		case "resume_task":
		case "resume_completed_task":
			return approve
		case "api_req_failed":
			return auto && s.alwaysApproveResubmit
				? approve
				: block("the model request failed and automatic retry is not enabled")
		case "browser_action_launch":
			return auto && s.alwaysAllowBrowser ? approve : block(needs("'browser'"))
		case "use_mcp_server":
			return auto && s.alwaysAllowMcp ? approve : block(needs("'MCP'"))
		case "mistake_limit_reached":
			return block("the sub-agent made too many consecutive mistakes and could not make progress")
		case "auto_approval_max_req_reached":
			return block("the auto-approval request limit was reached")
		default:
			return block(`'${type}' cannot be answered by a background sub-agent`)
	}
}

/**
 * Can planner sub-agents do their job (read + edit files) under these settings?
 * When not, the planner is skipped and the task runs as a single interactive agent.
 */
export function canRunHeadlessSubAgents(s: HeadlessApprovalSettings): { ok: true } | { ok: false; reason: string } {
	if (!s.autoApprovalEnabled) return { ok: false, reason: "auto-approval is off" }
	if (!s.alwaysAllowReadOnly) return { ok: false, reason: "auto-approve 'read' is off" }
	if (!s.alwaysAllowWrite) return { ok: false, reason: "auto-approve 'write' is off" }
	return { ok: true }
}
