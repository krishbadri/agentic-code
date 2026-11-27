// npx vitest run core/planner/__tests__/PlanExecutor.spec.ts

vi.mock("simple-git", () => ({
	default: vi.fn(() => ({ add: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue({}) })),
}))

vi.mock("../../control-plane/tx", () => ({
	subTxBegin: vi.fn(),
	subTxSafetyGate: vi.fn(),
	subTxRollback: vi.fn(),
	mergePipeline: vi.fn(),
	checkpoint: vi.fn(),
	rollback: vi.fn(),
	persistPlan: vi.fn(),
	metricExecution: vi.fn(),
}))

vi.mock("../../control-plane/client", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	getCpPort: vi.fn(() => 4000),
}))

const project = vi.hoisted(() => ({
	value: { type: "node", testCommand: "npx vitest run", compileCommand: "npx tsc --noEmit" } as any,
}))
vi.mock("../../checkpoints/QualityGate", () => ({ detectProjectCommands: vi.fn(() => project.value) }))

import * as cpTx from "../../control-plane/tx"
import { PlanExecutor } from "../PlanExecutor"

const ok = (data: unknown = {}, status = 200) => ({ ok: true, status, data }) as any
const fail = (status: number, data: unknown) => ({ ok: false, status, data }) as any

type Stx = { id: string; title?: string; prompt?: string; dependsOn?: string[]; safetyChecks?: string[] }

function makeParent(opts: { failChildren?: string[]; childDelayMs?: number } = {}) {
	const children = new Map<string, any>()
	const parent: any = {
		txId: "ptx",
		txBaseCommit: "base0",
		cwd: "/ws/.cp/worktrees/tx_ptx",
		providerRef: { deref: () => ({ context: {}, log: vi.fn() }) },
		say: vi.fn().mockResolvedValue(undefined),
		abortTask: vi.fn(),
		removeChildTaskId: vi.fn(),
		spawnChildTasks: vi.fn(async ({ subTransactions, worktrees }: any) =>
			subTransactions.map((stx: Stx) => {
				const wt = worktrees.get(stx.id)
				const child = {
					taskId: `task-${stx.id}`,
					subTransactionId: stx.id,
					cwd: wt.path,
					transactionalTxId: wt.txId,
				}
				children.set(child.taskId, child)
				return child
			}),
		),
		waitForChildren: vi.fn(async (ids: string[]) => {
			if (opts.childDelayMs) await new Promise((r) => setTimeout(r, opts.childDelayMs))
			const m = new Map()
			for (const id of ids) {
				const stxId = id.replace(/^task-/, "")
				m.set(id, opts.failChildren?.includes(stxId) ? { success: false, error: "boom" } : { success: true })
			}
			return m
		}),
	}
	return parent
}

const plan = (subTransactions: Stx[]) => ({ title: "t", summary: "s", subTransactions }) as any

function mergeAll() {
	vi.mocked(cpTx.mergePipeline).mockImplementation(async (_p, _t, body: any) =>
		ok({
			success: true,
			merged_ids: body.sub_tx_ids,
			rolled_back_ids: [],
			failed_ids: [],
			results: body.sub_tx_ids.map((id: string) => ({ subTxId: id, status: "merged", merged: true })),
		}),
	)
}

