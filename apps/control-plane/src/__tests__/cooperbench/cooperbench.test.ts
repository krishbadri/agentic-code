/**
 * CooperBench Integration Test
 *
 * Tests the transactional agents system using real-world concurrent coding tasks
 * from the CooperBench dataset (CodeConflict/cooperbench-dataset on HuggingFace).
 *
 * Dataset protocol:
 *   1. Clone repo at base_commit
 *   2. Apply BOTH tasks' test_patch files and commit as baseline
 *   3. Run the CP pipeline with the code patches
 *   4. After merge/commit, run the repo's test command (pytest)
 *   5. Record whether the tests pass or fail
 *
 * Selected pair: stanfordnlp/dspy features 2 (cache namespaces) and 3 (cache TTL)
 *   - Code patches overlap on dspy/clients/cache.py and __init__.py (structural conflict)
 *   - Test patches create separate files (test_cache_namespace.py / test_cache_ttl.py)
 *
 * No LLM is used — ground-truth patches simulate what agents would produce.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync, execSync } from "node:child_process"
import { startServer } from "../../server.js"

import datasetJson from "./dataset.json" with { type: "json" }

interface CooperBenchTask {
	instance_id: string
	repo: string
	base_commit: string
	patch: string
	test_patch: string
	cooperbench_task_id: string
	cooperbench_feature_id: string
}

interface TestFixture {
	repoDir: string
	app: Awaited<ReturnType<typeof startServer>>
	baseUrl: string
	headers: Record<string, string>
}

// Extract the test file paths that each test_patch creates/modifies
function testFilesFromPatch(patch: string): string[] {
	return [
		...new Set(
			patch
				.split("\n")
				.filter((l) => l.startsWith("diff --git") && l.includes(" b/"))
				.map((l) => l.split(" b/")[1]),
		),
	]
}

const CLONE_TIMEOUT = 120_000
const INSTALL_TIMEOUT = 300_000 // pip install can be slow
const TEST_TIMEOUT = 600_000

// ── helpers ────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string, opts?: { timeout?: number }): string {
	return execFileSync("git", args, {
		cwd,
		windowsHide: true,
		timeout: opts?.timeout ?? 30_000,
		maxBuffer: 50 * 1024 * 1024,
	})
		.toString()
		.trim()
}

async function post(fixture: TestFixture, path: string, body: any): Promise<Response> {
	return fetch(`${fixture.baseUrl}${path}`, {
		method: "POST",
		headers: fixture.headers,
		body: JSON.stringify(body),
	})
}

function applyPatch(dir: string, patchContent: string): void {
	const patchFile = join(dir, ".tmp-patch.diff")
	writeFileSync(patchFile, patchContent, "utf8")
	try {
		execFileSync("git", ["apply", "--whitespace=fix", ".tmp-patch.diff"], {
			cwd: dir,
			windowsHide: true,
			timeout: 30_000,
		})
	} finally {
		try {
			rmSync(patchFile)
		} catch {}
	}
}

/**
 * Run pytest on specific test files inside a directory.
 * Returns { exitCode, stdout, stderr }.
 */
function runPytest(
	cwd: string,
	testFiles: string[],
	timeout = 120_000,
): { exitCode: number; stdout: string; stderr: string } {
	try {
		const out = execSync(`python -m pytest -xvs ${testFiles.join(" ")}`, {
			cwd,
			timeout,
			windowsHide: true,
			maxBuffer: 10 * 1024 * 1024,
		})
		return { exitCode: 0, stdout: out.toString(), stderr: "" }
	} catch (e: any) {
		return {
			exitCode: e.status ?? 1,
			stdout: e.stdout?.toString() ?? "",
			stderr: e.stderr?.toString() ?? "",
		}
	}
}

// ── test suite ─────────────────────────────────────────────────────────────

