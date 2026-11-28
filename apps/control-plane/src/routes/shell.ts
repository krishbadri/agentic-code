import type { FastifyInstance } from "fastify"
import { z } from "zod"
import * as path from "node:path"
import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { Git } from "../git.js"
import { CPError } from "../errors.js"
import { isTestFile, isTestModifyAllowed } from "../test-files.js"
import { checkActionSafety, normalizeTargetPath } from "../action-safety.js"
import { splitCommands, effectiveArgv } from "../shell-lex.js"
import { runArgv, runShell } from "../exec.js"

// Parse git status --porcelain output to extract changed file paths
export function parseGitStatusOutput(output: string): string[] {
	const changedFiles: string[] = []
	const statusLines = output.trim().split("\n").filter(Boolean)
	for (const line of statusLines) {
		// Git status format: XY filename (rename: "XY old -> new")
		const match = line.match(/^.{2}\s+(.+)$/)
		let file: string | undefined
		if (match && match[1]) {
			file = match[1].trim()
		} else {
			const trimmed = line.trim()
			if (trimmed.length > 2) file = trimmed.substring(2).trim()
		}
		if (!file) continue
		changedFiles.push(file)
	}
	return changedFiles
}

/** Paths affected by a status entry ("old -> new" renames yield both). */
function statusEntryPaths(entry: string): string[] {
	const arrow = entry.indexOf(" -> ")
	const parts = arrow >= 0 ? [entry.slice(0, arrow), entry.slice(arrow + 4)] : [entry]
	return parts.map((p) => p.replace(/^"|"$/g, ""))
}

const HeadersSchema = z.object({
	"x-actor-id": z.string().min(1),
	"x-repo-id": z.string().min(1).optional(),
})

const BodySchema = z
	.object({
		// Preferred: a command line run through `shell`
		command: z.string().min(1).optional(),
		shell: z.enum(["bash", "sh", "zsh", "pwsh", "powershell", "cmd", "default"]).default("default"),
		// Legacy: explicit argv
		cmd: z.string().min(1).optional(),
		args: z.array(z.string()).default([]),
		cwd_rel: z.string().default(""),
		stdin_base64: z.string().nullable().optional(),
		timeout_ms: z.number().int().positive().max(3_600_000).default(600_000),
		env: z.record(z.string()).default({}),
	})
	.refine((b) => !!b.command || !!b.cmd, { message: "command (or legacy cmd) is required" })

/** argv that runs `command` in the requested shell */
function shellArgv(shell: string, command: string): string[] {
	switch (shell) {
		case "bash":
		case "sh":
		case "zsh":
			return [shell, "-lc", command]
		case "pwsh":
		case "powershell":
			return [shell, "-NoProfile", "-NonInteractive", "-Command", command]
		case "cmd":
			return ["cmd.exe", "/d", "/s", "/c", command]
		default:
			return process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command]
	}
}

/** Files a command line would write that are test files (redirects, rm/mv/cp/tee/sed -i targets). */
function testFileWriteTargets(commandLine: string, allowlist: string[]): string[] {
	const hits = new Set<string>()
	const consider = (p: string) => {
		const v = normalizeTargetPath(p)
		const rel = v.ok ? v.rel : p.replace(/\\/g, "/")
		if (isTestFile(rel) && !isTestModifyAllowed(rel, allowlist)) hits.add(rel)
	}
	for (const cmd of splitCommands(commandLine)) {
		for (const r of cmd.redirects) if (r.op.includes(">")) consider(r.target)
		const { prog, args } = effectiveArgv(cmd.argv)
		const operands = args.filter((a) => !a.startsWith("-"))
		if (["rm", "unlink", "truncate", "touch", "tee"].includes(prog)) operands.forEach(consider)
		if (["mv", "cp", "ln", "install"].includes(prog) && operands.length >= 2) {
			consider(operands[operands.length - 1]!)
			if (prog === "mv") operands.slice(0, -1).forEach(consider)
		}
		if (prog === "sed" && args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")) {
			operands.slice(1).forEach(consider)
		}
	}
	return Array.from(hits)
}

