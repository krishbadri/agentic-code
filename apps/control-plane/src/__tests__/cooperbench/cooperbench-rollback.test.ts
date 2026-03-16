/**
 * CooperBench Rollback & Gate-Rejection Tests
 *
 * Reuses the same CooperBench dspy setup (clone, test patches, pip install, CP)
 * but deliberately breaks things to verify the CP's gates catch violations
 * and trigger rollback.
 *
 * Tests:
 *   1. Progress gate rejects when a broken patch causes test regression
 *   2. Progress gate rejects when code patch is omitted but tests exist
 *   3. Safety gate (action-safety) blocks write to protected test file
 *   4. Liveness gate rejects commit when tests fail
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from "node:fs"
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
	baselineSha: string
}

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
const INSTALL_TIMEOUT = 300_000
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

// ── test suite ─────────────────────────────────────────────────────────────

describe("CooperBench Rollback: gate rejection tests", () => {
	let fixture: TestFixture
	const taskA: CooperBenchTask = datasetJson.tasks[0] as CooperBenchTask
	const taskB: CooperBenchTask = datasetJson.tasks[1] as CooperBenchTask
	const testFilesA = testFilesFromPatch(taskA.test_patch)

	// The pytest command to use as test_command for progress/liveness baselines.
	// Runs task A's tests (namespace feature).
	const pytestCmdA = `python -m pytest -xvs ${testFilesA.join(" ")}`

	beforeAll(
		async () => {
			// ── Step 1: Clone repo at base_commit ──────────────────────────────
			const repoDir = mkdtempSync(join(tmpdir(), "cooperbench-rb-"))
			console.log(`[Rollback] Cloning ${datasetJson.repo} → ${repoDir}`)

			execFileSync("git", ["clone", "--depth=500", `https://github.com/${datasetJson.repo}.git`, "."], {
				cwd: repoDir,
				windowsHide: true,
				timeout: CLONE_TIMEOUT,
				maxBuffer: 50 * 1024 * 1024,
			})

			git(["checkout", datasetJson.base_commit], repoDir)
			git(["config", "user.name", "CooperBench Rollback Test"], repoDir)
			git(["config", "user.email", "rollback-test@cooperbench.dev"], repoDir)
			git(["checkout", "-B", "main"], repoDir)
			console.log(`[Rollback] Checked out ${datasetJson.base_commit} on branch main`)

			// ── Step 2: Apply BOTH test patches and commit as baseline ─────────
			console.log(`[Rollback] Applying test patches...`)
			applyPatch(repoDir, taskA.test_patch)
			git(["add", "-A"], repoDir)
			git(["commit", "-m", `baseline: test_patch ${taskA.instance_id}`], repoDir)

			applyPatch(repoDir, taskB.test_patch)
			git(["add", "-A"], repoDir)
			git(["commit", "-m", `baseline: test_patch ${taskB.instance_id}`], repoDir)
			const baselineSha = git(["rev-parse", "HEAD"], repoDir)
			console.log(`[Rollback] Baseline committed (${baselineSha})`)

			// ── Step 2b: Install dspy in editable mode ────────────────────────
			console.log(`[Rollback] Installing dspy[dev]...`)
			try {
				execSync('pip install -e ".[dev]"', {
					cwd: repoDir,
					timeout: INSTALL_TIMEOUT,
					windowsHide: true,
					maxBuffer: 10 * 1024 * 1024,
					stdio: "pipe",
				})
				console.log(`[Rollback] dspy installed successfully`)
			} catch (e: any) {
				console.log(`[Rollback] pip install stderr (last 500 chars): ${e.stderr?.toString().slice(-500)}`)
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
					"X-Actor-Id": "cooperbench-rollback-harness",
					"X-Repo-Id": datasetJson.repo,
				},
				baselineSha,
			}
			console.log(`[Rollback] CP server on port ${port}`)
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
	// Test 1: Progress gate rejects when broken patch causes test regression
	// ────────────────────────────────────────────────────────────────────────
	it(
		"progress gate rejects when a broken patch causes test regression",
		async () => {
			// Reset to baseline
			git(["reset", "--hard", fixture.baselineSha], fixture.repoDir)

			// Begin TX with test_command so the CP records a progress baseline.
			// At baseline, the tests FAIL (no implementation code) — so baseline passing_count=0.
			// We apply the correct patch first (tests pass), checkpoint to establish a passing baseline,
			// then corrupt the code and checkpoint again — should be rejected.
			const txRes = await post(fixture, "/tx/begin", {
				isolation: "hybrid",
				base: "main",
				test_command: pytestCmdA,
			})
			expect(txRes.status).toBe(200)
			const txData = await txRes.json()
			const txId = txData.tx_id
			console.log(`[Rollback] Progress-gate TX: ${txId}`)
			console.log(`[Rollback] Baseline passing: ${txData.progress_baseline?.passingCount ?? "N/A"}`)

			const worktreePath = txData.worktree_path

			// Apply the correct code patch so tests pass
			applyPatch(worktreePath, taskA.patch)
			git(["add", "-A"], worktreePath)
			git(["commit", "-m", "code: correct implementation"], worktreePath)

			// First checkpoint — tests should pass, establishing a passing baseline
			const cp1Res = await post(fixture, `/tx/${txId}/checkpoint`, {
				reason: "manual",
			})
			expect(cp1Res.status).toBe(201)
			const cp1Data = await cp1Res.json()
			console.log(`[Rollback] Checkpoint 1 passed: ${JSON.stringify(cp1Data.progress)}`)
			const passingAfterGoodPatch = cp1Data.progress?.passing_count ?? 0
			expect(passingAfterGoodPatch).toBeGreaterThan(0)

			// Now CORRUPT the code — inject a syntax error into cache.py
			const cacheFile = join(worktreePath, "dspy", "clients", "cache.py")
			appendFileSync(cacheFile, "\nSYNTAX_ERROR_THIS_WILL_BREAK_EVERYTHING!!!\n")
			git(["add", "-A"], worktreePath)
			git(["commit", "-m", "BREAK: inject syntax error"], worktreePath)

			// Second checkpoint — tests should fail, progress gate should reject
			const cp2Res = await post(fixture, `/tx/${txId}/checkpoint`, {
				reason: "manual",
			})

			console.log(`[Rollback] Checkpoint 2 status: ${cp2Res.status}`)
			const cp2Data = await cp2Res.json()
			console.log(`[Rollback] Checkpoint 2 response: ${JSON.stringify(cp2Data)}`)

			expect(cp2Res.status).toBe(403)
			expect(cp2Data.code).toBe("PROGRESS_VIOLATION")
			expect(cp2Data.current_count).toBe(0)
			expect(cp2Data.last_checkpoint_count).toBe(passingAfterGoodPatch)
			console.log(
				`[Rollback] PASS: Progress gate rejected — count dropped from ${cp2Data.last_checkpoint_count} to ${cp2Data.current_count}`,
			)
		},
		TEST_TIMEOUT,
	)

	// ────────────────────────────────────────────────────────────────────────
	// Test 2: Progress gate rejects when code is omitted but tests exist
	// ────────────────────────────────────────────────────────────────────────
	it(
		"progress gate rejects when code patch is omitted but tests exist",
		async () => {
			// Reset to baseline (test files exist, but NO implementation code)
			git(["reset", "--hard", fixture.baselineSha], fixture.repoDir)

			// Begin TX with test_command. At baseline, tests fail (no impl) so baseline=0.
			const txRes = await post(fixture, "/tx/begin", {
				isolation: "hybrid",
				base: "main",
				test_command: pytestCmdA,
			})
			expect(txRes.status).toBe(200)
			const txData = await txRes.json()
			const txId = txData.tx_id
			console.log(`[Rollback] No-code TX: ${txId}`)
			console.log(`[Rollback] Baseline passing: ${txData.progress_baseline?.passingCount ?? "N/A"}`)

			// Don't apply any code patch — just make a trivial commit to have something to checkpoint
			const worktreePath = txData.worktree_path
			writeFileSync(join(worktreePath, "dummy.txt"), "placeholder commit\n")
			git(["add", "-A"], worktreePath)
			git(["commit", "-m", "no-op: placeholder"], worktreePath)

			// Checkpoint — tests should fail because implementation is missing.
			// Since baseline is also 0, this actually won't trigger PROGRESS_VIOLATION
			// (0 >= 0 is valid). But we can verify that the test count is indeed 0.
			const cpRes = await post(fixture, `/tx/${txId}/checkpoint`, {
				reason: "manual",
			})

			console.log(`[Rollback] Checkpoint status: ${cpRes.status}`)
			const cpData = await cpRes.json()
			console.log(`[Rollback] Checkpoint response: ${JSON.stringify(cpData)}`)

			if (cpRes.status === 201) {
				// Baseline was 0, current is still 0 — progress gate allows (0 >= 0).
				// This is correct behavior: monotonic non-decreasing is satisfied.
				// The real protection is that the liveness gate will catch this at final commit.
				console.log(`[Rollback] Progress gate allowed (baseline=0, current=0) — expected behavior`)
				expect(cpData.progress.passing_count).toBe(0)
				expect(cpData.progress.baseline_count).toBe(0)
			} else {
				// If it rejects, that's also fine — the gate is being conservative
				expect(cpRes.status).toBe(403)
				expect(cpData.code).toBe("PROGRESS_VIOLATION")
			}

			// Now verify liveness gate catches this at final commit
			const commitRes = await post(fixture, `/tx/${txId}/commit`, {
				strategy: "fail-fast",
			})

			console.log(`[Rollback] Commit status: ${commitRes.status}`)
			const commitData = await commitRes.json()
			console.log(`[Rollback] Commit response: ${JSON.stringify(commitData)}`)

			// Liveness gate should reject because tests fail
			expect(commitRes.status).toBe(403)
			expect(commitData.code).toBe("LIVENESS_FAILED")
			expect(commitData.testsPass).toBe(false)
			console.log(`[Rollback] PASS: Liveness gate rejected commit — tests fail without implementation`)
		},
		TEST_TIMEOUT,
	)

	// ────────────────────────────────────────────────────────────────────────
	// Test 3: Action-safety blocks write to protected test file
	// ────────────────────────────────────────────────────────────────────────
	it(
		"safety gate blocks write to protected test file",
		async () => {
			// Reset to baseline
			git(["reset", "--hard", fixture.baselineSha], fixture.repoDir)

			// Begin a TX (no test_command needed for this test)
			const txRes = await post(fixture, "/tx/begin", {
				isolation: "hybrid",
				base: "main",
			})
			expect(txRes.status).toBe(200)
			const { tx_id: txId } = await txRes.json()
			console.log(`[Rollback] Action-safety TX: ${txId}`)

			// Try to write to a test file — should be blocked by R31/R32
			const safetyRes = await post(fixture, `/tx/${txId}/action-safety`, {
				action: "write_file",
				args: { file_path: "tests/clients/test_cache_namespace.py" },
			})

			console.log(`[Rollback] Action-safety status: ${safetyRes.status}`)
			const safetyData = await safetyRes.json()
			console.log(`[Rollback] Action-safety response: ${JSON.stringify(safetyData)}`)

			expect(safetyRes.status).toBe(403)
			expect(safetyData.code).toBe("ACTION_BLOCKED")
			expect(safetyData.allowed).toBe(false)
			expect(safetyData.reason).toMatch(/protected|blocked|tests/i)
			console.log(`[Rollback] PASS: Action-safety blocked write to test file — ${safetyData.reason}`)

			// Also test that writing to a non-test implementation file IS allowed
			const allowedRes = await post(fixture, `/tx/${txId}/action-safety`, {
				action: "write_file",
				args: { file_path: "dspy/clients/cache.py" },
			})
			expect(allowedRes.status).toBe(200)
			const allowedData = await allowedRes.json()
			expect(allowedData.allowed).toBe(true)
			console.log(`[Rollback] PASS: Action-safety allowed write to implementation file`)
		},
		TEST_TIMEOUT,
	)

	// ────────────────────────────────────────────────────────────────────────
	// Test 4: Liveness gate rejects commit when tests fail
	// ────────────────────────────────────────────────────────────────────────
	it(
		"liveness gate rejects commit when tests fail",
		async () => {
			// Reset to baseline
			git(["reset", "--hard", fixture.baselineSha], fixture.repoDir)

			// Begin TX with test_command so liveness check has a test to run
			const txRes = await post(fixture, "/tx/begin", {
				isolation: "hybrid",
				base: "main",
				test_command: pytestCmdA,
			})
			expect(txRes.status).toBe(200)
			const txData = await txRes.json()
			const txId = txData.tx_id
			console.log(`[Rollback] Liveness TX: ${txId}`)

			const worktreePath = txData.worktree_path

			// Apply the correct code patch first
			applyPatch(worktreePath, taskA.patch)
			git(["add", "-A"], worktreePath)
			git(["commit", "-m", "code: correct implementation"], worktreePath)

			// Then corrupt it — overwrite cache.py with garbage
			const cacheFile = join(worktreePath, "dspy", "clients", "cache.py")
			appendFileSync(cacheFile, "\n\nclass BROKEN_CLASS(DOES_NOT_EXIST):\n    pass\n")
			git(["add", "-A"], worktreePath)
			git(["commit", "-m", "BREAK: corrupt cache.py"], worktreePath)

			// Try to commit — liveness should fail because tests can't pass with broken code
			const commitRes = await post(fixture, `/tx/${txId}/commit`, {
				strategy: "fail-fast",
			})

			console.log(`[Rollback] Commit status: ${commitRes.status}`)
			const commitData = await commitRes.json()
			console.log(`[Rollback] Commit response code: ${commitData.code}`)
			console.log(`[Rollback] testsPass: ${commitData.testsPass}`)

			expect(commitRes.status).toBe(403)
			expect(commitData.code).toBe("LIVENESS_FAILED")
			expect(commitData.testsPass).toBe(false)
			expect(commitData.passed).toBe(false)
			console.log(
				`[Rollback] PASS: Liveness gate rejected commit — ${commitData.details?.error ?? "tests failed"}`,
			)
		},
		TEST_TIMEOUT,
	)
})