describe("CooperBench: stanfordnlp/dspy (features 2 vs 3)", () => {
	let fixture: TestFixture
	let baselineSha: string // SHA of the test-patched baseline on main
	const taskA: CooperBenchTask = datasetJson.tasks[0] as CooperBenchTask
	const taskB: CooperBenchTask = datasetJson.tasks[1] as CooperBenchTask
	const testFilesA = testFilesFromPatch(taskA.test_patch)
	const testFilesB = testFilesFromPatch(taskB.test_patch)
	const allTestFiles = [...new Set([...testFilesA, ...testFilesB])]

	beforeAll(
		async () => {
			// ── Step 1: Clone repo at base_commit ──────────────────────────────
			const repoDir = mkdtempSync(join(tmpdir(), "cooperbench-"))
			console.log(`[CooperBench] Cloning ${datasetJson.repo} → ${repoDir}`)

			execFileSync("git", ["clone", "--depth=500", `https://github.com/${datasetJson.repo}.git`, "."], {
				cwd: repoDir,
				windowsHide: true,
				timeout: CLONE_TIMEOUT,
				maxBuffer: 50 * 1024 * 1024,
			})

			git(["checkout", datasetJson.base_commit], repoDir)
			git(["config", "user.name", "CooperBench Test"], repoDir)
			git(["config", "user.email", "test@cooperbench.dev"], repoDir)
			git(["checkout", "-B", "main"], repoDir)
			console.log(`[CooperBench] Checked out ${datasetJson.base_commit} on branch main`)

			// ── Step 2: Apply BOTH test patches and commit as baseline ─────────
			console.log(`[CooperBench] Applying test patches...`)
			console.log(`  Task A test files: ${testFilesA.join(", ")}`)
			console.log(`  Task B test files: ${testFilesB.join(", ")}`)

			applyPatch(repoDir, taskA.test_patch)
			git(["add", "-A"], repoDir)
			git(["commit", "-m", `baseline: test_patch ${taskA.instance_id}`], repoDir)

			applyPatch(repoDir, taskB.test_patch)
			git(["add", "-A"], repoDir)
			git(["commit", "-m", `baseline: test_patch ${taskB.instance_id}`], repoDir)
			baselineSha = git(["rev-parse", "HEAD"], repoDir)
			console.log(`[CooperBench] Baseline committed with both test patches (${baselineSha})`)

			// ── Step 2b: Install dspy in editable mode so pytest can import it ──
			console.log(`[CooperBench] Installing dspy[dev] (pip install -e ".[dev]")...`)
			try {
				execSync('pip install -e ".[dev]"', {
					cwd: repoDir,
					timeout: INSTALL_TIMEOUT,
					windowsHide: true,
					maxBuffer: 10 * 1024 * 1024,
					stdio: "pipe",
				})
				console.log(`[CooperBench] dspy installed successfully`)
			} catch (e: any) {
				console.log(`[CooperBench] pip install stderr (last 500 chars): ${e.stderr?.toString().slice(-500)}`)
				throw new Error(`Failed to install dspy: ${e.message}`)
			}

			// ── Step 3: Start the CP server ────────────────────────────────────
			const app = await startServer({
				repoRoot: repoDir,
				port: 0,
				disableDb: true,
				disableMcp: true,
			})

			const address = app.server.address()
			const port = typeof address === "object" && address ? address.port : 0

			fixture = {
				repoDir,
				app,
				baseUrl: `http://127.0.0.1:${port}`,
				headers: {
					"Content-Type": "application/json",
					"X-Actor-Id": "cooperbench-harness",
					"X-Repo-Id": datasetJson.repo,
				},
			}
			console.log(`[CooperBench] CP server on port ${port}`)
		},
		CLONE_TIMEOUT + INSTALL_TIMEOUT + 30_000,
	)

	afterAll(async () => {
		if (fixture?.app) await fixture.app.close()
		if (fixture?.repoDir) {
			await new Promise((r) => setTimeout(r, 200))
			try {
				rmSync(fixture.repoDir, { recursive: true, force: true })
			} catch {}
		}
	})

	// ────────────────────────────────────────────────────────────────────────
	// Test 1: Structural conflict detection on real-world concurrent patches
	// ────────────────────────────────────────────────────────────────────────
	it(
		"detects structural conflict when two patches modify the same files",
		async () => {
			const txRes = await post(fixture, "/tx/begin", { isolation: "hybrid", base: "main" })
			expect(txRes.status).toBe(200)
			const { tx_id: txId } = await txRes.json()
			console.log(`[CooperBench] Structural-check TX: ${txId}`)

			// Begin two sub-transactions
			const subA = await (await post(fixture, `/tx/${txId}/sub-tx/feat-ns/begin`, { base: txId })).json()
			const subB = await (await post(fixture, `/tx/${txId}/sub-tx/feat-ttl/begin`, { base: txId })).json()

			// Apply code patches (authored against base_commit — worktrees
			// branched from main which has test patches on top, but the code
			// patches only touch dspy/clients/ implementation files, not the
			// test files, so they apply cleanly)
			applyPatch(subA.worktree_path, taskA.patch)
			git(["add", "-A"], subA.worktree_path)
			git(["commit", "-m", `code: ${taskA.instance_id}`], subA.worktree_path)

			applyPatch(subB.worktree_path, taskB.patch)
			git(["add", "-A"], subB.worktree_path)
			git(["commit", "-m", `code: ${taskB.instance_id}`], subB.worktree_path)

			// Structural check
			const checkRes = await post(fixture, `/tx/${txId}/structural-check`, {
				sub_tx_ids: [subA.sub_tx_id, subB.sub_tx_id],
			})
			expect(checkRes.status).toBe(200)
			const checkData = await checkRes.json()

			console.log(`[CooperBench] hasConflicts: ${checkData.hasConflicts}`)
			console.log(`[CooperBench] sameFileConflicts: ${JSON.stringify(checkData.sameFileConflicts)}`)

			expect(checkData.hasConflicts).toBe(true)
			expect(checkData.sameFileConflicts.length).toBeGreaterThan(0)

			const conflictingFiles = new Set<string>()
			for (const c of checkData.sameFileConflicts) {
				for (const f of c.conflictingFiles ?? []) conflictingFiles.add(f)
			}
			expect(conflictingFiles.has("dspy/clients/cache.py")).toBe(true)
			console.log(`[CooperBench] Conflict on: ${[...conflictingFiles].join(", ")}`)
		},
		TEST_TIMEOUT,
	)

	// ────────────────────────────────────────────────────────────────────────
	// Test 2: Merge pipeline → winner committed → pytest on merged result
	// ────────────────────────────────────────────────────────────────────────
	it(
		"merge pipeline merges winner, rolls back loser, and runs pytest on result",
		async () => {
			const txRes = await post(fixture, "/tx/begin", { isolation: "hybrid", base: "main" })
			expect(txRes.status).toBe(200)
			const { tx_id: txId } = await txRes.json()
			console.log(`[CooperBench] Merge-pipeline TX: ${txId}`)

			const subA = await (await post(fixture, `/tx/${txId}/sub-tx/ns/begin`, { base: txId })).json()
			const subB = await (await post(fixture, `/tx/${txId}/sub-tx/ttl/begin`, { base: txId })).json()

			applyPatch(subA.worktree_path, taskA.patch)
			git(["add", "-A"], subA.worktree_path)
			git(["commit", "-m", `code: ${taskA.instance_id}`], subA.worktree_path)

			applyPatch(subB.worktree_path, taskB.patch)
			git(["add", "-A"], subB.worktree_path)
			git(["commit", "-m", `code: ${taskB.instance_id}`], subB.worktree_path)

			// Run merge pipeline
			const mergeRes = await post(fixture, `/tx/${txId}/merge-pipeline`, {
				sub_tx_ids: [subA.sub_tx_id, subB.sub_tx_id],
			})
			expect(mergeRes.status).toBe(200)
			const mergeData = await mergeRes.json()

			console.log(`[CooperBench] conflicts_detected: ${mergeData.conflicts_detected}`)
			console.log(`[CooperBench] results: ${JSON.stringify(mergeData.results, null, 2)}`)

			expect(mergeData.conflicts_detected).toBeGreaterThan(0)

			const mergedIds = mergeData.results.filter((r: any) => r.merged).map((r: any) => r.subTxId)
			const rolledBackIds = mergeData.results.filter((r: any) => r.rollback).map((r: any) => r.subTxId)

			console.log(`[CooperBench] Merged: ${mergedIds.join(", ") || "(none)"}`)
			console.log(`[CooperBench] Rolled back: ${rolledBackIds.join(", ") || "(none)"}`)

			// Commit the transaction (the winner's changes are already on the parent worktree)
			const commitRes = await post(fixture, `/tx/${txId}/commit`, { strategy: "fail-fast" })
			expect(commitRes.status).toBe(200)
			const commitData = await commitRes.json()
			expect(commitData.advanced_head).toBe(true)
			console.log(`[CooperBench] Committed to main: ${commitData.merged_sha}`)

			// Determine which feature won — its test should pass, loser's should fail
			const winnerIsA = mergedIds.some((id: string) => id.includes("ns"))
			const winnerTestFiles = winnerIsA ? testFilesA : testFilesB
			const loserTestFiles = winnerIsA ? testFilesB : testFilesA

			console.log(`[CooperBench] Winner: feature ${winnerIsA ? "2 (namespace)" : "3 (TTL)"}, running pytest...`)

			// Run pytest on the winner's test files — should pass
			const winnerResult = runPytest(fixture.repoDir, winnerTestFiles)
			console.log(`[CooperBench] Winner pytest exit=${winnerResult.exitCode}`)
			if (winnerResult.exitCode !== 0) {
				console.log(`[CooperBench] Winner stdout (last 1000):\n${winnerResult.stdout.slice(-1000)}`)
				console.log(`[CooperBench] Winner stderr (last 500):\n${winnerResult.stderr.slice(-500)}`)
			}
			expect(winnerResult.exitCode, "Winner's tests should pass").toBe(0)

			// Run pytest on the loser's test files — should fail (code not present)
			const loserResult = runPytest(fixture.repoDir, loserTestFiles)
			console.log(`[CooperBench] Loser pytest exit=${loserResult.exitCode}`)
			expect(loserResult.exitCode, "Loser's tests should fail (code was rolled back)").not.toBe(0)

			console.log(`[CooperBench] PASS: Winner tests pass, loser tests fail as expected`)
		},
		TEST_TIMEOUT,
	)

	// ────────────────────────────────────────────────────────────────────────
	// Test 3: Solo patch → full pipeline → commit → pytest passes
	// ────────────────────────────────────────────────────────────────────────
	it(
		"single patch merges cleanly, commits, and its tests pass",
		async () => {
			// Test 2 advanced main — reset it to the test-patched baseline
			// so code patches (authored against base_commit) can apply cleanly
			git(["reset", "--hard", baselineSha], fixture.repoDir)

			const txRes = await post(fixture, "/tx/begin", { isolation: "hybrid", base: "main" })
			expect(txRes.status).toBe(200)
			const { tx_id: txId } = await txRes.json()

			const sub = await (await post(fixture, `/tx/${txId}/sub-tx/solo/begin`, { base: txId })).json()

			// Apply only patch A (namespace feature)
			applyPatch(sub.worktree_path, taskA.patch)
			git(["add", "-A"], sub.worktree_path)
			git(["commit", "-m", `code: ${taskA.instance_id}`], sub.worktree_path)

			// Structural check (single sub-tx — no conflict)
			const checkRes = await post(fixture, `/tx/${txId}/structural-check`, {
				sub_tx_ids: [sub.sub_tx_id],
			})
			expect(checkRes.status).toBe(200)
			expect((await checkRes.json()).hasConflicts).toBe(false)

			// Merge pipeline
			const mergeRes = await post(fixture, `/tx/${txId}/merge-pipeline`, {
				sub_tx_ids: [sub.sub_tx_id],
			})
			expect(mergeRes.status).toBe(200)
			const mergeData = await mergeRes.json()
			expect(mergeData.conflicts_detected).toBe(0)
			expect(mergeData.results.filter((r: any) => r.merged).length).toBe(1)

			// Commit
			const commitRes = await post(fixture, `/tx/${txId}/commit`, { strategy: "fail-fast" })
			expect(commitRes.status).toBe(200)
			const commitData = await commitRes.json()
			expect(commitData.advanced_head).toBe(true)
			console.log(`[CooperBench] Solo patch committed: ${commitData.merged_sha}`)

			// Run pytest on patch A's test files — should pass
			console.log(`[CooperBench] Running pytest on: ${testFilesA.join(", ")}`)
			const result = runPytest(fixture.repoDir, testFilesA)
			console.log(`[CooperBench] pytest exit=${result.exitCode}`)
			if (result.exitCode !== 0) {
				console.log(`[CooperBench] stdout (last 2000):\n${result.stdout.slice(-2000)}`)
				console.log(`[CooperBench] stderr (last 500):\n${result.stderr.slice(-500)}`)
			}
			expect(result.exitCode, "Solo patch's tests should pass after commit").toBe(0)
			console.log(`[CooperBench] PASS: Solo patch → pipeline → commit → pytest passes`)
		},
		TEST_TIMEOUT,
	)
})
