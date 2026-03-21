/**
 * Invariant checker helpers for txn-pipeline integration tests.
 *
 * Each helper asserts a system-level invariant that should hold at defined
 * points in the pipeline (post-commit, post-rollback, post-gate, etc.).
 * Failures produce descriptive messages so test output is self-explanatory.
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { expect } from "vitest"
import type { OccFixture } from "../fixtures/occ-helpers.js"

// ---------------------------------------------------------------------------
// Worktree invariants
// ---------------------------------------------------------------------------

/**
 * Assert that no worktrees remain in .cp/worktrees/ except for those whose
 * directory names are listed in `allowedNames`.
 *
 * Usage: after a full commit or rollback, pass [] to assert total cleanup.
 * During a test, pass the names of worktrees you expect to still be active.
 */
export function assertNoLeftoverWorktrees(repoRoot: string, allowedNames: string[] = []): void {
	const worktreesDir = join(repoRoot, ".cp", "worktrees")
	if (!existsSync(worktreesDir)) return // nothing there → already clean

	const actual = readdirSync(worktreesDir)
	const stale = actual.filter((name) => !allowedNames.includes(name))

	if (stale.length > 0) {
		throw new Error(
			`Found ${stale.length} leftover worktree(s) in .cp/worktrees/:\n` +
				stale.map((n) => `  - ${n}`).join("\n") +
				(allowedNames.length > 0 ? `\nAllowed: ${allowedNames.join(", ")}` : ""),
		)
	}
}

/**
 * Assert that no branches matching `tx/*` or `tx-*` patterns exist.
 * Call after a full commit/rollback cycle to confirm branch cleanup.
 */
export function assertNoTxBranches(repoRoot: string): void {
	const raw = execFileSync("git", ["branch", "--list", "tx/*", "tx-*"], {
		cwd: repoRoot,
		windowsHide: true,
	})
		.toString()
		.trim()

	if (raw.length > 0) {
		const branches = raw
			.split("\n")
			.map((b) => b.trim())
			.filter(Boolean)
		throw new Error(
			`Found ${branches.length} leftover tx branch(es):\n` + branches.map((b) => `  - ${b}`).join("\n"),
		)
	}
}

/**
 * Assert that the main working tree (the root repo, not a worktree) has no
 * staged or unstaged changes and no untracked files.
 */
export function assertMainClean(repoRoot: string): void {
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, windowsHide: true })
		.toString()
		.trim()

	if (status.length > 0) {
		throw new Error(`Main working tree is not clean:\n${status}`)
	}
}

// ---------------------------------------------------------------------------
// Commit-SHA invariants
// ---------------------------------------------------------------------------

/**
 * Return the current HEAD sha in the given directory.
 */
export function getHeadSha(dir: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, windowsHide: true }).toString().trim()
}

/**
 * Assert that HEAD has advanced (i.e. a commit happened).
 */
export function assertCommitAdvanced(before: string, after: string): void {
	expect(after, `Expected HEAD to advance from ${before} but it stayed the same`).not.toBe(before)
}

/**
 * Assert that HEAD has NOT moved (i.e. no commit was made).
 */
export function assertHeadUnchanged(dir: string, expected: string): void {
	const actual = getHeadSha(dir)
	expect(actual, `Expected HEAD to remain at ${expected} but found ${actual}`).toBe(expected)
}

// ---------------------------------------------------------------------------
// Worktree-path helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a specific worktree directory exists.
 */
export function assertWorktreeExists(worktreePath: string): void {
	expect(existsSync(worktreePath), `Expected worktree to exist at ${worktreePath}`).toBe(true)
}

/**
 * Assert that a specific worktree directory has been cleaned up.
 */
export function assertWorktreeGone(worktreePath: string): void {
	expect(existsSync(worktreePath), `Expected worktree to be gone at ${worktreePath} but it still exists`).toBe(false)
}

// ---------------------------------------------------------------------------
// Log/event invariants (via Fastify structured logger)
// ---------------------------------------------------------------------------

/**
 * Collect all Fastify log messages emitted by `app` during `fn()`.
 * Returns the messages as an array of strings so callers can assert
 * that gate decisions and merge decisions were logged.
 *
 * Usage:
 *   const logs = await captureLogs(fixture.app, async () => { ... })
 *   expect(logs.some(l => l.includes('PROGRESS_VIOLATION'))).toBe(true)
 */
export async function captureLogs(app: OccFixture["app"], fn: () => Promise<void>): Promise<string[]> {
	const captured: string[] = []

	// Fastify's default logger exposes child loggers; we intercept at the
	// serializer level. If the app was started without a custom logger, fall
	// back to a no-op (the test still works, just no log assertions).
	const origInfo = (app.log as any).info?.bind(app.log)
	const origWarn = (app.log as any).warn?.bind(app.log)
	;(app.log as any).info = (obj: any, msg?: string) => {
		captured.push(typeof obj === "string" ? obj : (msg ?? JSON.stringify(obj)))
		origInfo?.(obj, msg)
	}
	;(app.log as any).warn = (obj: any, msg?: string) => {
		captured.push(typeof obj === "string" ? obj : (msg ?? JSON.stringify(obj)))
		origWarn?.(obj, msg)
	}

	try {
		await fn()
	} finally {
		// Restore
		if (origInfo) (app.log as any).info = origInfo
		if (origWarn) (app.log as any).warn = origWarn
	}

	return captured
}
