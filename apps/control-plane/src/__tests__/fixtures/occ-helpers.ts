/**
 * OCC Acceptance Test Helpers
 *
 * Shared fixtures for testing Optimistic Concurrency Control (OCC) workflows.
 * Creates temporary git repositories with deterministic initial state.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync, execFile } from "node:child_process"
import { startServer } from "../../server.js"

export interface OccFixture {
	tmpDir: string
	app: Awaited<ReturnType<typeof startServer>>
	baseUrl: string
	headers: Record<string, string>
	cleanup: () => Promise<void>
}

/**
 * Initialize a git repository with deterministic config
 */
export async function initGitRepo(dir: string): Promise<void> {
	execFileSync("git", ["init"], { cwd: dir, windowsHide: true })
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, windowsHide: true })
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, windowsHide: true })
	// Set deterministic commit date for reproducibility
	const env = { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z" }
	execFileSync("git", ["commit", "--allow-empty", "-m", "Initial commit"], { cwd: dir, env, windowsHide: true })
	execFileSync("git", ["branch", "-M", "main"], { cwd: dir, windowsHide: true })
}

/**
 * Create a file in the repo and commit it
 */
export function createAndCommitFile(
	dir: string,
	relativePath: string,
	content: string,
	commitMessage: string,
): string {
	const fullPath = join(dir, relativePath)
	const parentDir = join(fullPath, "..")
	if (!existsSync(parentDir)) {
		mkdirSync(parentDir, { recursive: true })
	}
	writeFileSync(fullPath, content, "utf8")
	execFileSync("git", ["add", relativePath], { cwd: dir, windowsHide: true })
	const env = { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z" }
	execFileSync("git", ["commit", "-m", commitMessage], { cwd: dir, env, windowsHide: true })
	const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, windowsHide: true }).toString().trim()
	return sha
}

/**
 * Create the standard OCC test fixture
 */
export async function createOccFixture(): Promise<OccFixture> {
	const tmpDir = mkdtempSync(join(tmpdir(), "occ-test-"))
	await initGitRepo(tmpDir)

	const app = await startServer({
		repoRoot: tmpDir,
		port: 0, // Let OS choose a free port
		disableDb: true,
		disableMcp: true,
	})

	const address = app.server.address()
	const port = typeof address === "object" && address ? address.port : 0
	const baseUrl = `http://127.0.0.1:${port}`

	const headers = {
		"Content-Type": "application/json",
		"X-Actor-Id": "test-user",
		"X-Repo-Id": "test-repo",
		// NOTE: X-Allow-Test-Modify header was REMOVED - bypass is NOT acceptable
		// Test file modifications are now controlled by SERVER-SIDE config only
	}

	return {
		tmpDir,
		app,
		baseUrl,
		headers,
		cleanup: async () => {
			await app.close()
			// Wait a bit for handles to close on Windows
			await new Promise((r) => setTimeout(r, 100))
			try {
				rmSync(tmpDir, { recursive: true, force: true })
			} catch {
				// Ignore cleanup errors on Windows
			}
		},
	}
}

/**
 * Create a fixture with server-side test modification allowlist.
 * This is the ONLY way to allow test modifications - NOT via headers.
 */
export async function createOccFixtureWithTestAllowlist(allowlist: string[]): Promise<OccFixture> {
	const tmpDir = mkdtempSync(join(tmpdir(), "occ-test-allowlist-"))

	// Initialize git repo
	execFileSync("git", ["init"], { cwd: tmpDir, windowsHide: true })
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, windowsHide: true })
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir, windowsHide: true })

	// Create initial commit
	writeFileSync(join(tmpDir, "README.md"), "# OCC Test with Allowlist\n")
	execFileSync("git", ["add", "-A"], { cwd: tmpDir, windowsHide: true })
	execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, windowsHide: true })
	// Rename to main branch for consistency
	execFileSync("git", ["branch", "-M", "main"], { cwd: tmpDir, windowsHide: true })

	// Start server WITH test modification allowlist
	const app = await startServer({
		repoRoot: tmpDir,
		port: 0,
		disableDb: true,
		disableMcp: true,
		testModifyAllowlist: allowlist, // SERVER-SIDE config
	})

	const address = app.server.address()
	const port = typeof address === "object" && address ? address.port : 0
	const baseUrl = `http://127.0.0.1:${port}`

	const headers = {
		"Content-Type": "application/json",
		"X-Actor-Id": "test-user",
		"X-Repo-Id": "test-repo",
	}

	return {
		tmpDir,
		app,
		baseUrl,
		headers,
		cleanup: async () => {
			await app.close()
			await new Promise((r) => setTimeout(r, 100))
			try {
				rmSync(tmpDir, { recursive: true, force: true })
			} catch {
				// Ignore cleanup errors on Windows
			}
		},
	}
}

