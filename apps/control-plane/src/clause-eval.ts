/**
 * R8: declarative clause evaluator.
 *
 * Safety properties (all previously violated):
 *  - a missing worktree is an evaluation ERROR, never a vacuous pass
 *  - `not` inverts a real pass/fail but propagates errors (a command that could
 *    not even start does not make `not(cmd)` succeed)
 *  - commands go through action-safety first (a clause can no longer be used
 *    to run `rm -rf ~` from the control plane)
 *  - file_exists is contained to the worktree
 *  - test_suite resolves names from server config (falls back to the name as a
 *    command for compatibility)
 */
import type { Clause, ClauseLeafResult, ClauseResult } from "@roo-code/types"
import { existsSync } from "node:fs"
import * as path from "node:path"
import type { FastifyInstance } from "fastify"
import { runCommand } from "./exec.js"
import { checkActionSafety } from "./action-safety.js"

export interface ClauseContext {
	app?: FastifyInstance
	txId?: string
	timeoutMs?: number
	testSuites?: Record<string, string>
}

export async function evalClause(clause: Clause, cwd: string, ctx: ClauseContext = {}): Promise<ClauseResult> {
	if (!existsSync(cwd)) {
		return { ok: false, error: `worktree missing: ${cwd}`, reason: "worktree missing", results: [] }
	}
	const results: ClauseLeafResult[] = []
	const r = await evalNode(clause, cwd, ctx, results)
	return { ...r, results }
}

async function runLeafCommand(
	label: string,
	command: string,
	cwd: string,
	ctx: ClauseContext,
	results: ClauseLeafResult[],
): Promise<ClauseResult> {
	const started = Date.now()
	const safety = checkActionSafety(
		"execute_command",
		{ command },
		{ worktreeRoot: cwd, unknownActionPolicy: ctx.app?.cpConfig.unknownActionPolicy ?? "deny" },
	)
	if (!safety.allowed) {
		const reason = `ACTION_BLOCKED: ${safety.reason}`
		results.push({ clause: label, ok: false, durationMs: Date.now() - started, reason })
		return { ok: false, error: reason, reason }
	}
	const res = await runCommand(cwd, command, {
		timeoutMs: ctx.timeoutMs ?? ctx.app?.cpConfig.testTimeoutMs ?? 300_000,
		app: ctx.app,
		txId: ctx.txId,
	})
	if (res.spawnError) {
		const reason = `${label}: command could not be started: ${res.spawnError}`
		results.push({ clause: label, ok: false, exitCode: res.exitCode, durationMs: res.durationMs, reason })
		return { ok: false, error: reason, reason }
	}
	if (res.timedOut) {
		const reason = `${label}: timed out`
		results.push({ clause: label, ok: false, exitCode: res.exitCode, durationMs: res.durationMs, reason })
		return { ok: false, error: reason, reason }
	}
	const ok = res.exitCode === 0
	const reason = ok ? undefined : `${label} failed (exit ${res.exitCode})\n${(res.stderr || res.stdout).slice(-2048)}`
	results.push({
		clause: label,
		ok,
		exitCode: res.exitCode,
		durationMs: res.durationMs,
		...(reason ? { reason } : {}),
	})
	return ok ? { ok: true } : { ok: false, reason }
}

async function evalNode(
	clause: Clause,
	cwd: string,
	ctx: ClauseContext,
	results: ClauseLeafResult[],
): Promise<ClauseResult> {
	switch (clause.type) {
		case "cmd_exits_0":
			return runLeafCommand(`cmd_exits_0: ${clause.cmd}`, clause.cmd, cwd, ctx, results)

		case "test_suite": {
			const suites = ctx.testSuites ?? ctx.app?.cpConfig.testSuites ?? {}
			const command = suites[clause.name] ?? clause.name
			return runLeafCommand(`test_suite "${clause.name}"`, command, cwd, ctx, results)
		}

		case "file_exists": {
			const started = Date.now()
			const root = path.resolve(cwd)
			const target = path.resolve(root, clause.path)
			if (target !== root && !target.startsWith(root + path.sep)) {
				const reason = `file_exists: "${clause.path}" escapes the worktree`
				results.push({ clause: `file_exists: ${clause.path}`, ok: false, durationMs: 0, reason })
				return { ok: false, error: reason, reason }
			}
			const ok = existsSync(target)
			const reason = ok ? undefined : `file_exists: "${clause.path}" not found`
			results.push({
				clause: `file_exists: ${clause.path}`,
				ok,
				durationMs: Date.now() - started,
				...(reason ? { reason } : {}),
			})
			return ok ? { ok: true } : { ok: false, reason }
		}

		case "not": {
			const child = await evalNode(clause.clause, cwd, ctx, results)
			if (child.error)
				return { ok: false, error: child.error, reason: `not: inner clause errored: ${child.error}` }
			return child.ok ? { ok: false, reason: "not: inner clause passed but was expected to fail" } : { ok: true }
		}

		case "and": {
			if (!clause.clauses || clause.clauses.length === 0) return { ok: false, error: "and: empty clause list" }
			for (const sub of clause.clauses) {
				const r = await evalNode(sub, cwd, ctx, results)
				if (!r.ok) return r
			}
			return { ok: true }
		}

		case "or": {
			if (!clause.clauses || clause.clauses.length === 0) return { ok: false, error: "or: empty clause list" }
			const reasons: string[] = []
			for (const sub of clause.clauses) {
				const r = await evalNode(sub, cwd, ctx, results)
				// fail closed: an errored branch (blocked / unstartable command) fails the clause
				if (r.error) return { ok: false, error: r.error, reason: `or: branch errored: ${r.error}` }
				if (r.ok) return { ok: true }
				if (r.reason) reasons.push(r.reason)
			}
			return { ok: false, reason: `or: all branches failed:\n${reasons.join("\n")}` }
		}

		default: {
			const unknown = clause as { type?: unknown }
			return { ok: false, error: `Unknown clause type: ${String(unknown?.type)}` }
		}
	}
}
