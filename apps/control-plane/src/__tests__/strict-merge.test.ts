/**
 * Spec-strict structural policy and gate enforcement through the HTTP API
 * (CP-3, CP-5, CP-6).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	createOccFixture,
	createAndCommitFile,
	beginSubTransaction,
	writeFileToWorktree,
	commitInWorktree,
	type OccFixture,
} from "./fixtures/occ-helpers.js"

async function call(f: OccFixture, path: string, body: unknown, method = "POST") {
	const res = await fetch(`${f.baseUrl}${path}`, { method, headers: f.headers, body: JSON.stringify(body) })
	const text = await res.text()
	let data: any
	try {
		data = JSON.parse(text)
	} catch {
		data = text
	}
	return { status: res.status, data }
}

async function begin(f: OccFixture) {
	const r = await call(f, "/tx/begin", { isolation: "hybrid", base: "HEAD" })
	expect(r.status).toBe(200)
	return r.data as { tx_id: string; worktree_path: string }
}

async function sub(
	f: OccFixture,
	tx: string,
	id: string,
	files: Record<string, string>,
	opts: Record<string, unknown> = {},
) {
	const r = await call(f, `/tx/${tx}/sub-tx/${id}/begin`, { base: tx, ...opts })
	expect(r.status, JSON.stringify(r.data)).toBe(200)
	for (const [p, c] of Object.entries(files)) writeFileToWorktree(r.data.worktree_path, p, c)
	if (Object.keys(files).length > 0) commitInWorktree(r.data.worktree_path, `${id} work`)
	return r.data.worktree_path as string
}

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n") + "\n"

describe("strict structural policy (merge-pipeline)", () => {
	let f: OccFixture
	beforeEach(async () => {
		f = await createOccFixture()
		createAndCommitFile(f.tmpDir, "README.md", lines(40, "line"), "readme")
		createAndCommitFile(f.tmpDir, "src/b.ts", "export const b = 1\n", "b")
		createAndCommitFile(f.tmpDir, "src/a.ts", 'import { b } from "./b"\nexport const a = b\n', "a")
	})
	afterEach(() => f.cleanup())

	it("T9a: same-file edits git could merge cleanly → the later one is rolled back", async () => {
		const tx = await begin(f)
		const orig = lines(40, "line").split("\n")
		const first = [...orig]
		first[0] = "FIRST EDIT A"
		first[1] = "FIRST EDIT B"
		const second = [...orig]
		second[30] = "SECOND EDIT"
		await sub(f, tx.tx_id, "big", { "README.md": first.join("\n") })
		await sub(f, tx.tx_id, "small", { "README.md": second.join("\n") })

		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["small", "big"] })
		expect(r.status).toBe(200)
		expect(r.data.merged_ids).toEqual(["big"])
		expect(r.data.rolled_back_ids).toEqual(["small"])
		const rb = r.data.results.find((x: any) => x.subTxId === "small")
		expect(rb.reason).toBe("STRUCTURAL_CONFLICT")
		expect(rb.conflicts_with).toEqual(["big"])
		expect(rb.conflict_type).toBe("same-file")
		const merged = readFileSync(join(tx.worktree_path, "README.md"), "utf8")
		expect(merged).toContain("FIRST EDIT A")
		expect(merged).not.toContain("SECOND EDIT")
		expect(existsSync(join(f.tmpDir, ".cp", "worktrees", `tx_${tx.tx_id}_sub_small`))).toBe(false)
	})

	it("T9b: dependent-file pair (a.ts imports b.ts) → the later one is rolled back", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "edits-b", { "src/b.ts": "export const b = 2\nexport const extra = 3\n" })
		await sub(f, tx.tx_id, "edits-a", { "src/a.ts": 'import { b } from "./b"\nexport const a = b + 1\n' })
		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["edits-a", "edits-b"] })
		expect(r.data.merged_ids).toEqual(["edits-b"])
		const rb = r.data.results.find((x: any) => x.subTxId === "edits-a")
		expect(rb.reason).toBe("STRUCTURAL_CONFLICT")
		expect(rb.conflict_type).toBe("dependent-file")
	})

	it("T9c: conflict chain x–y–z with y largest: y wins, x and z (both conflicting with y) roll back", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "x", { "notes/one.md": lines(30, "x") })
		await sub(f, tx.tx_id, "y", { "notes/one.md": lines(20, "y"), "notes/two.md": lines(20, "y") })
		await sub(f, tx.tx_id, "z", { "notes/two.md": lines(2, "z") })
		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["z", "y", "x"] })
		expect(r.data.order).toEqual(["y", "x", "z"])
		// y is biggest (40 lines) so it goes first among conflicting ones … then x and z both conflict with y
		expect(r.data.merged_ids).toEqual(["y"])
		expect(r.data.rolled_back_ids.sort()).toEqual(["x", "z"])
	})

	it("T9c': with x the largest, x wins, y is rolled back and z merges", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "x", { "notes/one.md": lines(60, "x") })
		await sub(f, tx.tx_id, "y", { "notes/one.md": lines(10, "y"), "notes/two.md": lines(10, "y") })
		await sub(f, tx.tx_id, "z", { "notes/two.md": lines(2, "z") })
		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["z", "y", "x"] })
		expect(r.data.order).toEqual(["x", "y", "z"])
		expect(r.data.merged_ids).toEqual(["x", "z"])
		expect(r.data.rolled_back_ids).toEqual(["y"])
	})

	it("T9d: a dependent of a rolled-back sub-tx is rolled back with DEPENDENCY_FAILED", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "winner", { "README.md": lines(41, "w") })
		await sub(f, tx.tx_id, "loser", { "README.md": lines(2, "l") })
		await sub(f, tx.tx_id, "child", { "other/child.md": "c\n" }, { dependsOn: ["loser"] })
		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["winner", "loser", "child"] })
		expect(r.data.merged_ids).toEqual(["winner"])
		const child = r.data.results.find((x: any) => x.subTxId === "child")
		expect(child.reason).toBe("DEPENDENCY_FAILED")
		expect(child.conflicts_with).toEqual(["loser"])
	})

	it("T9e: a sub-tx conflicting with one merged in an EARLIER pipeline call is rolled back", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "early", { "README.md": lines(41, "e") })
		await sub(f, tx.tx_id, "late", { "README.md": lines(3, "l") })
		const r1 = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["early"] })
		expect(r1.data.merged_ids).toEqual(["early"])
		const r2 = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["late"] })
		expect(r2.data.rolled_back_ids).toEqual(["late"])
		expect(r2.data.results[0].conflicts_with).toEqual(["early"])
	})

	it("T9f: R30 — adding a file another sub-tx reserved rolls the adder back", async () => {
		const tx = await begin(f)
		const res = await call(f, `/tx/${tx.tx_id}/reserve-file`, { file_path: "src/new.ts", claimer_id: "owner" })
		expect(res.status).toBe(200)
		await sub(f, tx.tx_id, "owner", { "src/new.ts": "export const owner = 1\n" })
		await sub(f, tx.tx_id, "thief", { "src/other/new2.ts": "x\n", "src/new.ts": "export const thief = 1\n" })
		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["thief", "owner"] })
		const thief = r.data.results.find((x: any) => x.subTxId === "thief")
		expect(thief.status).toBe("rolled_back")
		expect(["R30_FILE_RESERVED", "STRUCTURAL_CONFLICT"]).toContain(thief.reason)
		expect(r.data.merged_ids).toContain("owner")
	})

	it("T9g: single /merge of a structurally conflicting sub-tx → 409 STRUCTURAL_CONFLICT and rolled back", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "one", { "README.md": lines(41, "1") })
		const wtTwo = await sub(f, tx.tx_id, "two", { "README.md": lines(2, "2") })
		expect((await call(f, `/tx/${tx.tx_id}/sub-tx/one/merge`, {})).status).toBe(200)
		const r = await call(f, `/tx/${tx.tx_id}/sub-tx/two/merge`, {})
		expect(r.status).toBe(409)
		expect(r.data.code).toBe("STRUCTURAL_CONFLICT")
		expect(r.data.conflicts_with).toEqual(["one"])
		expect(existsSync(wtTwo)).toBe(false)
	})

	it("uncommitted work in a sub-tx worktree is included (committed before analysis)", async () => {
		const tx = await begin(f)
		const wt = await sub(f, tx.tx_id, "dirty", {})
		writeFileToWorktree(wt, "fresh/file.md", "never committed by the agent\n")
		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["dirty"] })
		expect(r.data.merged_ids).toEqual(["dirty"])
		expect(readFileSync(join(tx.worktree_path, "fresh/file.md"), "utf8").replace(/\r\n/g, "\n")).toBe(
			"never committed by the agent\n",
		)
	})

	it("unknown sub-tx ids → 404 and nothing is merged", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "real", { "x.md": "x\n" })
		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["real", "ghost"] })
		expect(r.status).toBe(404)
		expect(r.data.missing).toEqual(["ghost"])
		expect(existsSync(join(f.tmpDir, ".cp", "worktrees", `tx_${tx.tx_id}_sub_real`))).toBe(true)
	})
})

describe("safety gate enforcement", () => {
	let f: OccFixture
	beforeEach(async () => {
		f = await createOccFixture()
	})
	afterEach(() => f.cleanup())

	it("a failed gate blocks the merge-pipeline (SAFETY_GATE_FAILED)", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "gated", { "g.md": "g\n" })
		const gate = await call(f, `/tx/${tx.tx_id}/sub-tx/gated/safety-gate`, {
			checks: ['node -e "process.exit(2)"'],
		})
		expect(gate.data.ok).toBe(false)
		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["gated"] })
		expect(r.data.rolled_back_ids).toEqual(["gated"])
		expect(r.data.results[0].reason).toBe("SAFETY_GATE_FAILED")
	})

	it("declared safety checks without a gate run block the merge", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "declared", { "d.md": "d\n" }, { safetyChecks: ["pnpm test"] })
		const r = await call(f, `/tx/${tx.tx_id}/merge-pipeline`, { sub_tx_ids: ["declared"] })
		expect(r.data.results[0].reason).toBe("SAFETY_GATE_FAILED")
	})

	it("checks AND clause are both evaluated (audit: the clause silently won)", async () => {
		const tx = await begin(f)
		await sub(f, tx.tx_id, "both", {})
		const r = await call(f, `/tx/${tx.tx_id}/sub-tx/both/safety-gate`, {
			checks: ['node -e "process.exit(1)"'],
			clause: { type: "cmd_exits_0", cmd: 'node -e "process.exit(0)"' },
		})
		expect(r.status).toBe(200)
		expect(r.data.ok).toBe(false)
		expect(r.data.failedAt).toBe('node -e "process.exit(1)"')
	})

	it("malformed clauses → 400; dangerous clause commands are blocked and not executed", async () => {
		const tx = await begin(f)
		const wt = await sub(f, tx.tx_id, "c", {})
		for (const clause of [
			{ type: "and" },
			{ type: "and", clauses: [] },
			{ type: "file_exists", path: "../../x" },
			"rm -rf /",
		]) {
			const r = await call(f, `/tx/${tx.tx_id}/sub-tx/c/safety-gate`, { clause })
			expect(r.status, JSON.stringify(clause)).toBe(400)
		}
		const marker = join(wt, "..", "..", "..", "pwned.txt")
		const r = await call(f, `/tx/${tx.tx_id}/sub-tx/c/safety-gate`, {
			clause: { type: "cmd_exits_0", cmd: "rm -rf ~" },
		})
		expect(r.data.ok).toBe(false)
		expect(r.data.error).toMatch(/ACTION_BLOCKED/)
		expect(existsSync(marker)).toBe(false)
	})
})

describe("shell route and test-file protection", () => {
	let f: OccFixture
	beforeEach(async () => {
		f = await createOccFixture()
	})
	afterEach(() => f.cleanup())

	it("bash -lc wrapping no longer bypasses action-safety", async () => {
		const tx = await begin(f)
		const r = await call(f, `/shell/exec/${tx.tx_id}`, { command: "rm -rf ~", shell: "bash" })
		expect(r.status).toBe(403)
		expect(r.data.code).toBe("ACTION_BLOCKED")
		const legacy = await call(f, `/shell/exec/${tx.tx_id}`, { cmd: "bash", args: ["-lc", "rm -rf ~"] })
		expect(legacy.status).toBe(403)
	})

	it("running tests is allowed; writing test files is not", async () => {
		const tx = await begin(f)
		const ok = await call(f, `/shell/exec/${tx.tx_id}`, { command: 'node -e "console.log(42)"' })
		expect(ok.status, JSON.stringify(ok.data)).toBe(200)
		expect(Buffer.from(ok.data.stdout_base64, "base64").toString()).toContain("42")
		const bad = await call(f, `/shell/exec/${tx.tx_id}`, { command: "echo x > src/new.test.ts" })
		expect(bad.status).toBe(403)
		expect(bad.data.code).toBe("TEST_FILE_PROTECTED")
	})

	it("cwd_rel cannot escape the worktree", async () => {
		const tx = await begin(f)
		const r = await call(f, `/shell/exec/${tx.tx_id}`, { command: "echo hi", cwd_rel: "../.." })
		expect(r.status).toBe(400)
	})

	it("R32: /write refuses to CREATE a new test file (audit: creation was allowed)", async () => {
		const tx = await begin(f)
		const r = await call(f, `/tx/${tx.tx_id}/write`, {
			file_path: "src/__tests__/brand-new.test.ts",
			content_base64: Buffer.from("test('x', () => {})").toString("base64"),
		})
		expect(r.status).toBe(403)
		expect(r.data.code).toBe("TEST_FILE_PROTECTED")
	})

	it("/read cannot escape the worktree", async () => {
		const tx = await begin(f)
		const res = await fetch(`${f.baseUrl}/tx/${tx.tx_id}/read?file_path=../../../etc/hostname`, {
			headers: f.headers,
		})
		expect(res.status).toBe(400)
	})

	it("action-safety route uses the worktree for containment", async () => {
		const tx = await begin(f)
		const inside = await call(f, `/tx/${tx.tx_id}/action-safety`, {
			action: "write_to_file",
			args: { path: join(tx.worktree_path, "src", "ok.ts") },
		})
		expect(inside.status).toBe(200)
		expect(inside.data.normalized_paths).toEqual(["src/ok.ts"])
		const outside = await call(f, `/tx/${tx.tx_id}/action-safety`, {
			action: "write_to_file",
			args: { path: join(f.tmpDir, "README.md") },
		})
		expect(outside.status).toBe(403)
	})
})