export function registerShellRoutes(app: FastifyInstance) {
	app.post("/shell/exec/:tx_id", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = BodySchema.parse((req as any).body || {})

		// :tx_id may be a parent tx or a composite "<parent>_sub_<rel>" id
		const txId = (req.params as any).tx_id
		const git = new Git({ repoRoot: app.repoRoot })
		const worktreePath = git.worktreePath(txId)
		if (!existsSync(worktreePath)) {
			throw new CPError("TX_NOT_FOUND", `Transaction ${txId} not found (no worktree)`, { tx_id: txId })
		}

		const cwdCheck = normalizeTargetPath(body.cwd_rel || ".", worktreePath)
		if (!cwdCheck.ok) {
			throw new CPError("VALIDATION_ERROR", `cwd_rel ${cwdCheck.reason}`, { cwd_rel: body.cwd_rel })
		}
		const cwd = path.join(worktreePath, cwdCheck.rel === "." ? "" : cwdCheck.rel)

		const argv = body.command ? shellArgv(body.shell, body.command) : [body.cmd!, ...body.args]
		// The full command line as a shell would see it (for analysis)
		const commandLine =
			body.command ?? argv.map((a) => (/\s|["'$`|&;<>]/.test(a) ? JSON.stringify(a) : a)).join(" ")

		// SECURITY: R31/R32 — refuse commands that would write test files, before running them
		const testTargets = testFileWriteTargets(commandLine, app.testModifyAllowlist)
		if (testTargets.length > 0) {
			return reply.code(403).send({
				code: "TEST_FILE_PROTECTED",
				message: "R31/R32 violation: command writes test files and is blocked before execution.",
				modified_test_files: testTargets,
				command: commandLine,
			})
		}

		// SECURITY: R9/R37 — action-safety on every simple command (nested shells included)
		const safety = checkActionSafety(
			"execute_command",
			{ command: commandLine },
			{ worktreeRoot: worktreePath, unknownActionPolicy: app.cpConfig.unknownActionPolicy },
		)
		if (!safety.allowed) {
			return reply.code(403).send({
				code: "ACTION_BLOCKED",
				message: safety.reason,
				rule: safety.rule,
				command: commandLine,
			})
		}

		// Post-exec gate: revert any test file the command changed anyway
		const checkAndRevertTestFiles = async (): Promise<string[] | null> => {
			try {
				const statusOutput = await git.runRaw(
					["status", "--porcelain=v1", "--untracked-files=all"],
					worktreePath,
				)
				const modified = parseGitStatusOutput(statusOutput)
					.flatMap(statusEntryPaths)
					.filter((f) => isTestFile(f) && !isTestModifyAllowed(f, app.testModifyAllowlist))
				for (const testFile of modified) {
					try {
						await git.run(["restore", "--staged", "--worktree", "--", testFile], worktreePath)
					} catch {
						// untracked (new) file: delete it
						await unlink(path.join(worktreePath, testFile)).catch(() => {})
					}
				}
				return modified.length > 0 ? modified : null
			} catch {
				return null
			}
		}

		const runOpts = { timeoutMs: body.timeout_ms, env: body.env, app, txId }
		// The platform shell (and cmd.exe) must receive the command line verbatim;
		// passing it as an argv element would re-quote it on Windows.
		const usePlatformShell =
			!!body.command && (body.shell === "default" || (body.shell === "cmd" && process.platform === "win32"))
		const res = usePlatformShell ? await runShell(cwd, body.command!, runOpts) : await runArgv(cwd, argv, runOpts)

		const modifiedTestFiles = await checkAndRevertTestFiles()
		if (modifiedTestFiles) {
			return reply.code(403).send({
				code: "TEST_FILE_PROTECTED",
				message: `R31/R32 violation: Shell command modified test files. Tests are "given" and cannot be modified. Files have been reverted.`,
				modified_test_files: modifiedTestFiles,
				command: commandLine,
			})
		}

		if (res.spawnError) {
			return reply.code(400).send({
				code: "VALIDATION_ERROR",
				message: `Command could not be started: ${res.spawnError}`,
				exit_code: res.exitCode,
			})
		}

		return reply.send({
			exit_code: res.exitCode,
			timed_out: res.timedOut,
			stdout_base64: Buffer.from(res.stdout).toString("base64"),
			stderr_base64: Buffer.from(res.stderr).toString("base64"),
			truncated: false,
			duration_ms: res.durationMs,
		})
	})
}
