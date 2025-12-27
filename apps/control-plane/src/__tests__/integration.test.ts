import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { startServer } from "../server.js"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Control-Plane Integration Tests", () => {
	let app: any
	let baseUrl: string
	let testRepoRoot: string

	beforeAll(async () => {
		// Create isolated test directory
		testRepoRoot = mkdtempSync(join(tmpdir(), "control-plane-test-"))

		// Initialize Git repository in test directory
		const { execSync } = await import("child_process")
		execSync("git init", { cwd: testRepoRoot })
		execSync("git config user.name 'Test User'", { cwd: testRepoRoot })
		execSync("git config user.email 'test@example.com'", { cwd: testRepoRoot })
		execSync('git commit --allow-empty -m "Initial commit"', { cwd: testRepoRoot })

		// Start Control-Plane in DB-less mode with isolated repo
		app = await startServer({
			repoRoot: testRepoRoot,
			port: 0, // Let it choose a free port
			disableDb: true,
			disableMcp: true,
		})
		baseUrl = `http://127.0.0.1:${app.server.address()?.port}`
	})

	afterAll(async () => {
		if (app) {
			await app.close()
		}
		// Cleanup test directory
		try {
			const { rmSync } = await import("fs")
			rmSync(testRepoRoot, { recursive: true, force: true })
		} catch (e) {
			// Ignore cleanup errors
		}
	})

	it("should start Control-Plane DB-less", async () => {
		const response = await fetch(`${baseUrl}/health`)
		expect(response.status).toBe(200)
	})

	it("should create and checkpoint a transaction", async () => {
		// Begin transaction
		const beginRes = await fetch(`${baseUrl}/tx/begin`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Actor-Id": "test", "X-Repo-Id": "test-repo" },
			body: JSON.stringify({ isolation: "fail-fast", base: "HEAD" }),
		})
		expect(beginRes.status).toBe(200)
		const { tx_id } = await beginRes.json()

		// Write a file first
		const writeRes = await fetch(`${baseUrl}/tx/${tx_id}/write`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Actor-Id": "test", "X-Repo-Id": "test-repo" },
			body: JSON.stringify({
				file_path: "test-file.txt",
				content_base64: Buffer.from("Hello, World!").toString("base64"),
			}),
		})
		expect(writeRes.status).toBe(200)

		// Create a checkpoint
		const checkpointRes = await fetch(`${baseUrl}/tx/${tx_id}/checkpoint`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Actor-Id": "test", "X-Repo-Id": "test-repo" },
			body: JSON.stringify({ reason: "manual" }),
		})
		expect(checkpointRes.status).toBe(201)
		const { commit_sha } = await checkpointRes.json()
		expect(commit_sha).toBeDefined()
	}, 5000)

	it("should handle basic transaction operations", async () => {
		// Begin transaction
		const beginRes = await fetch(`${baseUrl}/tx/begin`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Actor-Id": "test", "X-Repo-Id": "test-repo" },
			body: JSON.stringify({ isolation: "fail-fast", base: "HEAD" }),
		})
		expect(beginRes.status).toBe(200)
		const { tx_id } = await beginRes.json()

		// Write a file
		const writeRes = await fetch(`${baseUrl}/tx/${tx_id}/write`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Actor-Id": "test", "X-Repo-Id": "test-repo" },
			body: JSON.stringify({
				file_path: "test-file.txt",
				content_base64: Buffer.from("Hello, World!").toString("base64"),
			}),
		})
		expect(writeRes.status).toBe(200)

		// Get status
		const statusRes = await fetch(`${baseUrl}/git/status/${tx_id}`, {
			headers: { "X-Actor-Id": "test", "X-Repo-Id": "test-repo" },
		})
		expect(statusRes.status).toBe(200)
	}, 5000)
})
