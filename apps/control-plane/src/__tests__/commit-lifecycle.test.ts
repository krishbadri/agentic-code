/**
 * Transaction lifecycle: begin → status → commit / abort / rollback (CP-1, CP-7, CP-10).
 *
 * Covers the bugs found in the audit:
 *  - POST /commit with {} (what the extension sends) used to return 500
 *  - commitToMain hard-coded `main`, ran `git checkout` in the user's repo and
 *    left the worktree mid-rebase on conflict
 *  - rollback destroyed untracked work irrecoverably
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
	createOccFixture,
	createAndCommitFile,
	beginSubTransaction,
	writeFileToWorktree,
	type OccFixture,
} from "./fixtures/occ-helpers.js"

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, windowsHide: true }).toString().trim()
}

async function call(f: OccFixture, method: string, path: string, body?: unknown) {
	const res = await fetch(`${f.baseUrl}${path}`, {
		method,
		headers: f.headers,
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	})
	const text = await res.text()
	let data: any
	try {
		data = JSON.parse(text)
	} catch {
		data = text
	}
	return { status: res.status, data }
}

async function begin(f: OccFixture, body: Record<string, unknown> = {}) {
	const r = await call(f, "POST", "/tx/begin", { isolation: "hybrid", base: "HEAD", ...body })
	expect(r.status, JSON.stringify(r.data)).toBe(200)
	return r.data as { tx_id: string; worktree_path: string; target_branch: string; base_commit: string }
}

describe("commit lifecycle (DB-less)", () => {
	let f: OccFixture
	beforeEach(async () => {
		f = await createOccFixture()
		createAndCommitFile(f.tmpDir, "src/app.ts", "export const v = 1\n", "add app")
	})
	afterEach(() => f.cleanup())

	it("T8a: commit with an empty body uses the tx isolation policy and reports liveness", async () => {
		const tx = await begin(f)
		writeFileToWorktree(tx.worktree_path, "src/app.ts", "export const v = 2\n")
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status, JSON.stringify(r.data)).toBe(200)
		expect(r.data.strategy).toBe("hybrid")
		expect(r.data.target_branch).toBe("main")
		expect(r.data.liveness).toEqual({ ran: false, reason: "no test command configured" })
		// Uncommitted worktree changes are included in the commit
		expect(readFileSync(join(f.tmpDir, "src/app.ts"), "utf8").replace(/\r\n/g, "\n")).toBe("export const v = 2\n")
		// Worktree and branch are gone
		expect(existsSync(tx.worktree_path)).toBe(false)
		expect(git(["branch", "--list", `tx/${tx.tx_id}`], f.tmpDir)).toBe("")
	})

	it("T8b: fail-fast commit succeeds DB-less when the target has not moved", async () => {
		const tx = await begin(f, { isolation: "fail-fast" })
		writeFileToWorktree(tx.worktree_path, "src/new.ts", "export {}\n")
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status, JSON.stringify(r.data)).toBe(200)
	})

	it("fail-fast commit is refused when the target advanced", async () => {
		const tx = await begin(f, { isolation: "fail-fast" })
		writeFileToWorktree(tx.worktree_path, "src/new.ts", "export {}\n")
		createAndCommitFile(f.tmpDir, "other.txt", "x\n", "someone else committed")
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status).toBe(409)
		expect(r.data.code).toBe("CONFLICT_BASE_ADVANCED")
		// The transaction stays open
		const st = await call(f, "GET", `/tx/${tx.tx_id}`)
		expect(st.data.status).toBe("active")
	})

	it("T8c: rebase conflict aborts the rebase and leaves the worktree clean", async () => {
		const tx = await begin(f, { isolation: "rebase" })
		writeFileToWorktree(tx.worktree_path, "src/app.ts", "export const v = 'tx'\n")
		const cp = await call(f, "POST", `/tx/${tx.tx_id}/checkpoint`, { reason: "manual" })
		expect(cp.status).toBe(201)
		createAndCommitFile(f.tmpDir, "src/app.ts", "export const v = 'main'\n", "conflicting change on main")

		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status).toBe(409)
		expect(r.data.code).toBe("REBASE_CONFLICT")
		expect(r.data.details.conflicts).toContain("src/app.ts")
		// No rebase in progress and a clean tree
		expect(git(["status", "--porcelain"], tx.worktree_path)).toBe("")
		const gitDir = git(["rev-parse", "--git-dir"], tx.worktree_path)
		const abs = gitDir.match(/^[A-Za-z]:|^\//) ? gitDir : join(tx.worktree_path, gitDir)
		expect(existsSync(join(abs, "rebase-merge"))).toBe(false)
		expect(existsSync(join(abs, "rebase-apply"))).toBe(false)
	})

	it("T8d: works on a repository whose branch is not called main", async () => {
		git(["branch", "-M", "master"], f.tmpDir)
		const tx = await begin(f)
		expect(tx.target_branch).toBe("master")
		writeFileToWorktree(tx.worktree_path, "src/app.ts", "export const v = 3\n")
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status, JSON.stringify(r.data)).toBe(200)
		expect(git(["rev-parse", "master"], f.tmpDir)).toBe(r.data.merged_sha)
		expect(git(["symbolic-ref", "--short", "HEAD"], f.tmpDir)).toBe("master")
	})

	it("refuses to overwrite the user's uncommitted edits to files the tx changes", async () => {
		const tx = await begin(f)
		writeFileToWorktree(tx.worktree_path, "src/app.ts", "export const v = 'tx'\n")
		writeFileSync(join(f.tmpDir, "src/app.ts"), "export const v = 'user wip'\n")
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status).toBe(409)
		expect(r.data.code).toBe("WORKSPACE_DIRTY")
		expect(r.data.details.files).toContain("src/app.ts")
		expect(readFileSync(join(f.tmpDir, "src/app.ts"), "utf8").replace(/\r\n/g, "\n")).toBe(
			"export const v = 'user wip'\n",
		)
	})

	it("commits without touching unrelated uncommitted user edits", async () => {
		createAndCommitFile(f.tmpDir, "notes.md", "a\n", "notes")
		const tx = await begin(f)
		writeFileToWorktree(tx.worktree_path, "src/app.ts", "export const v = 'tx'\n")
		writeFileSync(join(f.tmpDir, "notes.md"), "user wip\n")
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status, JSON.stringify(r.data)).toBe(200)
		expect(readFileSync(join(f.tmpDir, "notes.md"), "utf8").replace(/\r\n/g, "\n")).toBe("user wip\n")
		expect(readFileSync(join(f.tmpDir, "src/app.ts"), "utf8").replace(/\r\n/g, "\n")).toBe(
			"export const v = 'tx'\n",
		)
	})

	it("require_liveness without a configured test command → 412", async () => {
		const tx = await begin(f)
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, { require_liveness: true })
		expect(r.status).toBe(412)
		expect(r.data.code).toBe("LIVENESS_UNCONFIGURED")
	})

	it("liveness fails when the output reports failures even with exit code 0", async () => {
		createAndCommitFile(
			f.tmpDir,
			"run-tests.js",
			'console.log("Tests:       1 failed, 3 passed, 4 total"); process.exit(0)\n',
			"lying test runner",
		)
		const tx = await begin(f, { test_command: "node run-tests.js" })
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status).toBe(403)
		expect(r.data.code).toBe("LIVENESS_FAILED")
	})

	it("a test command that cannot start → 400 and no leaked worktree", async () => {
		const r = await call(f, "POST", "/tx/begin", { test_command: "definitely-not-a-real-cmd-xyz --run" })
		expect(r.status).toBe(400)
		expect(r.data.code).toBe("TEST_COMMAND_INVALID")
		expect(git(["worktree", "list"], f.tmpDir).split("\n").length).toBe(1)
	})

	it("quoted test commands work (argv is not split on spaces inside quotes)", async () => {
		const tx = await begin(f, { test_command: "node -e \"console.log('ok 1 - a'); process.exit(0)\"" })
		const cp = await call(f, "POST", `/tx/${tx.tx_id}/checkpoint`, { reason: "auto" })
		expect(cp.status, JSON.stringify(cp.data)).toBe(201)
		expect(cp.data.progress.passing_count).toBe(1)
	})

	it("GET /tx/:id reports status through the lifecycle; abort is idempotent", async () => {
		const tx = await begin(f)
		let st = await call(f, "GET", `/tx/${tx.tx_id}`)
		expect(st.status).toBe(200)
		expect(st.data.status).toBe("active")
		expect(st.data.target_branch).toBe("main")

		await beginSubTransaction(f, tx.tx_id, "child")
		const ab = await call(f, "POST", `/tx/${tx.tx_id}/abort`, { reason: "test" })
		expect(ab.status).toBe(200)
		expect(ab.data.sub_txs_removed).toEqual(["child"])
		expect(existsSync(tx.worktree_path)).toBe(false)

		const again = await call(f, "POST", `/tx/${tx.tx_id}/abort`, {})
		expect(again.status).toBe(200)

		st = await call(f, "GET", `/tx/${tx.tx_id}`)
		expect(st.data.status).toBe("aborted")

		const unknown = await call(f, "GET", `/tx/00000000-0000-0000-0000-000000000000`)
		expect(unknown.status).toBe(404)
	})

	it("commit of an already committed tx → 409 TX_NOT_ACTIVE is impossible (worktree gone → 404)", async () => {
		const tx = await begin(f)
		expect((await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})).status).toBe(200)
		const again = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(again.status).toBe(404)
	})

	it("rollback keeps the discarded work (incl. untracked files) under a backup ref", async () => {
		const tx = await begin(f)
		const base = tx.base_commit
		writeFileToWorktree(tx.worktree_path, "src/app.ts", "export const v = 'changed'\n")
		writeFileToWorktree(tx.worktree_path, "scratch/untracked.txt", "precious\n")

		const r = await call(f, "POST", `/tx/${tx.tx_id}/rollback`, { hash: base })
		expect(r.status, JSON.stringify(r.data)).toBe(200)
		expect(r.data.backup_ref).toMatch(/^refs\/cp\/backup\//)
		expect(r.data.bytes_rolled_back).toBeGreaterThan(0)
		expect(existsSync(join(tx.worktree_path, "scratch/untracked.txt"))).toBe(false)
		expect(git(["show", `${r.data.backup_ref}:scratch/untracked.txt`], tx.worktree_path)).toBe("precious")
		expect(git(["show", `${r.data.backup_ref}:src/app.ts`], tx.worktree_path)).toBe("export const v = 'changed'")
	})

	it("rollback to a commit outside the transaction → 400", async () => {
		const tx = await begin(f)
		const r1 = await call(f, "POST", `/tx/${tx.tx_id}/rollback`, { hash: "not-a-commit" })
		expect(r1.status).toBe(400)
		createAndCommitFile(f.tmpDir, "later.txt", "x\n", "later on main")
		const later = git(["rev-parse", "HEAD"], f.tmpDir)
		const r2 = await call(f, "POST", `/tx/${tx.tx_id}/rollback`, { hash: later })
		expect(r2.status).toBe(400)
	})

	it(".cp/ is excluded from the user's git status", async () => {
		await begin(f)
		expect(git(["status", "--porcelain"], f.tmpDir)).toBe("")
	})
})

describe("DB mode (SQLite): ids, history and metrics", () => {
	let f: OccFixture
	beforeEach(async () => {
		f = await createOccFixture({ db: true })
	})
	afterEach(() => f.cleanup())

	it("sub-tx rollback is recorded against the global id and counted in metrics", async () => {
		const tx = await begin(f)
		const sub = await beginSubTransaction(f, tx.tx_id, "agent-a")
		writeFileToWorktree(sub.worktree_path, "a.txt", "work\n")

		const rb = await call(f, "POST", `/tx/${tx.tx_id}/sub-tx/agent-a/rollback`, { failureKind: "SAFETY_FAIL" })
		expect(rb.status).toBe(200)
		expect(rb.data.sub_tx_id).toBe(`${tx.tx_id}:agent-a`)
		expect(rb.data.bytes_rolled_back).toBeGreaterThan(0)

		const hist = await call(f, "GET", `/tx/${tx.tx_id}/history`)
		expect(hist.status).toBe(200)
		const row = hist.data.sub_transactions.find((s: any) => s.sub_tx_id === `${tx.tx_id}:agent-a`)
		expect(row?.status).toBe("ABORTED")
		expect(row?.failure_kind).toBe("SAFETY_FAIL")

		const m = await fetch(`${f.baseUrl}/metrics/rollback?tx_id=${tx.tx_id}`)
		const md = await m.json()
		expect(md.total_rollbacks).toBeGreaterThanOrEqual(1)
		expect(md.total_bytes_rolled_back).toBeGreaterThan(0)
	})

	it("tool calls logged with a relative sub-tx id are retrievable", async () => {
		const tx = await begin(f)
		await beginSubTransaction(f, tx.tx_id, "agent-b")
		const tc = await call(f, "POST", `/tx/${tx.tx_id}/tool-call`, {
			sub_tx_id: "agent-b",
			tool_name: "write_to_file",
			args_json: { path: "x.ts" },
		})
		expect(tc.status, JSON.stringify(tc.data)).toBe(201)
		const list = await call(f, "GET", `/tx/${tx.tx_id}/tool-calls?sub_tx_id=agent-b`)
		expect(list.status).toBe(200)
		expect(list.data.tool_calls.length).toBe(1)
	})

	it("transaction metadata survives in the DB (target branch, isolation)", async () => {
		const tx = await begin(f, { isolation: "fail-fast" })
		f.app.txMeta.clear() // simulate a restart's empty cache
		const st = await call(f, "GET", `/tx/${tx.tx_id}`)
		expect(st.data.isolation).toBe("fail-fast")
		expect(st.data.target_branch).toBe("main")
	})

	it("progress gate works on SQLite (regression: GREATEST() is not a SQLite function)", async () => {
		createAndCommitFile(f.tmpDir, "run-tests.js", 'console.log("ok 1 - a"); process.exit(0)\n', "runner")
		const tx = await begin(f, { test_command: "node run-tests.js" })
		const cp1 = await call(f, "POST", `/tx/${tx.tx_id}/checkpoint`, { reason: "auto" })
		expect(cp1.status, JSON.stringify(cp1.data)).toBe(201)
		writeFileToWorktree(tx.worktree_path, "run-tests.js", 'console.log("not ok 1 - a"); process.exit(1)\n')
		const cp2 = await call(f, "POST", `/tx/${tx.tx_id}/checkpoint`, { reason: "auto" })
		expect(cp2.status).toBe(403)
		expect(cp2.data.code).toBe("PROGRESS_VIOLATION")
		const commit = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(commit.status, JSON.stringify(commit.data)).toBe(200)
		expect(commit.data.liveness.passed).toBe(true)
	})
})

describe("liveness against the state of the suite at begin", () => {
	let f: OccFixture
	beforeEach(async () => {
		f = await createOccFixture()
	})
	afterEach(() => f.cleanup())

	it("T8k: a suite that is already red is reported at begin and named in the commit refusal", async () => {
		createAndCommitFile(f.tmpDir, "t.js", 'console.log("not ok 1 - broken"); process.exit(1)', "red suite")
		const tx = (await begin(f, { test_command: "node t.js" })) as any
		expect(tx.progress_baseline.failingAtBase).toBe(true)
		expect(tx.progress_baseline.warning).toMatch(/already failing/)

		writeFileToWorktree(tx.worktree_path, "note.txt", "unrelated change")
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status).toBe(403)
		expect(r.data.code).toBe("LIVENESS_FAILED")
		expect(r.data.baseline_was_failing).toBe(true)
		expect(r.data.message).toMatch(/already failing when this transaction began/)
		// still strict: nothing reached the target branch
		expect(existsSync(join(f.tmpDir, "note.txt"))).toBe(false)
	})

	it("T8l: a runner that finds no tests does not block the commit", async () => {
		createAndCommitFile(
			f.tmpDir,
			"t.js",
			'console.log("collected 0 items"); console.log("==== no tests ran in 0.01s ===="); process.exit(5)',
			"empty suite",
		)
		const tx = (await begin(f, { test_command: "node t.js" })) as any
		expect(tx.progress_baseline.failingAtBase).toBe(false)

		writeFileToWorktree(tx.worktree_path, "note.txt", "a change")
		const r = await call(f, "POST", `/tx/${tx.tx_id}/commit`, {})
		expect(r.status, JSON.stringify(r.data)).toBe(200)
		expect(r.data.liveness).toMatchObject({ ran: true, passed: true })
		expect(readFileSync(join(f.tmpDir, "note.txt"), "utf8")).toBe("a change")
	})
})
