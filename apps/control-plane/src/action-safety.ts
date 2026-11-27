/**
 * Action-Safety (R9, Slides 39/64)
 *
 * Deterministic checks BEFORE executing a tool call. The extension sends the
 * real Roo tool name (write_to_file, apply_diff, execute_command, ...), so the
 * checker maps those names to action types; anything it does not recognise is
 * DENIED by default (previously unknown actions — including every real tool
 * name — fell through to "allow").
 *
 * - file writes / deletes: worktree containment (no `..` escape, no absolute
 *   paths outside the worktree), protected segments (.git, node_modules),
 *   tests are given (R31/R32)
 * - shell commands: parsed with shell-lex so nested shells (`bash -lc "..."`),
 *   command substitution and pipelines are analysed command by command
 * - network: blocked hosts (cloud metadata, ...)
 */
import * as path from "node:path"
import { basenameCmd, effectiveArgv, splitCommands, type SimpleCommand } from "./shell-lex.js"
import { isTestFile, isTestModifyAllowed } from "./test-files.js"

export type ActionType = "file_write" | "file_delete" | "bash" | "network" | "read_only" | "unknown"

export interface ActionSafetyCheck {
	action: string
	actionType: ActionType
	args: Record<string, unknown>
	allowed: boolean
	reason?: string
	rule?: string
	/** Normalised, worktree-relative paths that were checked */
	normalized_paths?: string[]
}

export interface ActionSafetyContext {
	/** Absolute path of the worktree the action runs in (enables containment checks) */
	worktreeRoot?: string
	/** What to do with actions the checker does not recognise (default: deny) */
	unknownActionPolicy?: "deny" | "allow"
	/** Server-side allowlist of test files that MAY be modified */
	testModifyAllowlist?: string[]
}

export interface ActionSafetyConfig {
	protectedSegments: string[]
	systemPaths: string[]
	blockedHosts: string[]
}

const DEFAULT_CONFIG: ActionSafetyConfig = {
	protectedSegments: [".git", "node_modules", ".cp"],
	systemPaths: [
		"/etc",
		"/usr",
		"/bin",
		"/sbin",
		"/var",
		"/root",
		"/boot",
		"/sys",
		"/proc",
		"/dev",
		"c:/windows",
		"c:/program files",
		"c:/program files (x86)",
	],
	blockedHosts: ["169.254.169.254", "metadata.google.internal", "localhost:22", "127.0.0.1:22", "0.0.0.0"],
}

const FILE_WRITE_ACTIONS = new Set([
	"write_to_file",
	"apply_diff",
	"insert_content",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"generate_image",
	"write",
	"write_file",
	"file_write",
	"apply",
])
const FILE_DELETE_ACTIONS = new Set(["delete_file", "file_delete", "delete"])
const BASH_ACTIONS = new Set(["execute_command", "bash", "shell", "execute", "run_command"])
const NETWORK_ACTIONS = new Set(["fetch", "http", "request", "browser_action"])
const READ_ONLY_ACTIONS = new Set([
	"read_file",
	"list_files",
	"search_files",
	"list_code_definition_names",
	"codebase_search",
	"ask_followup_question",
	"attempt_completion",
	"new_task",
	"switch_mode",
	"update_todo_list",
	"fetch_instructions",
	"access_mcp_resource",
	"use_mcp_tool",
	"run_slash_command",
	"save_checkpoint",
	"rollback_to_checkpoint",
])

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isAbsoluteAny(p: string): boolean {
	return p.startsWith("/") || /^[A-Za-z]:\//.test(p) || p.startsWith("//") || p.startsWith("~")
}

type PathVerdict = { ok: true; rel: string } | { ok: false; reason: string; rule: string; rel?: string }

/**
 * Normalise `raw` to a worktree-relative posix path, or reject it.
 */
