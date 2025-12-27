import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Fastify from "fastify"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { startServer } from "../server.js"

async function initRepo(tmp: string) {
	await fs.mkdir(tmp, { recursive: true })
	await (await import("node:child_process")).execFileSync("git", ["init"], { cwd: tmp })
	await fs.writeFile(path.join(tmp, "README.md"), "hello\n")
	await (await import("node:child_process")).execFileSync("git", ["add", "."], { cwd: tmp })
	await (await import("node:child_process")).execFileSync("git", ["commit", "-m", "init"], { cwd: tmp })
	await (await import("node:child_process")).execFileSync("git", ["branch", "-M", "main"], { cwd: tmp })
}

describe("tx routes", () => {
	const tmp = path.join(process.cwd(), ".tmp-tx-test")
	let app: Awaited<ReturnType<typeof startServer>>

	beforeAll(async () => {
		await initRepo(tmp)
		app = await startServer({ repoRoot: tmp, port: 0, disableDb: true })
	})

	afterAll(async () => {
		await app.close()
		await fs.rm(tmp, { recursive: true, force: true })
	})

	it("begin/apply/write/checkpoint/status/rollback", async () => {
		const begin = await app.inject({
			method: "POST",
			url: "/tx/begin",
			payload: { isolation: "fail-fast", base: "main" },
			headers: { "x-actor-id": "test", "x-repo-id": "test-repo" },
		})
		expect(begin.statusCode).toBe(200)
		const { tx_id } = JSON.parse(begin.payload)
		const w1 = await app.inject({
			method: "POST",
			url: `/tx/${tx_id}/write`,
			payload: { file_path: "src/x.ts", content_base64: Buffer.from("export{}\n").toString("base64") },
			headers: { "x-actor-id": "test", "x-repo-id": "test-repo" },
		})
		expect(w1.statusCode).toBe(200)
		const cp = await app.inject({
			method: "POST",
			url: `/tx/${tx_id}/checkpoint`,
			payload: { reason: "human" },
			headers: { "x-actor-id": "test", "x-repo-id": "test-repo" },
		})
		expect(cp.statusCode).toBe(201)
		const { commit_sha } = JSON.parse(cp.payload)
		const st = await app.inject({
			method: "GET",
			url: `/git/status/${tx_id}`,
			headers: { "x-actor-id": "test", "x-repo-id": "test-repo" },
		})
		expect(st.statusCode).toBe(200)
		const rb = await app.inject({
			method: "POST",
			url: `/tx/${tx_id}/rollback`,
			payload: { hash: commit_sha },
			headers: { "x-actor-id": "test", "x-repo-id": "test-repo" },
		})
		expect(rb.statusCode).toBe(200)
	})
})
