/**
 * Command runner shared by the progress gate, liveness gate, clause evaluator
 * and safety gate.
 *
 * - Commands without shell syntax run via execFile-style argv (quotes honoured),
 *   so `node -e "process.exit(1)"` works on every platform.
 * - Commands with pipes/redirects/globs run through the platform shell.
 * - On Windows, `pnpm`/`npm`/... are .cmd shims that only resolve through the
 *   shell, so ENOENT on a bare program name retries via the shell.
 * - Children are registered per transaction so rollback/abort can kill them
 *   (and their whole process tree).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import type { FastifyInstance } from "fastify"
import { needsShell, splitArgv } from "./shell-lex.js"

export interface RunResult {
	exitCode: number
	stdout: string
	stderr: string
	timedOut: boolean
	/** Set when the program could not be started at all (ENOENT, EACCES, ...) */
	spawnError?: string
	durationMs: number
}

export interface RunOptions {
	timeoutMs?: number
	env?: Record<string, string>
	/** Register the child under this transaction id (for kill on rollback/abort) */
	app?: FastifyInstance
	txId?: string
	maxOutputBytes?: number
}

const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024

export async function runCommand(cwd: string, command: string, opts: RunOptions = {}): Promise<RunResult> {
	const trimmed = command.trim()
	if (!trimmed) {
		return { exitCode: 127, stdout: "", stderr: "", timedOut: false, spawnError: "empty command", durationMs: 0 }
	}
	if (needsShell(trimmed)) {
		const r = await runOnce(cwd, { shell: true, command: trimmed }, opts)
		// POSIX shells report an unknown program as exit 127 "command not found"
		if (!r.spawnError && r.exitCode === 127 && /not found|No such file/i.test(r.stderr)) {
			r.spawnError = `ENOENT: ${r.stderr.trim().split("\n").pop()}`
		}
		return r
	}
	const argv = splitArgv(trimmed)
	const first = await runOnce(cwd, { shell: false, argv }, opts)
	if (
		first.spawnError &&
		/ENOENT/.test(first.spawnError) &&
		process.platform === "win32" &&
		!/\.[a-z0-9]+$/i.test(argv[0] ?? "")
	) {
		// .cmd / .bat shim (pnpm, npm, npx, yarn, ...) — only the shell resolves
		// PATHEXT. Only retry if the program actually exists, otherwise cmd.exe
		// would turn "not found" into an ordinary exit code 1.
		const where = spawnSync("where", [argv[0]!], { cwd, windowsHide: true, stdio: "ignore" })
		if (where.status !== 0) return first
		return runOnce(cwd, { shell: true, command: trimmed }, opts)
	}
	return first
}

type Invocation = { shell: true; command: string } | { shell: false; argv: string[] }

function runOnce(cwd: string, inv: Invocation, opts: RunOptions): Promise<RunResult> {
	const started = Date.now()
	const maxOut = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
	return new Promise((resolve) => {
		let child: ChildProcess
		const env = { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1", ...(opts.env ?? {}) }
		try {
			if (inv.shell) {
				child = spawn(inv.command, {
					cwd,
					env,
					shell: true,
					windowsHide: true,
					detached: process.platform !== "win32",
				})
			} else {
				const [prog, ...args] = inv.argv
				child = spawn(prog!, args, {
					cwd,
					env,
					shell: false,
					windowsHide: true,
					detached: process.platform !== "win32",
				})
			}
		} catch (e: any) {
			resolve({
				exitCode: 127,
				stdout: "",
				stderr: String(e?.message ?? e),
				timedOut: false,
				spawnError: `${e?.code ?? "SPAWN_FAILED"}: ${e?.message ?? e}`,
				durationMs: Date.now() - started,
			})
			return
		}

		const untrack = track(opts.app, opts.txId, child)
		let stdout = ""
		let stderr = ""
		let timedOut = false
		let spawnError: string | undefined
		let settled = false

		child.stdout?.on("data", (d: Buffer) => {
			if (stdout.length < maxOut) stdout += d.toString("utf8")
		})
		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < maxOut) stderr += d.toString("utf8")
		})

		const timer =
			opts.timeoutMs && opts.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true
						killTree(child)
					}, opts.timeoutMs)
				: undefined

		const done = (exitCode: number) => {
			if (settled) return
			settled = true
			if (timer) clearTimeout(timer)
			untrack()
			resolve({
				exitCode: timedOut ? 124 : exitCode,
				stdout,
				stderr,
				timedOut,
				spawnError,
				durationMs: Date.now() - started,
			})
		}

		child.on("error", (e: any) => {
			spawnError = `${e?.code ?? "SPAWN_FAILED"}: ${e?.message ?? e}`
			stderr += String(e?.message ?? e)
			done(127)
		})
		child.on("close", (code, signal) => {
			done(typeof code === "number" ? code : signal ? 128 : 1)
		})
	})
}

function track(app: FastifyInstance | undefined, txId: string | undefined, child: ChildProcess): () => void {
	if (!app || !txId || !app.txProcesses) return () => {}
	let set = app.txProcesses.get(txId)
	if (!set) {
		set = new Set()
		app.txProcesses.set(txId, set)
	}
	set.add(child)
	return () => {
		set!.delete(child)
		if (set!.size === 0) app.txProcesses.delete(txId)
	}
}

/** Kill a process and its whole tree. */
export function killTree(child: ChildProcess): boolean {
	if (!child.pid || child.exitCode !== null) return false
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" })
		} else {
			try {
				process.kill(-child.pid, "SIGKILL")
			} catch {
				child.kill("SIGKILL")
			}
		}
		return true
	} catch {
		return false
	}
}

/**
 * Kill every process registered for a transaction (and for any of its
 * sub-transactions, addressed as "<tx>_sub_<rel>"). Returns how many were killed.
 */
export async function killTxProcesses(app: FastifyInstance, txId: string): Promise<number> {
	let killed = 0
	for (const [key, set] of Array.from(app.txProcesses.entries())) {
		if (key === txId || key.startsWith(`${txId}_sub_`) || key.startsWith(`${txId}:`)) {
			for (const child of Array.from(set)) {
				if (killTree(child)) killed++
			}
			app.txProcesses.delete(key)
		}
	}
	return killed
}

/** Register an externally spawned child (e.g. a long-running shell command). */
export function registerTxProcess(app: FastifyInstance, txId: string, child: ChildProcess): () => void {
	return track(app, txId, child)
}