/**
 * Create a fixture with initial TypeScript-like files for testing
 */
export async function createOccFixtureWithFiles(): Promise<OccFixture> {
	const fixture = await createOccFixture()

	// Create src/a.ts
	createAndCommitFile(fixture.tmpDir, "src/a.ts", 'export function a() { return "a" }\n', "Add src/a.ts")

	// Create src/b.ts
	createAndCommitFile(fixture.tmpDir, "src/b.ts", 'export function b() { return "b" }\n', "Add src/b.ts")

	return fixture
}

/**
 * Create a fixture with a shared file for conflict testing
 */
export async function createOccFixtureWithSharedFile(): Promise<OccFixture> {
	const fixture = await createOccFixture()

	// Create src/shared.ts with a function that will be modified by multiple agents
	createAndCommitFile(
		fixture.tmpDir,
		"src/shared.ts",
		'export function shared() {\n  return "original"\n}\n',
		"Add src/shared.ts",
	)

	return fixture
}

/**
 * Create a fixture with a simple test setup for safety gate testing
 */
export async function createOccFixtureWithTests(): Promise<OccFixture> {
	const fixture = await createOccFixture()

	// Create src/lib.ts
	createAndCommitFile(fixture.tmpDir, "src/lib.ts", "export function add(a: number, b: number) { return a + b }\n", "Add lib.ts")

	// Create a simple test script that can be run via shell
	// Using a simple approach: write a test.js that exits 0 on pass, 1 on fail
	createAndCommitFile(
		fixture.tmpDir,
		"test.js",
		`// Simple test runner
const fs = require('fs')
const content = fs.readFileSync('src/lib.ts', 'utf8')
// Test: function should contain "return a + b"
if (content.includes('return a + b')) {
  console.log('PASS: add function is correct')
  process.exit(0)
} else {
  console.log('FAIL: add function is broken')
  process.exit(1)
}
`,
		"Add test.js",
	)

	return fixture
}

/**
 * Create a fixture with a TAP-format test runner for progress gate testing (R33)
 */
export async function createOccFixtureWithProgressTests(): Promise<OccFixture> {
	const fixture = await createOccFixture()

	// Create a simple test runner that outputs TAP format
	// Initially: 3 passing tests
	createAndCommitFile(
		fixture.tmpDir,
		"run-tests.js",
		`// Simple TAP test runner - 3 passing tests
console.log("ok 1 - test a");
console.log("ok 2 - test b");
console.log("ok 3 - test c");
process.exit(0);
`,
		"Add run-tests.js with 3 passing tests",
	)

	return fixture
}

/**
 * Create a fixture with an import graph for dependent-file conflict testing (R16)
 */
export async function createOccFixtureWithImportGraph(): Promise<OccFixture> {
	const fixture = await createOccFixture()

	// Create types.ts - the base type definitions
	createAndCommitFile(
		fixture.tmpDir,
		"src/types.ts",
		`// Base type definitions
export type Foo = string;
export interface Bar {
  value: Foo;
}
`,
		"Add types.ts",
	)

	// Create consumer.ts - imports from types.ts
	createAndCommitFile(
		fixture.tmpDir,
		"src/consumer.ts",
		`// Consumes types from types.ts
import { Foo, Bar } from './types';

export function useFoo(x: Foo): string {
  return x.toUpperCase();
}

export const bar: Bar = { value: "hello" };
`,
		"Add consumer.ts (imports types.ts)",
	)

	// Create index.ts - imports from consumer.ts
	createAndCommitFile(
		fixture.tmpDir,
		"src/index.ts",
		`// Entry point - imports consumer
import { useFoo, bar } from './consumer';

export const result = useFoo(bar.value);
`,
		"Add index.ts (imports consumer.ts)",
	)

	return fixture
}

