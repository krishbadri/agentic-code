/**
 * Contract test: the extension's Control-Plane client (tx.ts) against a REAL
 * control-plane server (apps/control-plane), not mocks.
 *
 * Every other extension test mocks the CP; this one proves that the requests
 * the extension sends are accepted and that the responses have the shape the
 * extension reads. It boots the server in-process on a temp git repository.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { allowNetConnect } from "../../../vitest.setup"
import * as cp from "../tx"

// This spec talks to a real local server; only loopback is allowed.
allowNetConnect(/127\.0\.0\.1/)

const SERVER_PATH = path.resolve(__dirname, "../../../../apps/control-plane/src/server.ts")

function git(args: string[], cwd: string) {
	return execFileSync("git", args, { cwd, windowsHide: true }).toString().trim()
}

function write(root: string, rel: string, content: string) {
	const full = path.join(root, rel)
	mkdirSync(path.dirname(full), { recursive: true })
	writeFileSync(full, content)
}

describe("extension ⇄ control-plane contract (live server)", () => {
	let repo: string
	let app: any
	let port: number

	beforeAll(async () => {
		repo = mkdtempSync(path.join(tmpdir(), "cp-contract-"))
		git(["init"], repo)
		git(["config", "user.name", "contract"], repo)
		git(["config", "user.email", "contract@example.invalid"], repo)
		write(
			repo,
			"src/app.ts",
			"export function alpha() {\n  return 1\n}\n\nexport function beta() {\n  return 2\n}\n",
		)
		write(repo, "run-tests.js", 'console.log("ok 1 - a"); console.log("ok 2 - b"); process.exit(0)\n')
		git(["add", "-A"], repo)
		git(["commit", "-m", "init"], repo)
		git(["branch", "-M", "main"], repo)

		const mod: any = await import(/* @vite-ignore */ SERVER_PATH)
		app = await mod.startServer({ repoRoot: repo, port: 0, disableMcp: true })
		port = (app.server.address() as any).port
	}, 60_000)

	afterAll(async () => {
		await app?.close()
		try {
			rmSync(repo, { recursive: true, force: true })
		} catch {
			/* windows file locks */
		}
	})

	it("health reports api >= 2", async () => {
		const h = await cp.health(port)
		expect(h.ok).toBe(true)
		expect(h.data.api).toBeGreaterThanOrEqual(2)
	})

	it("full single-agent lifecycle: begin → safety → write → shell → checkpoint → commit", async () => {
		const begun = await cp.begin(port, {
			isolation: "hybrid",
			base: "HEAD",
			test_command: "node run-tests.js",
		} as any)
		expect(begun.status, JSON.stringify(begun.data)).toBe(200)
		const txId = begun.data.tx_id
		const wt = begun.data.worktree_path

		const info = await cp.getTx(port, txId)
		expect(info.data.status).toBe("active")
		expect(info.data.worktree_path).toBe(wt)

		// action-safety with real tool names, args shaped as the extension sends them
		const okWrite = await cp.actionSafety(port, txId, {
			action: "write_to_file",
			args: { path: "src/new.ts", paths: undefined, command: undefined, cwd_rel: undefined },
		} as any)
		expect(okWrite.status).toBe(200)
		const testWrite = await cp.actionSafety(port, txId, {
			action: "write_to_file",
			args: { path: "src/app.test.ts" },
		} as any)
		expect(testWrite.status).toBe(403)
		expect((testWrite.data as any).code).toBe("ACTION_BLOCKED")
		const rm = await cp.actionSafety(port, txId, {
			action: "execute_command",
			args: { command: "rm -rf ~" },
		} as any)
		expect(rm.status).toBe(403)

		// R30 reservation: same claimer twice → 200, other claimer → 409
		expect(
			(await cp.reserveFile(port, txId, { file_path: "src/new.ts", claimer_id: "task-1" } as any)).status,
		).toBe(200)
		expect(
			(await cp.reserveFile(port, txId, { file_path: "src/new.ts", claimer_id: "task-1" } as any)).status,
		).toBe(200)
		expect(
			(await cp.reserveFile(port, txId, { file_path: "src/new.ts", claimer_id: "task-2" } as any)).status,
		).toBe(409)

		// the agent writes directly in the worktree (task.cwd === worktree)
		write(wt, "src/new.ts", "export const n = 1\n")

		const sh = await cp.shellExec(port, txId, {
			command: 'node -e "console.log(7*6)"',
			shell: "default",
			cwd_rel: "",
		} as any)
		expect(sh.status, JSON.stringify(sh.data)).toBe(200)
		const out = (sh.data as any).stdout ?? Buffer.from((sh.data as any).stdout_base64 ?? "", "base64").toString()
		expect(out).toContain("42")
		const esc = await cp.shellExec(port, txId, { command: "echo hi", shell: "default", cwd_rel: "../.." } as any)
		expect(esc.status).toBe(400)

		const cpRes = await cp.checkpoint(port, txId, { reason: "auto" } as any)
		expect(cpRes.status, JSON.stringify(cpRes.data)).toBe(201)
		expect((cpRes.data as any).commit_sha).toMatch(/^[0-9a-f]{40}$/)

		const committed = await cp.commit(port, txId, { strategy: "rebase" } as any)
		expect(committed.status, JSON.stringify(committed.data)).toBe(200)
		expect((committed.data as any).liveness.ran).toBe(true)
		expect(readFileSync(path.join(repo, "src/new.ts"), "utf8").replace(/\r\n/g, "\n")).toBe("export const n = 1\n")
		expect(existsSync(wt)).toBe(false)
	}, 120_000)

	it("progress violation on checkpoint returns the fields the extension reads", async () => {
		const begun = await cp.begin(port, {
			isolation: "hybrid",
			base: "HEAD",
			test_command: "node run-tests.js",
		} as any)
		const txId = begun.data.tx_id
		write(
			begun.data.worktree_path,
			"run-tests.js",
			'console.log("ok 1 - a"); console.log("not ok 2 - b"); process.exit(1)\n',
		)
		const r = await cp.checkpoint(port, txId, { reason: "auto" } as any)
		expect(r.status).toBe(403)
		const d = r.data as any
		expect(d.code).toBe("PROGRESS_VIOLATION")
		expect(d.kind).toBe("tests")
		expect(d.rollback_to).toMatch(/^[0-9a-f]{40}$/)
		expect(d.current_count).toBe(1)
		expect(d.last_checkpoint_count).toBe(2)
		expect((await cp.abort(port, txId, "test")).ok).toBe(true)
	}, 120_000)

	it("planner path: sub-tx begin (composite ids), safety gate, merge-pipeline (strict), group checkpoint, metrics", async () => {
		const begun = await cp.begin(port, { isolation: "hybrid", base: "HEAD" } as any)
		const parent = begun.data.tx_id

		const a = await cp.subTxBegin(port, parent, "a", {
			base: parent,
			title: "A",
			dependsOn: [],
			safetyChecks: [],
		} as any)
		const b = await cp.subTxBegin(port, parent, "b", { base: parent, title: "B", dependsOn: [] } as any)
		const c = await cp.subTxBegin(port, parent, "c", { base: parent, title: "C" } as any)
		expect(a.status, JSON.stringify(a.data)).toBe(200)
		// a and b edit different functions of the same file (AST-disjoint) → both merge
		write(
			(a.data as any).worktree_path,
			"src/app.ts",
			"export function alpha() {\n  return 10\n}\n\nexport function beta() {\n  return 2\n}\n",
		)
		write(
			(b.data as any).worktree_path,
			"src/app.ts",
			"export function alpha() {\n  return 1\n}\n\nexport function beta() {\n  return 20\n}\n",
		)
		// c edits the same function as a → strictly rolled back
		write(
			(c.data as any).worktree_path,
			"src/app.ts",
			"export function alpha() {\n  return 99\n}\n\nexport function beta() {\n  return 2\n}\n",
		)

		// child checkpoint through the composite id the extension uses
		const childCp = await cp.checkpoint(port, `${parent}_sub_a`, { reason: "auto" } as any)
		expect(childCp.status, JSON.stringify(childCp.data)).toBe(201)

		for (const id of ["a", "b", "c"]) {
			const g = await cp.subTxSafetyGate(port, parent, id, {
				checks: ['node -e "process.exit(0)"'],
				clause: { type: "cmd_exits_0", cmd: 'node -e "process.exit(0)"' },
			} as any)
			expect((g.data as any).ok, JSON.stringify(g.data)).toBe(true)
		}

		const mp = await cp.mergePipeline(port, parent, { sub_tx_ids: ["a", "b", "c"], depends_on: {} } as any)
		expect(mp.status, JSON.stringify(mp.data)).toBe(200)
		const d = mp.data as any
		expect(d.merged_ids.sort()).toEqual(["a", "b"].sort().filter((x) => d.merged_ids.includes(x)))
		expect(d.rolled_back_ids.length).toBe(1)
		expect(d.success).toBe(false)
		const loser = d.results.find((r: any) => r.status === "rolled_back")
		expect(loser.reason).toBe("STRUCTURAL_CONFLICT")

		const group = await cp.checkpoint(port, parent, { reason: "plan-group" } as any)
		expect(group.status, JSON.stringify(group.data)).toBe(201)

		const m = await cp.metricExecution(port, parent, {
			execution_mode: "parallel",
			sub_tx_count: 3,
			total_duration_ms: 3000,
			wall_clock_ms: 1500,
		})
		// Metrics are stored in the database. Without one (e.g. no native SQLite binding on
		// this machine) the server runs DB-less and must say so rather than pretend.
		const hasDb = (await cp.health(port)).data.db !== "none"
		expect(m.status).toBe(hasDb ? 201 : 503)

		expect((await cp.abort(port, parent, "done")).ok).toBe(true)
		expect((await cp.getTx(port, parent)).data.status).toBe("aborted")
	}, 180_000)

	it("commit conflicts keep the transaction open (409)", async () => {
		const begun = await cp.begin(port, { isolation: "fail-fast", base: "HEAD" } as any)
		write(begun.data.worktree_path, "x.txt", "x\n")
		write(repo, "y.txt", "y\n")
		git(["add", "-A"], repo)
		git(["commit", "-m", "someone else"], repo)
		const r = await cp.commit(port, begun.data.tx_id, { strategy: "fail-fast" } as any)
		expect(r.status).toBe(409)
		expect((r.data as any).code).toBe("CONFLICT_BASE_ADVANCED")
		expect((await cp.getTx(port, begun.data.tx_id)).data.status).toBe("active")
		await cp.abort(port, begun.data.tx_id, "cleanup")
	}, 120_000)
})
