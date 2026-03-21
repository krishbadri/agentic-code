/**
 * Transaction Pipeline Integration Tests
 *
 * Tests the full transactional agents pipeline end-to-end through the
 * Control-Plane HTTP API, without any VS Code or LLM dependencies.
 *
 * Run with: cd apps/control-plane && pnpm test
 *
 * Contract covered:
 *   T1  Isolation        — sub-tx worktrees don't share uncommitted changes
 *   T2  Rollback         — sub-tx rollback removes worktree+branch, no residue
 *   T3  Progress gate    — PROGRESS_VIOLATION blocks checkpoint on regression
 *   T4  Liveness gate    — LIVENESS_FAILED blocks final commit when tests fail
 *   T5  Struct conflict  — same-file conflict detected; merge ordered by changes
 *   T6  R30 reservation  — duplicate new-file creation blocked with 409
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "node:path"
import {
	createOccFixture,
	createOccFixtureWithSharedFile,
	createOccFixtureWithProgressTests,
	beginTransaction,
	beginSubTransaction,
	rollbackSubTransaction,
	writeFileToWorktree,
	commitInWorktree,
	directoryExists,
	type OccFixture,
} from "./fixtures/occ-helpers.js"
import {
	assertNoLeftoverWorktrees,
	assertNoTxBranches,
	assertWorktreeExists,
	assertWorktreeGone,
	getHeadSha,
} from "./helpers/invariants.js"

// ---------------------------------------------------------------------------
// Shared fetch helper so every request carries the right headers
// ---------------------------------------------------------------------------

async function post(fixture: OccFixture, path: string, body: unknown): Promise<Response> {
	return fetch(`${fixture.baseUrl}${path}`, {
		method: "POST",
		headers: fixture.headers,
		body: JSON.stringify(body),
	})
}

async function get(fixture: OccFixture, path: string): Promise<Response> {
	return fetch(`${fixture.baseUrl}${path}`, { headers: fixture.headers })
}

// ---------------------------------------------------------------------------
// T1: Isolation — sub-tx worktrees are separate; uncommitted writes don't leak
// ---------------------------------------------------------------------------

describe("T1: worktree isolation", () => {
	let fixture: OccFixture

	beforeEach(async () => {
		fixture = await createOccFixture()
	})
	afterEach(() => fixture.cleanup())

	it("changes committed in sub-tx A are not visible in sub-tx B before merge", async () => {
		const { tx_id: txId } = await beginTransaction(fixture)

		const { worktree_path: wtA, sub_tx_id: subA } = await beginSubTransaction(fixture, txId, "agent-a")
		const { worktree_path: wtB } = await beginSubTransaction(fixture, txId, "agent-b")

		// Agent A writes and commits a file unique to its work
		writeFileToWorktree(wtA, "feature-a.ts", 'export const a = "only in A"')
		commitInWorktree(wtA, "feat: add feature-a")

		// Agent B's worktree should NOT see agent A's committed file
		// (each sub-tx starts from the same parent TX base, not from each other)
		expect(
			directoryExists(join(wtB, "feature-a.ts")),
			"feature-a.ts must not bleed into the other agent's worktree",
		).toBe(false)

		// Cleanup: rollback both sub-txs so afterEach can remove the fixture cleanly
		await rollbackSubTransaction(fixture, txId, "agent-a")
		await rollbackSubTransaction(fixture, txId, "agent-b")
	})
})

// ---------------------------------------------------------------------------
// T2: Rollback correctness — sub-tx rollback removes worktree + branch
// ---------------------------------------------------------------------------

describe("T2: rollback correctness", () => {
	let fixture: OccFixture

	beforeEach(async () => {
		fixture = await createOccFixture()
	})
	afterEach(() => fixture.cleanup())

	it("rolled-back sub-tx leaves no worktree directory and no branch", async () => {
		const { tx_id: txId } = await beginTransaction(fixture)
		const { worktree_path: wt, sub_tx_id: subId } = await beginSubTransaction(fixture, txId, "rollback-me")

		// Agent writes and commits into the sub-tx worktree
		writeFileToWorktree(wt, "ephemeral.ts", "// should disappear after rollback")
		commitInWorktree(wt, "feat: ephemeral work")

		// Confirm worktree exists before rollback
		assertWorktreeExists(wt)

		// Rollback
		const res = await rollbackSubTransaction(fixture, txId, subId)
		expect(res.rolled_back, "rollback should succeed").toBe(true)

		// Worktree directory must be gone after rollback
		assertWorktreeGone(wt)

		// The sub-tx branch (tx-<parentTxId>-sub-<relId>) must be gone.
		// NOTE: the parent TX branch (tx/<parentTxId>) legitimately remains — assertNoTxBranches
		// would flag it as a leftover, so we check only the sub-tx branch pattern.
		const { execFileSync: efs } = await import("node:child_process")
		const subTxBranches = efs("git", ["branch", "--list", "tx-*-sub-*"], {
			cwd: fixture.tmpDir,
			windowsHide: true,
		})
			.toString()
			.trim()
		expect(subTxBranches, "sub-tx branch must be deleted after rollback").toBe("")
	})
})

// ---------------------------------------------------------------------------
// T3: Progress gate — PROGRESS_VIOLATION blocks checkpoint on regression
// ---------------------------------------------------------------------------

describe("T3: progress gate regression", () => {
	let fixture: OccFixture

	beforeEach(async () => {
		fixture = await createOccFixtureWithProgressTests()
	})
	afterEach(() => fixture.cleanup())

	it("progress gate returns 403 PROGRESS_VIOLATION when passing test count decreases", async () => {
		// Begin tx; the test runner "node run-tests.js" currently outputs TAP with 3 ok lines
		// → baseline: passing_count = 3
		const { tx_id: txId, worktree_path: wt } = await beginTransaction(fixture, {
			test_command: "node run-tests.js",
		})

		// Record HEAD before the gate fires (we'll assert it doesn't advance on violation)
		const headBefore = getHeadSha(wt)

		// Overwrite run-tests.js in the worktree to output 0 passing tests (regression)
		// Note: we don't commit — the gate runs the command on the live filesystem
		writeFileToWorktree(wt, "run-tests.js", `// Simulated regression: 0 tests pass\nprocess.exit(0);\n`)

		// Checkpoint should be BLOCKED (0 passing < 3 baseline)
		const res = await post(fixture, `/tx/${txId}/checkpoint`, { reason: "auto" })
		expect(res.status, "progress gate must return 403 on regression").toBe(403)

		const body = await res.json()
		expect(body.code).toBe("PROGRESS_VIOLATION")
		expect(body.current_count).toBe(0)
		expect(body.last_checkpoint_count).toBe(3)

		// HEAD must NOT have advanced (no new checkpoint commit was created).
		// Note: the progress gate rollback legitimately resets HEAD to HEAD~1,
		// so we only assert that no FORWARD commit was made (HEAD is not ahead of headBefore).
		const headAfter = getHeadSha(wt)
		const { execFileSync: efs } = await import("node:child_process")
		const isAncestor = (() => {
			try {
				// git merge-base --is-ancestor <candidate> <commit> — exits 0 if candidate is ancestor
				efs("git", ["merge-base", "--is-ancestor", headAfter, headBefore], {
					cwd: wt,
					windowsHide: true,
				})
				return true
			} catch {
				return false
			}
		})()
		expect(
			headAfter === headBefore || isAncestor,
			`HEAD should not advance: was ${headBefore.slice(0, 7)}, now ${headAfter.slice(0, 7)}`,
		).toBe(true)
	})

	it("progress gate allows checkpoint when test count stays the same", async () => {
		// Same 3-passing baseline
		const { tx_id: txId } = await beginTransaction(fixture, {
			test_command: "node run-tests.js",
		})

		// Write an unrelated file (don't touch run-tests.js)
		const res = await post(fixture, `/tx/${txId}/write`, {
			file_path: "src/newfile.ts",
			content_base64: Buffer.from("export const x = 1").toString("base64"),
		})
		expect(res.status).toBe(200)

		// Checkpoint should pass (still 3 passing)
		const cpRes = await post(fixture, `/tx/${txId}/checkpoint`, { reason: "auto" })
		expect(cpRes.status, "checkpoint must succeed when tests stay green").toBe(201)

		const body = await cpRes.json()
		expect(body.commit_sha).toBeDefined()
		expect(body.progress.passing_count).toBe(3)
	})
})

// ---------------------------------------------------------------------------
// T4: Liveness gate — final commit blocked when tests fail
// ---------------------------------------------------------------------------

describe("T4: liveness gate at final commit", () => {
	let fixture: OccFixture

	beforeEach(async () => {
		fixture = await createOccFixture()
	})
	afterEach(() => fixture.cleanup())

	it("POST /commit returns 403 LIVENESS_FAILED when test command exits non-zero", async () => {
		// A test_command that always fails — liveness will re-run it at commit time.
		// NOTE: execFile does NOT use a shell, so args must NOT be quoted.
		// "node -e process.exit(1)" splits to ["node", "-e", "process.exit(1)"] ✓
		const { tx_id: txId } = await beginTransaction(fixture, {
			test_command: "node -e process.exit(1)",
		})

		// Write something so the worktree has content (not strictly required, but realistic)
		await post(fixture, `/tx/${txId}/write`, {
			file_path: "src/impl.ts",
			content_base64: Buffer.from("export const impl = true").toString("base64"),
		})

		// Attempt final commit — liveness runs the test command, sees exit 1 → BLOCKED
		const commitRes = await post(fixture, `/tx/${txId}/commit`, { strategy: "fail-fast" })
		expect(commitRes.status, "liveness gate must return 403 when tests fail").toBe(403)

		const body = await commitRes.json()
		expect(body.code).toBe("LIVENESS_FAILED")
		expect(body.testsPass).toBe(false)
	})

	it("POST /commit succeeds when test command exits 0", async () => {
		// A test_command that always passes (no shell quoting needed — execFile splits on spaces)
		const { tx_id: txId } = await beginTransaction(fixture, {
			test_command: "node -e process.exit(0)",
		})

		const commitRes = await post(fixture, `/tx/${txId}/commit`, { strategy: "fail-fast" })
		// A worktree with no commits beyond the base merges cleanly (empty merge is ok)
		expect([200, 201], "successful commit should return 2xx").toContain(commitRes.status)
	})
})

// ---------------------------------------------------------------------------
// T5: Structural conflict detection + merge ordering
// ---------------------------------------------------------------------------

describe("T5: structural conflict detection and merge ordering", () => {
	let fixture: OccFixture

	beforeEach(async () => {
		fixture = await createOccFixtureWithSharedFile()
	})
	afterEach(() => fixture.cleanup())

	it("structural-check detects same-file conflict between two sub-txs", async () => {
		const { tx_id: txId } = await beginTransaction(fixture)

		const { worktree_path: wtA, sub_tx_id: subA } = await beginSubTransaction(fixture, txId, "agent-a")
		const { worktree_path: wtB, sub_tx_id: subB } = await beginSubTransaction(fixture, txId, "agent-b")

		// Both agents modify the same shared file
		writeFileToWorktree(wtA, "src/shared.ts", 'export function shared() { return "agent-a version" }')
		commitInWorktree(wtA, "feat: agent-a modifies shared.ts")

		writeFileToWorktree(wtB, "src/shared.ts", 'export function shared() { return "agent-b version" }')
		commitInWorktree(wtB, "feat: agent-b modifies shared.ts")

		// Structural check should see a same-file conflict
		const checkRes = await post(fixture, `/tx/${txId}/structural-check`, {
			sub_tx_ids: [subA, subB],
		})
		expect(checkRes.status).toBe(200)

		const checkBody = await checkRes.json()
		expect(checkBody.hasConflicts, "same-file conflict must be detected").toBe(true)
		expect(checkBody.sameFileConflicts.length).toBeGreaterThan(0)

		const conflict = checkBody.sameFileConflicts[0]
		expect(conflict.conflictingFiles).toContain("src/shared.ts")

		// Cleanup
		await rollbackSubTransaction(fixture, txId, subA)
		await rollbackSubTransaction(fixture, txId, subB)
	})

	it("merge-pipeline rolls back the conflicting sub-tx and applies merge ordering (more-changes first)", async () => {
		const { tx_id: txId } = await beginTransaction(fixture)

		// sub-tx A makes MORE changes (20 lines → linesChanged larger)
		const { worktree_path: wtA, sub_tx_id: subA } = await beginSubTransaction(fixture, txId, "big-agent")
		const bigContent = Array.from({ length: 20 }, (_, i) => `export const line${i} = ${i}`).join("\n")
		writeFileToWorktree(wtA, "src/shared.ts", bigContent)
		commitInWorktree(wtA, "feat: big-agent rewrites shared.ts (20 lines)")

		// sub-tx B makes FEWER changes (5 lines)
		const { worktree_path: wtB, sub_tx_id: subB } = await beginSubTransaction(fixture, txId, "small-agent")
		const smallContent = Array.from({ length: 5 }, (_, i) => `export const sm${i} = ${i}`).join("\n")
		writeFileToWorktree(wtB, "src/shared.ts", smallContent)
		commitInWorktree(wtB, "feat: small-agent edits shared.ts (5 lines)")

		// merge-pipeline should detect the conflict and apply modification ordering
		const pipelineRes = await post(fixture, `/tx/${txId}/merge-pipeline`, {
			sub_tx_ids: [subA, subB],
		})
		expect(pipelineRes.status).toBe(200)

		const pipelineBody = await pipelineRes.json()

		// At least one conflict was detected
		expect(pipelineBody.conflicts_detected, "same-file conflict must have been detected").toBeGreaterThan(0)

		// At least one sub-tx was rolled back (the one that lost the merge race)
		expect(pipelineBody.rolled_back, "one sub-tx must be rolled back on conflict").toBeGreaterThanOrEqual(1)

		// The merge results list should exist and have both sub-txs
		expect(pipelineBody.results).toHaveLength(2)

		// Merge ordering: big-agent (more changes) should appear before small-agent in results
		const idxA = pipelineBody.results.findIndex((r: { subTxId: string }) => r.subTxId === subA)
		const idxB = pipelineBody.results.findIndex((r: { subTxId: string }) => r.subTxId === subB)
		expect(idxA, "sub-tx with more changes should be processed first (merge ordering R23)").toBeLessThan(idxB)

		// The first sub-tx (big-agent) should have merged successfully
		expect(pipelineBody.results[idxA].merged).toBe(true)

		// The second sub-tx (small-agent) should have been rolled back
		expect(pipelineBody.results[idxB].merged).toBe(false)
		expect(pipelineBody.results[idxB].rollback).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// T6: R30 new-file reservation
// ---------------------------------------------------------------------------

describe("T6: R30 new-file reservation", () => {
	let fixture: OccFixture

	beforeEach(async () => {
		fixture = await createOccFixture()
	})
	afterEach(() => fixture.cleanup())

	it("first claimer wins; second claimer gets 409 FILE_ALREADY_RESERVED", async () => {
		const { tx_id: txId } = await beginTransaction(fixture)

		// Agent A claims a new file path
		const res1 = await post(fixture, `/tx/${txId}/reserve-file`, {
			file_path: "src/new-feature.ts",
			claimer_id: "agent-a",
		})
		expect(res1.status, "first reservation must succeed").toBe(200)
		const body1 = await res1.json()
		expect(body1.reserved).toBe(true)
		expect(body1.by).toBe("agent-a")

		// Agent B tries to claim the same path → conflict
		const res2 = await post(fixture, `/tx/${txId}/reserve-file`, {
			file_path: "src/new-feature.ts",
			claimer_id: "agent-b",
		})
		expect(res2.status, "duplicate reservation must return 409").toBe(409)
		const body2 = await res2.json()
		expect(body2.code).toBe("FILE_ALREADY_RESERVED")
		expect(body2.by, "response must identify the original claimer").toBe("agent-a")
	})

	it("different file paths can be claimed independently by different agents", async () => {
		const { tx_id: txId } = await beginTransaction(fixture)

		// Each agent reserves a different path — both should succeed
		const resA = await post(fixture, `/tx/${txId}/reserve-file`, {
			file_path: "src/component-a.ts",
			claimer_id: "agent-a",
		})
		expect(resA.status).toBe(200)

		const resB = await post(fixture, `/tx/${txId}/reserve-file`, {
			file_path: "src/component-b.ts",
			claimer_id: "agent-b",
		})
		expect(resB.status).toBe(200)
		expect((await resB.json()).by).toBe("agent-b")
	})

	it("reservations are cleaned up after transaction commit", async () => {
		// Use a test_command that passes so commit succeeds
		const { tx_id: txId } = await beginTransaction(fixture, {
			test_command: "node -e process.exit(0)",
		})

		// Reserve a file
		const reserveRes = await post(fixture, `/tx/${txId}/reserve-file`, {
			file_path: "src/post-commit.ts",
			claimer_id: "agent-a",
		})
		expect(reserveRes.status).toBe(200)

		// Commit the transaction (cleans up reservations server-side)
		const commitRes = await post(fixture, `/tx/${txId}/commit`, { strategy: "fail-fast" })
		expect([200, 201]).toContain(commitRes.status)

		// After commit, the SAME path in a new transaction should be freely reservable
		const { tx_id: txId2 } = await beginTransaction(fixture, {
			test_command: "node -e process.exit(0)",
		})
		const reserveRes2 = await post(fixture, `/tx/${txId2}/reserve-file`, {
			file_path: "src/post-commit.ts",
			claimer_id: "agent-c",
		})
		expect(reserveRes2.status, "new tx should allow reserving the same path again").toBe(200)

		// Cleanup the second tx
		await post(fixture, `/tx/${txId2}/commit`, { strategy: "fail-fast" })
	})
})

// ---------------------------------------------------------------------------
// Full-pipeline smoke: invariants hold after a clean commit
// ---------------------------------------------------------------------------

describe("Full-pipeline invariants after successful commit", () => {
	let fixture: OccFixture

	beforeEach(async () => {
		fixture = await createOccFixture()
	})
	afterEach(() => fixture.cleanup())

	it("after commit: no leftover worktrees, no tx branches, main is clean", async () => {
		// Use a passing test command so liveness lets the commit through
		const { tx_id: txId } = await beginTransaction(fixture, {
			test_command: "node -e process.exit(0)",
		})

		// Write a file through the tx endpoint
		const writeRes = await post(fixture, `/tx/${txId}/write`, {
			file_path: "src/smoke.ts",
			content_base64: Buffer.from("export const smoke = true").toString("base64"),
		})
		expect(writeRes.status).toBe(200)

		// Commit
		const commitRes = await post(fixture, `/tx/${txId}/commit`, { strategy: "fail-fast" })
		expect([200, 201]).toContain(commitRes.status)

		// Invariants
		assertNoLeftoverWorktrees(fixture.tmpDir)
		assertNoTxBranches(fixture.tmpDir)
	})
})