/**
 * Helper to begin a parent transaction
 */
export async function beginTransaction(
	fixture: OccFixture,
	options?: { test_command?: string },
): Promise<{ tx_id: string; worktree_path: string }> {
	const res = await fetch(`${fixture.baseUrl}/tx/begin`, {
		method: "POST",
		headers: fixture.headers,
		body: JSON.stringify({ isolation: "hybrid", base: "main", test_command: options?.test_command }),
	})
	if (!res.ok) {
		throw new Error(`Failed to begin transaction: ${await res.text()}`)
	}
	return res.json()
}

/**
 * Helper to begin a sub-transaction
 */
export async function beginSubTransaction(
	fixture: OccFixture,
	parentTxId: string,
	subTxId: string,
	options?: { safetyChecks?: string[] },
): Promise<{ worktree_path: string; sub_tx_id: string }> {
	const res = await fetch(`${fixture.baseUrl}/tx/${parentTxId}/sub-tx/${subTxId}/begin`, {
		method: "POST",
		headers: fixture.headers,
		body: JSON.stringify({
			base: parentTxId,
			safetyChecks: options?.safetyChecks,
		}),
	})
	if (!res.ok) {
		throw new Error(`Failed to begin sub-transaction: ${await res.text()}`)
	}
	return res.json()
}

/**
 * Helper to write a file in a transaction's worktree
 */
export async function writeFileInTx(
	fixture: OccFixture,
	txId: string,
	filePath: string,
	content: string,
): Promise<void> {
	const res = await fetch(`${fixture.baseUrl}/tx/${txId}/write`, {
		method: "POST",
		headers: fixture.headers,
		body: JSON.stringify({
			file_path: filePath,
			content_base64: Buffer.from(content).toString("base64"),
		}),
	})
	if (!res.ok) {
		throw new Error(`Failed to write file: ${await res.text()}`)
	}
}

/**
 * Helper to create a checkpoint
 */
export async function createCheckpoint(fixture: OccFixture, txId: string): Promise<{ commit_sha: string }> {
	const res = await fetch(`${fixture.baseUrl}/tx/${txId}/checkpoint`, {
		method: "POST",
		headers: fixture.headers,
		body: JSON.stringify({ reason: "manual" }),
	})
	if (!res.ok) {
		throw new Error(`Failed to create checkpoint: ${await res.text()}`)
	}
	return res.json()
}

/**
 * Helper to run safety gate checks
 */
export async function runSafetyGate(
	fixture: OccFixture,
	parentTxId: string,
	subTxId: string,
	checks: string[],
): Promise<{ ok: boolean; failedAt?: string; results: any[] }> {
	const res = await fetch(`${fixture.baseUrl}/tx/${parentTxId}/sub-tx/${subTxId}/safety-gate`, {
		method: "POST",
		headers: fixture.headers,
		body: JSON.stringify({ checks }),
	})
	if (!res.ok) {
		throw new Error(`Failed to run safety gate: ${await res.text()}`)
	}
	return res.json()
}

/**
 * Helper to merge a sub-transaction
 * @param safetyGate - The safety gate result (if safety checks were run)
 * @param hasSafetyChecks - Whether this sub-tx has safety checks defined (for DB-less mode enforcement)
 */
