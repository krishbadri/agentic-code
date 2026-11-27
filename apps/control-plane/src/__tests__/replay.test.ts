/**
 * CP-8: /replay re-applies file-level effects honestly (it used to reset and
 * echo success:true for every call without executing anything).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createOccFixture, writeFileToWorktree, type OccFixture } from "./fixtures/occ-helpers.js"
import { execFileSync } from "node:child_process"

async function call(f: OccFixture, path: string, body?: unknown, method = "POST") {
	const res = await fetch(`${f.baseUrl}${path}`, {
		method,
		headers: f.headers,
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	})
	return { status: res.status, data: await res.json().catch(() => ({})) }
}
const head = (wt: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt }).toString().trim()

for (const db of [false, true]) {
	describe(`replay (${db ? "SQLite" : "DB-less"})`, () => {
		let f: OccFixture
		let tx: { tx_id: string; worktree_path: string; base_commit: string }
		beforeEach(async () => {
			f = await createOccFixture({ db })
			tx = (await call(f, "/tx/begin", { base: "HEAD" })).data
		})
		afterEach(() => f.cleanup())

		it("write_to_file calls are re-applied and committed", async () => {
			writeFileToWorktree(tx.worktree_path, "junk.txt", "will be discarded\n")
			const r = await call(f, `/tx/${tx.tx_id}/replay`, {
				from_checkpoint: tx.base_commit,
				tool_calls: [
					{ tool_name: "write_to_file", args_json: { path: "src/a.ts", content: "export const a = 1\n" } },
					{ tool_name: "write_to_file", args_json: { path: "src/b.ts", content: "export const b = 2\n" } },
				],
			})
			expect(r.status, JSON.stringify(r.data)).toBe(200)
			expect(r.data.complete).toBe(true)
			expect(r.data.tools_replayed).toBe(2)
			expect(readFileSync(join(tx.worktree_path, "src/b.ts"), "utf8").replace(/\r\n/g, "\n")).toBe(
				"export const b = 2\n",
			)
			expect(existsSync(join(tx.worktree_path, "junk.txt"))).toBe(false)
			expect(r.data.backup_ref).toMatch(/^refs\/cp\/backup\//)
			expect(head(tx.worktree_path)).toBe(r.data.final_commit)
		})

		it("command-only replays are refused (501) without resetting anything", async () => {
			writeFileToWorktree(tx.worktree_path, "keep.txt", "keep\n")
			const before = head(tx.worktree_path)
			const r = await call(f, `/tx/${tx.tx_id}/replay`, {
				from_checkpoint: tx.base_commit,
				tool_calls: [{ tool_name: "execute_command", args_json: { command: "npm test" } }],
			})
			expect(r.status).toBe(501)
			expect(r.data.code).toBe("REPLAY_UNSUPPORTED")
			expect(head(tx.worktree_path)).toBe(before)
			expect(existsSync(join(tx.worktree_path, "keep.txt"))).toBe(true)
		})

		it("mixed replays need allow_partial (422) and then report what was skipped", async () => {
			const calls = [
				{ tool_name: "write_to_file", args_json: { path: "x.txt", content: "x\n" } },
				{ tool_name: "execute_command", args_json: { command: "npm run gen" } },
			]
			const refused = await call(f, `/tx/${tx.tx_id}/replay`, {
				from_checkpoint: tx.base_commit,
				tool_calls: calls,
			})
			expect(refused.status).toBe(422)
			const ok = await call(f, `/tx/${tx.tx_id}/replay`, {
				from_checkpoint: tx.base_commit,
				tool_calls: calls,
				allow_partial: true,
			})
			expect(ok.status).toBe(200)
			expect(ok.data.complete).toBe(false)
			expect(ok.data.results.map((r: any) => r.status)).toEqual(["applied", "unsupported"])
		})

		it("dry_run changes nothing", async () => {
			const before = head(tx.worktree_path)
			const r = await call(f, `/tx/${tx.tx_id}/replay`, {
				from_checkpoint: tx.base_commit,
				dry_run: true,
				tool_calls: [{ tool_name: "write_to_file", args_json: { path: "y.txt", content: "y\n" } }],
			})
			expect(r.data.results[0].status).toBe("would_apply")
			expect(head(tx.worktree_path)).toBe(before)
			expect(existsSync(join(tx.worktree_path, "y.txt"))).toBe(false)
		})

		if (db) {
			it("source=log replays the recorded tool calls", async () => {
				await call(f, `/tx/${tx.tx_id}/tool-call`, {
					tool_name: "write_to_file",
					args_json: { path: "logged.txt", content: "from the log\n" },
					checkpoint_before: tx.base_commit,
				})
				const r = await call(f, `/tx/${tx.tx_id}/replay`, { from_checkpoint: tx.base_commit, source: "log" })
				expect(r.status, JSON.stringify(r.data)).toBe(200)
				expect(r.data.tools_replayed).toBe(1)
				expect(readFileSync(join(tx.worktree_path, "logged.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
					"from the log\n",
				)
			})
		}
	})
}

describe("health", () => {
	let f: OccFixture
	beforeEach(async () => {
		f = await createOccFixture({ config: { testCommand: "node -e 0" } })
	})
	afterEach(() => f.cleanup())
	it("reports api version and capabilities", async () => {
		const h = await (await fetch(`${f.baseUrl}/health`)).json()
		expect(h.api).toBe(2)
		expect(h.capabilities).toContain("strict-structural")
		expect(h.test_command_configured).toBe(true)
		expect(h.db).toBe("none")
	})
})
