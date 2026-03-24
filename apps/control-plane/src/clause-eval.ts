import type { Clause, ClauseResult } from "@roo-code/types"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

/**
 * Evaluate a Clause against the given working directory.
 * R8: Declarative clause evaluator.
 */
export async function evalClause(clause: Clause, cwd: string): Promise<ClauseResult> {
	switch (clause.type) {
		case "cmd_exits_0": {
			try {
				await execAsync(clause.cmd, { cwd, timeout: 300_000 })
				return { ok: true }
			} catch (err: any) {
				const stderr: string = err?.stderr || err?.message || ""
				return { ok: false, reason: `cmd_exits_0 failed: ${clause.cmd}\n${stderr.slice(-2048)}` }
			}
		}

		case "test_suite": {
			// Treat name as command (future: look up named suite in CP config)
			try {
				await execAsync(clause.name, { cwd, timeout: 300_000 })
				return { ok: true }
			} catch (err: any) {
				const stderr: string = err?.stderr || err?.message || ""
				return { ok: false, reason: `test_suite "${clause.name}" failed:\n${stderr.slice(-2048)}` }
			}
		}

		case "file_exists": {
			const ok = existsSync(join(cwd, clause.path))
			return ok ? { ok: true } : { ok: false, reason: `file_exists: "${clause.path}" not found` }
		}

		case "not": {
			const child = await evalClause(clause.clause, cwd)
			return child.ok ? { ok: false, reason: `not: inner clause passed but was expected to fail` } : { ok: true }
		}

		case "and": {
			for (const sub of clause.clauses) {
				const result = await evalClause(sub, cwd)
				if (!result.ok) {
					return { ok: false, reason: result.reason }
				}
			}
			return { ok: true }
		}

		case "or": {
			const reasons: string[] = []
			for (const sub of clause.clauses) {
				const result = await evalClause(sub, cwd)
				if (result.ok) {
					return { ok: true }
				}
				if (result.reason) reasons.push(result.reason)
			}
			return { ok: false, reason: `or: all branches failed:\n${reasons.join("\n")}` }
		}

		default: {
			const exhaustive: never = clause
			return { ok: false, reason: `Unknown clause type: ${(exhaustive as any).type}` }
		}
	}
}