export function normalizeTargetPath(raw: string, worktreeRoot?: string): PathVerdict {
	let p = String(raw ?? "")
		.trim()
		.replace(/\\/g, "/")
	if (!p) return { ok: false, reason: "empty path", rule: "empty path" }
	if (p.includes("\0")) return { ok: false, reason: "path contains a NUL byte", rule: "invalid path" }
	if (p.startsWith("~"))
		return { ok: false, reason: `path "${raw}" targets the home directory`, rule: "path outside worktree" }

	if (isAbsoluteAny(p)) {
		const lower = p.toLowerCase()
		if (worktreeRoot) {
			const root = path.resolve(worktreeRoot).replace(/\\/g, "/").replace(/\/+$/, "")
			const resolved = path.resolve(p).replace(/\\/g, "/")
			const cmpRoot = process.platform === "win32" ? root.toLowerCase() : root
			const cmpRes = process.platform === "win32" ? resolved.toLowerCase() : resolved
			if (cmpRes === cmpRoot) return { ok: true, rel: "." }
			if (cmpRes.startsWith(cmpRoot + "/")) {
				p = resolved.slice(root.length + 1)
			} else {
				return { ok: false, reason: `path "${raw}" is outside the worktree`, rule: "path outside worktree" }
			}
		} else {
			for (const sys of DEFAULT_CONFIG.systemPaths) {
				if (lower === sys || lower.startsWith(sys + "/")) {
					return { ok: false, reason: `protected path: ${sys}`, rule: `protected path: ${sys}` }
				}
			}
			return { ok: false, reason: `absolute path "${raw}" not allowed`, rule: "path outside worktree" }
		}
	}

	const norm = path.posix.normalize(p)
	if (norm === ".." || norm.startsWith("../")) {
		return { ok: false, reason: `path "${raw}" escapes the worktree`, rule: "path outside worktree", rel: norm }
	}
	return { ok: true, rel: norm === "./" ? "." : norm.replace(/^\.\//, "") }
}

function checkWritablePath(raw: string, ctx: ActionSafetyContext, config: ActionSafetyConfig): PathVerdict {
	const v = normalizeTargetPath(raw, ctx.worktreeRoot)
	if (!v.ok) return v
	const segs = v.rel.split("/")
	for (const seg of segs) {
		const s = seg.toLowerCase()
		if (config.protectedSegments.includes(s)) {
			return {
				ok: false,
				reason: `protected path: ${seg} (${v.rel})`,
				rule: `protected path: ${seg}`,
				rel: v.rel,
			}
		}
	}
	if (isTestFile(v.rel) && !isTestModifyAllowed(v.rel, ctx.testModifyAllowlist ?? [])) {
		return {
			ok: false,
			reason: `test file "${v.rel}" is protected (R31/R32: tests are given)`,
			rule: "test file protected",
			rel: v.rel,
		}
	}
	return v
}

function collectPaths(args: Record<string, unknown>): string[] {
	const out: string[] = []
	for (const key of ["path", "file_path", "filePath", "target", "dest"]) {
		const v = args[key]
		if (typeof v === "string" && v.trim()) out.push(v)
	}
	const paths = args.paths
	if (Array.isArray(paths)) for (const p of paths) if (typeof p === "string" && p.trim()) out.push(p)
	return out
}

// ---------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------

const SHELL_INTERPRETERS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"ash",
	"fish",
	"pwsh",
	"powershell",
	"iex",
	"invoke-expression",
	"python",
	"python3",
	"perl",
	"ruby",
	"node",
	"php",
	"cmd",
])
const DOWNLOADERS = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "fetch"])

const DESTRUCTIVE_CODE_RE =
	/\b(rmtree|rmSync|rmdirSync|unlinkSync|rimraf|remove_tree|os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree|fs\.rm\b|fs\.rmdir|fs\.unlink|Remove-Item|File\.Delete|Directory\.Delete|FileUtils\.rm_rf)\b/
/** Arguments that point at something outside a project directory */
const DANGEROUS_TARGET_RE =
	/^(\/|\/\*|~|~\/.*|\$HOME.*|\$\{HOME\}.*|%USERPROFILE%.*|[A-Za-z]:[\\/]?\*?|\*|\.\*?|\.\.(\/.*)?|\/[^/]*)$/

function isDangerousRmTarget(t: string, ctx: ActionSafetyContext): boolean {
	const s = t.trim()
	if (!s) return false
	if (DANGEROUS_TARGET_RE.test(s)) return true
	if (s.startsWith("~") || s.startsWith("$HOME") || s.startsWith("${HOME}")) return true
	const v = normalizeTargetPath(s, ctx.worktreeRoot)
	if (!v.ok) return true
	if (v.rel === "." || v.rel === "") return true
	return false
}

function hasRecursiveFlag(args: string[]): boolean {
	return args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === "--recursive")
}

function codeLiteralTargets(code: string): string[] {
	const lits: string[] = []
	for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) lits.push(m[2]!)
	return lits
}

function interpreterInlineCode(prog: string, args: string[]): string | null {
	const flags: Record<string, string[]> = {
		python: ["-c"],
		python3: ["-c"],
		node: ["-e", "--eval", "-p", "--print"],
		perl: ["-e", "-E"],
		ruby: ["-e"],
		php: ["-r"],
		pwsh: ["-c", "-command"],
		powershell: ["-c", "-command"],
	}
	const f = flags[prog]
	if (!f) return null
	const i = args.findIndex((a) => f.includes(a.toLowerCase()))
	if (i < 0) return null
	return args.slice(i + 1).join(" ")
}