export async function mergeSubTransaction(
	fixture: OccFixture,
	parentTxId: string,
	subTxId: string,
	safetyGate?: { ok: boolean; results?: any[]; failedAt?: string },
	hasSafetyChecks?: boolean,
): Promise<{ merged: boolean; status?: number; error?: string }> {
	const res = await fetch(`${fixture.baseUrl}/tx/${parentTxId}/sub-tx/${subTxId}/merge`, {
		method: "POST",
		headers: fixture.headers,
		body: JSON.stringify({
			safetyGate,
			// In DB-less mode, we need to tell the server if safety checks are defined
			hasSafetyChecks: hasSafetyChecks ?? !!safetyGate,
		}),
	})
	if (res.ok) {
		const data = await res.json()
		return { merged: data.merged, status: res.status }
	} else {
		const error = await res.text()
		return { merged: false, status: res.status, error }
	}
}

/**
 * Helper to rollback a sub-transaction
 */
export async function rollbackSubTransaction(
	fixture: OccFixture,
	parentTxId: string,
	subTxId: string,
	reason?: string,
): Promise<{ rolled_back: boolean; status: number }> {
	const res = await fetch(`${fixture.baseUrl}/tx/${parentTxId}/sub-tx/${subTxId}/rollback`, {
		method: "POST",
		headers: fixture.headers,
		body: JSON.stringify({ reason }),
	})
	// Return status for idempotency testing (both 200 and 404 are valid for already-cleaned)
	if (!res.ok && res.status !== 404) {
		throw new Error(`Failed to rollback sub-transaction: ${await res.text()}`)
	}
	try {
		const data = await res.json()
		return { ...data, status: res.status }
	} catch {
		return { rolled_back: res.ok, status: res.status }
	}
}

/**
 * Helper to list worktrees (for cleanup verification)
 */
export async function listWorktrees(fixture: OccFixture): Promise<{ worktrees: string[] }> {
	const res = await fetch(`${fixture.baseUrl}/git/worktrees`, {
		method: "GET",
		headers: fixture.headers,
	})
	if (!res.ok) {
		throw new Error(`Failed to list worktrees: ${await res.text()}`)
	}
	return res.json()
}

/**
 * Helper to list branches (for cleanup verification)
 */
export async function listBranches(fixture: OccFixture): Promise<{ branches: string[] }> {
	const res = await fetch(`${fixture.baseUrl}/git/branches`, {
		method: "GET",
		headers: fixture.headers,
	})
	if (!res.ok) {
		throw new Error(`Failed to list branches: ${await res.text()}`)
	}
	return res.json()
}

/**
 * Get file content from a worktree (direct filesystem read)
 */
export function readFileFromWorktree(worktreePath: string, relativePath: string): string {
	const { readFileSync } = require("fs") as typeof import("fs")
	return readFileSync(join(worktreePath, relativePath), "utf8")
}

/**
 * Write file to a worktree (direct filesystem write for simulating agent patches)
 */
export function writeFileToWorktree(worktreePath: string, relativePath: string, content: string): void {
	const { writeFileSync, mkdirSync, existsSync } = require("fs") as typeof import("fs")
	const fullPath = join(worktreePath, relativePath)
	const parentDir = join(fullPath, "..")
	if (!existsSync(parentDir)) {
		mkdirSync(parentDir, { recursive: true })
	}
	writeFileSync(fullPath, content, "utf8")
}

/**
 * Stage and commit changes in a worktree (simulating agent completing work)
 */
export function commitInWorktree(worktreePath: string, message: string): string {
	execFileSync("git", ["add", "-A"], { cwd: worktreePath, windowsHide: true })
	const env = { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:01:00Z", GIT_COMMITTER_DATE: "2024-01-01T00:01:00Z" }
	execFileSync("git", ["commit", "-m", message], { cwd: worktreePath, env, windowsHide: true })
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, windowsHide: true }).toString().trim()
}

/**
 * Check if a directory exists
 */
export function directoryExists(path: string): boolean {
	return existsSync(path)
}

/**
 * List directories in .cp/worktrees
 */
export function listWorktreeDirectories(repoRoot: string): string[] {
	const worktreesDir = join(repoRoot, ".cp", "worktrees")
	if (!existsSync(worktreesDir)) {
		return []
	}
	return readdirSync(worktreesDir)
}

/**
 * Execute a git command in a specific directory and return stdout
 */
export async function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
			if (error) {
				reject(error)
			} else {
				resolve({ stdout, stderr })
			}
		})
	})
}