describe("PlanExecutor", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		project.value = { type: "node", testCommand: "npx vitest run", compileCommand: "npx tsc --noEmit" }
		vi.mocked(cpTx.subTxBegin).mockImplementation(async (_p, _t, sid) =>
			ok({ worktree_path: `/ws/.cp/worktrees/tx_ptx_sub_${sid}`, sub_tx_id: `ptx:${sid}` }),
		)
		vi.mocked(cpTx.subTxSafetyGate).mockResolvedValue(ok({ ok: true, results: [] }))
		vi.mocked(cpTx.subTxRollback).mockResolvedValue(ok())
		vi.mocked(cpTx.checkpoint).mockResolvedValue(ok({ commit_sha: "c1" }, 201))
		vi.mocked(cpTx.rollback).mockResolvedValue(ok())
		vi.mocked(cpTx.persistPlan).mockResolvedValue(ok())
		vi.mocked(cpTx.metricExecution).mockResolvedValue(ok())
		mergeAll()
	})

	it("groupByDependencies orders by dependency level", () => {
		const ex = new PlanExecutor(makeParent())
		const groups = ex.groupByDependencies([
			{ id: "c", dependsOn: ["a", "b"] },
			{ id: "a" },
			{ id: "b", dependsOn: ["a"] },
			{ id: "d" },
		] as any)
		expect(groups.map((g) => g.map((s) => s.id))).toEqual([["a", "d"], ["b"], ["c"]])
	})

	it("runs inside the parent task's transaction and sends dependsOn and metadata", async () => {
		const parent = makeParent()
		const res = await new PlanExecutor(parent).executePlan(
			plan([
				{ id: "a", title: "A", prompt: "do a" },
				{ id: "b", title: "B", prompt: "do b", dependsOn: ["a"], safetyChecks: ["npm test"] },
			]),
		)
		expect(res).toMatchObject({ success: true, parentTxId: "ptx" })
		expect(cpTx.subTxBegin).toHaveBeenCalledWith(
			4000,
			"ptx",
			"b",
			expect.objectContaining({
				base: "ptx",
				title: "B",
				prompt: "do b",
				dependsOn: ["a"],
				safetyChecks: ["npm test"],
			}),
		)
		expect(cpTx.mergePipeline).toHaveBeenCalledWith(4000, "ptx", { sub_tx_ids: ["b"], depends_on: { b: ["a"] } })
		// child gets its composite worktree id
		expect(parent.spawnChildTasks.mock.calls[0][0].worktrees.get("a")).toEqual({
			path: "/ws/.cp/worktrees/tx_ptx_sub_a",
			txId: "ptx_sub_a",
		})
	})

	it("never spawns a sub-transaction whose worktree could not be created", async () => {
		vi.mocked(cpTx.subTxBegin).mockResolvedValue(fail(500, { code: "GIT_ERROR", message: "worktree add failed" }))
		const parent = makeParent()
		const res = await new PlanExecutor(parent).executePlan(plan([{ id: "a" }]))
		expect(parent.spawnChildTasks).not.toHaveBeenCalled()
		expect(res.success).toBe(false)
		expect(res.failures?.[0]).toMatchObject({
			subTxId: "a",
			reason: expect.stringMatching(/WORKTREE_CREATE_FAILED/),
		})
	})

	it("uses the default compile clause when the planner gave no checks", async () => {
		await new PlanExecutor(makeParent()).executePlan(plan([{ id: "a" }]))
		expect(cpTx.subTxSafetyGate).toHaveBeenCalledWith(4000, "ptx", "a", {
			clause: { type: "cmd_exits_0", cmd: "npx tsc --noEmit" },
		})
	})

	it("falls back to the test clause, and warns when nothing is detected", async () => {
		project.value = { type: "python", testCommand: "python -m pytest -q", compileCommand: null }
		await new PlanExecutor(makeParent()).executePlan(plan([{ id: "a" }]))
		expect(cpTx.subTxSafetyGate).toHaveBeenCalledWith(4000, "ptx", "a", {
			clause: { type: "cmd_exits_0", cmd: "python -m pytest -q" },
		})

		vi.mocked(cpTx.subTxSafetyGate).mockClear()
		project.value = { type: "none", testCommand: null, compileCommand: null }
		const parent = makeParent()
		const res = await new PlanExecutor(parent).executePlan(plan([{ id: "a" }]))
		expect(cpTx.subTxSafetyGate).not.toHaveBeenCalled()
		expect(parent.say).toHaveBeenCalledWith("text", expect.stringMatching(/without a safety gate/))
		expect(res.success).toBe(true)
	})

	it("a failed safety gate rolls the sub-transaction back and it is not merged", async () => {
		vi.mocked(cpTx.subTxSafetyGate).mockImplementation(async (_p, _t, sid) =>
			sid === "b" ? ok({ ok: false, results: [], failedAt: "npx tsc --noEmit" }) : ok({ ok: true, results: [] }),
		)
		const res = await new PlanExecutor(makeParent()).executePlan(plan([{ id: "a" }, { id: "b" }]))
		expect(cpTx.subTxRollback).toHaveBeenCalledWith(4000, "ptx", "b", expect.anything())
		expect(cpTx.mergePipeline).toHaveBeenCalledWith(4000, "ptx", { sub_tx_ids: ["a"] })
		expect(res.success).toBe(false)
		expect(res.failures).toEqual(
			expect.arrayContaining([{ subTxId: "b", reason: expect.stringMatching(/SAFETY_GATE_FAILED/) }]),
		)
	})

	it("treats every rolled_back/failed merge-pipeline entry as a failure (no individual /merge fallback)", async () => {
		vi.mocked(cpTx.mergePipeline).mockResolvedValue(
			ok({
				success: false,
				merged_ids: ["a"],
				rolled_back_ids: ["ptx:b"],
				failed_ids: [],
				results: [
					{ subTxId: "a", status: "merged", merged: true },
					{
						subTxId: "b",
						sub_tx_id: "ptx:b",
						status: "rolled_back",
						merged: false,
						rollback: true,
						reason: "STRUCTURAL_CONFLICT",
						conflicts_with: ["a"],
					},
				],
			}),
		)
		const res = await new PlanExecutor(makeParent()).executePlan(plan([{ id: "a" }, { id: "b" }]))
		expect(res.success).toBe(false)
		expect(res.failedSubTransactions).toEqual(["b"])
		expect(res.failures?.[0].reason).toMatch(/ROLLED_BACK: STRUCTURAL_CONFLICT \(conflicts with a\)/)
		expect(cpTx.mergePipeline).toHaveBeenCalledTimes(1)
	})

	it("a merge-pipeline HTTP error fails the whole group", async () => {
		vi.mocked(cpTx.mergePipeline).mockResolvedValue(fail(500, { message: "boom" }))
		const res = await new PlanExecutor(makeParent()).executePlan(plan([{ id: "a" }, { id: "b" }]))
		expect(res.success).toBe(false)
		expect(res.failedSubTransactions?.sort()).toEqual(["a", "b"])
	})

	it("a 403 from the post-merge progress checkpoint fails the group and resets the parent", async () => {
		vi.mocked(cpTx.checkpoint).mockResolvedValue(
			fail(403, { code: "PROGRESS_VIOLATION", message: "tests decreased", rollback_to: "base0" }),
		)
		const res = await new PlanExecutor(makeParent()).executePlan(plan([{ id: "a" }]))
		expect(cpTx.checkpoint).toHaveBeenCalledWith(4000, "ptx", expect.anything())
		expect(res.success).toBe(false)
		expect(res.failures?.[0].reason).toMatch(/PROGRESS_VIOLATION/)
		expect(cpTx.rollback).toHaveBeenCalledWith(4000, "ptx", "base0")
	})

	it("does not run later groups after a failure", async () => {
		const parent = makeParent({ failChildren: ["a"] })
		const res = await new PlanExecutor(parent).executePlan(plan([{ id: "a" }, { id: "b", dependsOn: ["a"] }]))
		expect(parent.spawnChildTasks).toHaveBeenCalledTimes(1)
		expect(cpTx.subTxBegin).not.toHaveBeenCalledWith(4000, "ptx", "b", expect.anything())
		expect(res.failures).toEqual([
			{ subTxId: "a", reason: expect.stringMatching(/RUNTIME_FAILED/) },
			{ subTxId: "b", reason: expect.stringMatching(/SKIPPED/) },
		])
		// failed children are rolled back, then everything is cleaned up
		expect(cpTx.subTxRollback).toHaveBeenCalledWith(4000, "ptx", "a", expect.anything())
	})

	it("records Σ child durations separately from wall clock", async () => {
		const parent = makeParent({ childDelayMs: 30 })
		await new PlanExecutor(parent).executePlan(plan([{ id: "a" }, { id: "b" }, { id: "c" }]))
		const body = vi.mocked(cpTx.metricExecution).mock.calls[0][2]
		expect(body.execution_mode).toBe("parallel")
		expect(body.sub_tx_count).toBe(3)
		// three ~30ms children in parallel: the sum is well above the wall clock
		expect(body.total_duration_ms).toBeGreaterThanOrEqual(3 * 25)
		expect(body.total_duration_ms).toBeGreaterThan(body.wall_clock_ms)
	})

	it("requires the parent task's transaction", async () => {
		const parent = makeParent()
		parent.txId = undefined
		await expect(new PlanExecutor(parent).executePlan(plan([{ id: "a" }]))).rejects.toMatchObject({
			name: "ControlPlaneUnavailableError",
		})
	})
})
