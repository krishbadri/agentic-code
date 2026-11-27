/**
 * Request validation and error-shape tests (CP-0/CP-1).
 *
 * Every route must answer malformed input with 4xx + {code, message}, never 500,
 * and must refuse to operate on transactions / sub-transactions that don't exist.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createOccFixture, beginTransaction, type OccFixture } from "./fixtures/occ-helpers.js"
import { assertSubTxId, assertTxId, toGlobalSubTxId, toRelativeSubTxId } from "../ids.js"

async function post(f: OccFixture, path: string, body: unknown, headers = f.headers) {
	const res = await fetch(`${f.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
	const text = await res.text()
	let data: any
	try {
		data = JSON.parse(text)
	} catch {
		data = text
	}
	return { status: res.status, data }
}

describe("ids", () => {
	it("normalises relative and global sub-tx ids", () => {
		expect(toRelativeSubTxId("tx1", "tx1:agent-a")).toBe("agent-a")
		expect(toRelativeSubTxId("tx1", "agent-a")).toBe("agent-a")
		expect(toGlobalSubTxId("tx1", "agent-a")).toBe("tx1:agent-a")
		expect(toGlobalSubTxId("tx1", "tx1:agent-a")).toBe("tx1:agent-a")
	})

	it("rejects unsafe ids", () => {
		expect(() => assertTxId("../x")).toThrow()
		expect(() => assertTxId("")).toThrow()
		expect(() => assertSubTxId("tx1", "a/b")).toThrow()
		expect(() => assertSubTxId("tx1", "a_sub_b")).toThrow()
		expect(() => assertSubTxId("tx1", "..")).toThrow()
		expect(assertSubTxId("tx1", "tx1:agent.1")).toBe("agent.1")
	})
})

describe("request validation (DB-less)", () => {
	let f: OccFixture
	beforeAll(async () => {
		f = await createOccFixture()
	})
	afterAll(async () => {
		await f.cleanup()
	})

	it("POST /tx/begin with an invalid body → 400 VALIDATION_ERROR", async () => {
		const r = await post(f, "/tx/begin", { isolation: "yolo" })
		expect(r.status).toBe(400)
		expect(r.data.code).toBe("VALIDATION_ERROR")
	})

	it("missing X-Actor-Id → 400", async () => {
		const r = await post(f, "/tx/begin", { isolation: "fail-fast" }, { "Content-Type": "application/json" } as any)
		expect(r.status).toBe(400)
		expect(r.data.code).toBe("VALIDATION_ERROR")
	})

	it("malformed JSON body → 400", async () => {
		const res = await fetch(`${f.baseUrl}/tx/begin`, { method: "POST", headers: f.headers, body: "{not json" })
		expect(res.status).toBe(400)
	})

	it("unknown transaction → 404 TX_NOT_FOUND", async () => {
		const r = await post(f, "/tx/00000000-0000-0000-0000-000000000000/checkpoint", { reason: "manual" })
		expect(r.status).toBe(404)
		expect(r.data.code).toBe("TX_NOT_FOUND")
	})

	it("unsafe transaction id → 400", async () => {
		const r = await post(f, "/tx/bad..id/checkpoint", { reason: "manual" })
		expect(r.status).toBe(400)
	})

	it("unknown sub-transaction → 404 SUB_TX_NOT_FOUND", async () => {
		const tx = await beginTransaction(f)
		const r = await post(f, `/tx/${tx.tx_id}/sub-tx/ghost/safety-gate`, { checks: ["node -e 0"] })
		expect(r.status).toBe(404)
		expect(r.data.code).toBe("SUB_TX_NOT_FOUND")
	})
})

describe("metrics on SQLite", () => {
	let f: OccFixture
	beforeAll(async () => {
		f = await createOccFixture({ db: true })
	})
	afterAll(async () => {
		await f.cleanup()
	})

	it("GET /metrics/rollback and /metrics/speedup → 200 with numeric fields", async () => {
		const rb = await fetch(`${f.baseUrl}/metrics/rollback`)
		expect(rb.status).toBe(200)
		const rbData = await rb.json()
		expect(typeof rbData.total_rollbacks).toBe("number")

		const sp = await fetch(`${f.baseUrl}/metrics/speedup`)
		expect(sp.status).toBe(200)
		const spData = await sp.json()
		expect(typeof spData.parallel_runs).toBe("number")
	})

	it("speedup is estimated from summed sub-tx durations when no serial baseline exists", async () => {
		const tx = await beginTransaction(f)
		const r = await post(f, `/tx/${tx.tx_id}/metric/execution`, {
			execution_mode: "parallel",
			sub_tx_count: 3,
			total_duration_ms: 3000,
			wall_clock_ms: 1000,
		})
		expect(r.status).toBe(201)
		const sp = await (await fetch(`${f.baseUrl}/metrics/speedup`)).json()
		expect(sp.parallel_runs).toBe(1)
		expect(sp.estimated_speedup).toBeCloseTo(3, 5)
		expect(sp.measured_speedup).toBeNull()
		expect(sp.speedup_ratio).toBeCloseTo(3, 5)
	})
})