type CmdVerdict = { dangerous: false } | { dangerous: true; rule: string }

function checkSimpleCommand(cmd: SimpleCommand, ctx: ActionSafetyContext): CmdVerdict {
	const { prog, args, elevated } = effectiveArgv(cmd.argv)
	const lowerArgs = args.map((a) => a.toLowerCase())
	const D = (rule: string): CmdVerdict => ({ dangerous: true, rule: `matches dangerous pattern: ${rule}` })

	// Redirections that write outside the worktree or into test files
	for (const r of cmd.redirects) {
		if (r.op.includes(">")) {
			const v = checkWritablePath(r.target, ctx, DEFAULT_CONFIG)
			if (!v.ok && !/^\/dev\/(null|stdout|stderr)$/.test(r.target) && r.target.toLowerCase() !== "nul") {
				return D(`redirect to ${r.target} (${v.reason})`)
			}
		}
	}

	if (!prog) return { dangerous: false }

	if (elevated && (prog === "su" || prog === "bash" || prog === "sh" || args.includes("-i") || args.includes("-s"))) {
		return D("privilege escalation (sudo shell)")
	}
	if (prog === "su") return D("privilege escalation (su)")

	// rm -r / rm -rf / rm -fr / rm -r -f on dangerous targets
	if (prog === "rm" || prog === "rmdir") {
		const targets = args.filter((a) => !a.startsWith("-"))
		if ((hasRecursiveFlag(args) || prog === "rmdir") && targets.some((t) => isDangerousRmTarget(t, ctx))) {
			return D(`recursive delete of ${targets.join(" ")}`)
		}
		if (elevated) return D("sudo rm")
		// Deleting test files (R31/R32)
		for (const t of targets) {
			const v = checkWritablePath(t, ctx, DEFAULT_CONFIG)
			if (!v.ok && v.rule === "test file protected") return D(`delete of test file ${t}`)
		}
	}
	// Windows recursive deletes
	if (
		(prog === "rd" || prog === "rmdir" || prog === "del" || prog === "erase") &&
		lowerArgs.some((a) => a === "/s")
	) {
		const targets = args.filter((a) => !a.startsWith("/"))
		if (targets.length === 0 || targets.some((t) => isDangerousRmTarget(t, ctx)))
			return D(`${prog} /s on ${targets.join(" ")}`)
	}
	if ((prog === "remove-item" || prog === "ri") && lowerArgs.some((a) => a.startsWith("-r"))) {
		const targets = args.filter((a) => !a.startsWith("-"))
		if (targets.length === 0 || targets.some((t) => isDangerousRmTarget(t, ctx)))
			return D(`Remove-Item -Recurse ${targets.join(" ")}`)
	}
	// find / -delete, find ~ -exec rm
	if (prog === "find" && (lowerArgs.includes("-delete") || lowerArgs.includes("-exec"))) {
		const start = args.find((a) => !a.startsWith("-"))
		if (start && isDangerousRmTarget(start, ctx)) return D(`find ${start} with -delete/-exec`)
	}

	// Disk / filesystem destruction
	if (prog === "dd" && args.some((a) => /^of=\/dev\//.test(a))) return D("dd to a device")
	if (prog.startsWith("mkfs") || prog === "fdisk" || prog === "parted" || prog === "diskpart") return D(prog)
	if (prog === "format" && args.some((a) => /^[a-z]:$/i.test(a))) return D("format drive")
	if ((prog === "chmod" || prog === "chown") && args.some((a) => a === "/" || a === "~") && hasRecursiveFlag(args)) {
		return D(`${prog} -R on ${args.join(" ")}`)
	}
	if (prog === "chmod" && args.includes("777") && args.some((a) => a.startsWith("/")))
		return D("chmod 777 on system path")

	// Interpreter one-liners with destructive code aimed outside the project
	const code = interpreterInlineCode(prog, args)
	if (code !== null && DESTRUCTIVE_CODE_RE.test(code)) {
		const lits = codeLiteralTargets(code)
		const homeish = /expanduser|homedir\(\)|os\.homedir|\$HOME|USERPROFILE|Path\.home\(\)/.test(code)
		if (homeish || lits.some((l) => isDangerousRmTarget(l, ctx))) {
			return D(`${prog} inline code deleting ${lits.join(", ") || "home directory"}`)
		}
	}

	// Remote code execution: downloader piped into an interpreter
	if (SHELL_INTERPRETERS.has(prog) && cmd.pipedFrom) {
		const src = effectiveArgv(cmd.pipedFrom.argv).prog
		if (DOWNLOADERS.has(src)) return D(`${src} piped to ${prog}`)
	}
	// bash <(curl ...), sh -c "$(curl ...)", iex (iwr ...)
	if (SHELL_INTERPRETERS.has(prog)) {
		for (const a of args) {
			if (/[<$]\(\s*(curl|wget|iwr|irm|invoke-webrequest)\b/i.test(a))
				return D(`${prog} executing downloaded code`)
		}
	}
	if (
		(prog === "iex" || prog === "invoke-expression") &&
		args.some((a) => /\b(iwr|irm|invoke-webrequest|downloadstring)\b/i.test(a))
	) {
		return D("Invoke-Expression of downloaded code")
	}

	// Malware / fork bombs
	if (prog === "xmrig" || prog === "cryptominer") return D(prog)

	return { dangerous: false }
}

export function checkBashCommand(command: string, ctx: ActionSafetyContext = {}): CmdVerdict {
	// Fork bomb (not parseable as simple commands)
	if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/.test(command)) {
		return { dangerous: true, rule: "matches dangerous pattern: fork bomb" }
	}
	for (const cmd of splitCommands(command)) {
		const v = checkSimpleCommand(cmd, ctx)
		if (v.dangerous) return v
	}
	return { dangerous: false }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function checkActionSafety(
	action: string,
	args: Record<string, unknown>,
	ctx: ActionSafetyContext = {},
	config: ActionSafetyConfig = DEFAULT_CONFIG,
): ActionSafetyCheck {
	const name = String(action ?? "").toLowerCase()
	const result: ActionSafetyCheck = { action, actionType: "unknown", args, allowed: true }
	const block = (reason: string, rule: string) => {
		result.allowed = false
		result.reason = reason
		result.rule = rule
		return result
	}

	if (FILE_WRITE_ACTIONS.has(name) || FILE_DELETE_ACTIONS.has(name)) {
		result.actionType = FILE_WRITE_ACTIONS.has(name) ? "file_write" : "file_delete"
		const paths = collectPaths(args)
		if (paths.length === 0) return block(`${action}: no target path given`, "missing path")
		result.normalized_paths = []
		for (const p of paths) {
			const v = checkWritablePath(p, ctx, config)
			if (!v.ok) {
				return block(
					`File ${result.actionType === "file_write" ? "write" : "delete"} blocked: ${v.reason}`,
					v.rule,
				)
			}
			result.normalized_paths.push(v.rel)
		}
		return result
	}

	if (BASH_ACTIONS.has(name)) {
		result.actionType = "bash"
		const command = String(args.command ?? args.cmd ?? "")
		if (!command.trim()) return block("Bash command blocked: empty command", "empty command")
		if (typeof args.cwd_rel === "string" && args.cwd_rel) {
			const v = normalizeTargetPath(args.cwd_rel, ctx.worktreeRoot)
			if (!v.ok) return block(`Bash command blocked: working directory ${v.reason}`, v.rule)
		}
		const v = checkBashCommand(command, ctx)
		if (v.dangerous) return block(`Bash command blocked: ${v.rule}`, v.rule)
		return result
	}

	if (NETWORK_ACTIONS.has(name)) {
		result.actionType = "network"
		const url = String(args.url ?? args.host ?? "")
		for (const blocked of config.blockedHosts) {
			if (url.includes(blocked))
				return block(`Network request blocked: host ${blocked} is blocked`, `blocked host: ${blocked}`)
		}
		return result
	}

	if (READ_ONLY_ACTIONS.has(name)) {
		result.actionType = "read_only"
		return result
	}

	result.actionType = "unknown"
	if ((ctx.unknownActionPolicy ?? "deny") === "allow") return result
	return block(`Unknown action "${action}" (fail-closed)`, "unknown action (fail-closed)")
}

/**
 * Structured log event for action-safety decisions.
 */
export interface ActionSafetyEvent {
	type: "action_safety"
	timestamp: number
	txId?: string
	subTxId?: string
	action: string
	actionType: string
	allowed: boolean
	reason?: string
	rule?: string
}

export function createActionSafetyEvent(check: ActionSafetyCheck, txId?: string, subTxId?: string): ActionSafetyEvent {
	return {
		type: "action_safety",
		timestamp: Date.now(),
		txId,
		subTxId,
		action: check.action,
		actionType: check.actionType,
		allowed: check.allowed,
		reason: check.reason,
		rule: check.rule,
	}
}

export { basenameCmd }
