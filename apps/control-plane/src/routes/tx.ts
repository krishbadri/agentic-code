import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Git } from "../git.js"
import { CPError, errorResponse, sendError } from "../errors.js"
import type { ProgressBaselineState } from "../server.js"
import { isTestFile, isTestModifyAllowed } from "../test-files.js"
import { subTxDeps, subTxHasChecks, subTxStatus, recordSubTxRollbackMetric, setSubTxStatus } from "../subtx-state.js"
import {
	getOrCreateRepo,
	insertTransaction,
	insertVersion,
	updateTransactionHead,
	getTransaction,
	finalizeTransaction,
	insertSubTransaction,
	updateSubTransactionStatus,
	getSubTransaction,
	insertSafetyCheckResults,
	insertSafetyGate,
	insertPlan,
	getPlan,
	listPlans,
} from "../store.js"

const HeadersSchema = z.object({
	"x-actor-id": z.string().min(1),
	"x-repo-id": z.string().min(1).optional(),
})

// R31, R32: tests are "given" — shared definition in test-files.ts

/**
 * Parse patch content to extract all file paths that would be modified.
 *
 * SECURITY: Patches can modify multiple files. We must validate ALL files
 * in the patch, not just the file_path parameter.
 *
 * Patch format:
 * --- a/path/to/file1.ts
 * +++ b/path/to/file1.ts
 * @@ ...
 * --- a/path/to/file2.ts
 * +++ b/path/to/file2.ts
 */
function extractPatchFilePaths(patch: string): string[] {
	const filePaths = new Set<string>()
	const lines = patch.split("\n")

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (!line) continue
		// Match "--- a/path" or "+++ b/path" (git diff format)
		const match = line.match(/^(?:---|\+\+\+)\s+(?:a|b)\/(.+)$/)
		if (match && match[1]) {
			// Remove "a/" or "b/" prefix and normalize
			const filePath = match[1].trim()
			// Remove leading "a/" or "b/" if present (some patches have it)
			const cleanPath = filePath.replace(/^(?:a|b)\//, "")
			if (cleanPath && cleanPath !== "/dev/null") {
				filePaths.add(cleanPath)
			}
		}
	}

	return Array.from(filePaths)
}

/**
 * Resolve a caller-supplied sub-tx id (relative or global) to the GLOBAL id of
 * an existing sub_transaction row, or undefined (so the FK is never violated).
 */
async function resolveSubTxFk(app: FastifyInstance, txId: string, raw?: string): Promise<string | undefined> {
	if (!raw || !app.db) return undefined
	const { toGlobalSubTxId } = await import("../ids.js")
	const global = toGlobalSubTxId(txId, raw)
	return (await getSubTransaction(app.db, global)) ? global : undefined
}

export function registerTxRoutes(app: FastifyInstance) {
	app.get("/health", async (req, reply) => {
		return reply.send({
			status: "ok",
			timestamp: Date.now(),
			version: "0.2.0",
			// Bumped when the HTTP contract changes; the extension requires api >= 2
			api: 2,
			capabilities: [
				"strict-structural",
				"ast-refine-js-ts",
				"clause-v1",
				"replay-file-level",
				"reserve-file",
				"liveness-config",
				"tx-status",
				"tx-abort",
				"rollback-backup-refs",
			],
			db: !app.db ? "none" : app.databaseUrl?.startsWith("postgresql://") ? "postgres" : "sqlite",
			// The repository this server manages. Clients MUST check it: a Control-Plane
			// bound to another repository would put their transaction in the wrong repo.
			repo_root: app.repoRoot,
			pid: process.pid,
			test_command_configured: !!app.cpConfig.testCommand,
		})
	})

	app.post("/tx/begin", async (req, reply) => {
		const headers = HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				isolation: z.enum(["fail-fast", "rebase", "hybrid"]).default("hybrid"),
				// "HEAD" = whatever the user's repository currently has checked out
				base: z.string().min(1).default("HEAD"),
				// Branch the transaction publishes to on commit (default: resolved from base)
				target_branch: z.string().min(1).optional(),
				// R33/R6: test command for the progress + liveness gates
				test_command: z.string().min(1).optional(),
				// R4: compile/type-check command; a failure is a progress violation
				compile_command: z.string().min(1).optional(),
			})
			.parse((req as any).body || {})

		const tx_id = randomUUID()
		try {
			const git = new Git({ repoRoot: app.repoRoot })
			await git.ensureCpExcluded()

			// Resolve which branch this transaction will publish to.
			let targetBranch = body.target_branch
			if (!targetBranch) {
				if (body.base === "HEAD") {
					targetBranch = (await git.currentBranch()) ?? undefined
					if (!targetBranch) {
						throw new CPError(
							"VALIDATION_ERROR",
							"Repository HEAD is detached; pass target_branch explicitly",
						)
					}
				} else if (await git.branchExists(body.base)) {
					targetBranch = body.base
				} else {
					throw new CPError(
						"VALIDATION_ERROR",
						`base "${body.base}" is not a branch; pass target_branch explicitly`,
					)
				}
			}
			if (!(await git.branchExists(targetBranch))) {
				throw new CPError("VALIDATION_ERROR", `target_branch "${targetBranch}" does not exist`)
			}

			const testCommand = body.test_command ?? app.cpConfig.testCommand
			const base_commit = await git.beginTx(tx_id, body.base)
			const worktree_path = git.worktreePath(tx_id)

			app.txMeta.set(tx_id, {
				base_commit,
				isolation: body.isolation,
				target_branch: targetBranch,
				test_command: testCommand,
				compile_command: body.compile_command,
				status: "active",
			})

			let repo_id = "default"
			let progressBaseline:
				| {
						passingCount: number
						totalCount: number
						format?: string
						exitCode?: number
						failingAtBase?: boolean
						warning?: string
				  }
				| undefined

			if (app.db) {
				repo_id = await getOrCreateRepo(app.db, app.repoRoot)
				await insertTransaction(app.db, {
					tx_id,
					repo_id,
					actor_id: headers["x-actor-id"],
					agent_id: headers["x-actor-id"],
					isolation_policy: body.isolation,
					base_commit,
					target_branch: targetBranch,
					compile_command: body.compile_command,
					test_command: testCommand,
				})
			}

			// R33: If a test command is configured, run tests and store the baseline
			if (testCommand) {
				const { runTestsAndCount } = await import("../progress-gate.js")
				const result = await runTestsAndCount(worktree_path, testCommand, {
					timeoutMs: app.cpConfig.testTimeoutMs,
				})
				if (result.spawnError) {
					// Roll the half-created tx back so a typo doesn't leak a worktree
					await git.removeTx(tx_id)
					app.txMeta.delete(tx_id)
					if (app.db) {
						try {
							await finalizeTransaction(app.db, tx_id, "aborted")
						} catch {
							/* ignore */
						}
					}
					throw new CPError(
						"TEST_COMMAND_INVALID",
						`Test command could not be started: ${result.spawnError}`,
						{
							test_command: testCommand,
						},
					)
				}
				const { effectivePassing } = await import("../progress-gate.js")
				const basePassing = effectivePassing(result)
				const { noTestsCollected } = await import("../progress-gate.js")
				const baseRed =
					result.exitCode !== 0 && !noTestsCollected(result.stdout + "\n" + result.stderr, result.exitCode)
				progressBaseline = {
					passingCount: basePassing,
					totalCount: result.totalCount,
					format: result.format,
					exitCode: result.exitCode,
					// The final commit requires a green suite (liveness). Tell the client up
					// front when the suite is already red, so it is not discovered at commit.
					failingAtBase: baseRed,
					...(baseRed
						? {
								warning:
									"The test suite is already failing at the base commit; the final commit " +
									"will be refused until the tests pass",
							}
						: result.format === "unknown"
							? { warning: "Test output format not recognised; progress is judged by exit code only" }
							: {}),
				}

				if (app.db) {
					const { setProgressBaseline } = await import("../store.js")
					await setProgressBaseline(app.db, tx_id, basePassing, result.totalCount, testCommand)
				}
				// Always keep the in-memory copy (format is not persisted in the DB)
				app.progressBaselines!.set(tx_id, {
					passing_count: basePassing,
					total_count: result.totalCount,
					test_command: testCommand,
					last_checkpoint_count: basePassing,
					format: result.format,
					exit_code: result.exitCode,
					failing_at_base: baseRed,
				})
			}

			return reply.send({
				tx_id,
				base_commit,
				branch: `tx/${tx_id}`,
				target_branch: targetBranch,
				worktree_path,
				policy: { isolation: body.isolation },
				test_command_configured: !!testCommand,
				progress_baseline: progressBaseline,
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// Transaction status (used by the extension to resume a task's transaction)
	app.get("/tx/:tx_id", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const txId = (req.params as any).tx_id
		const git = new Git({ repoRoot: app.repoRoot })
		const { existsSync } = await import("node:fs")
		const { loadTxMeta } = await import("../tx-meta.js")
		const meta = await loadTxMeta(app, txId)
		const worktree_path = git.worktreePath(txId)
		const hasWorktree = existsSync(worktree_path)
		if (!meta && !hasWorktree) {
			throw new CPError("TX_NOT_FOUND", `Transaction ${txId} not found`, { tx_id: txId })
		}
		// A worktree that vanished means the tx can no longer make progress
		const status = meta?.status === "active" && !hasWorktree ? "aborted" : (meta?.status ?? "active")
		let head_commit: string | undefined
		if (hasWorktree) {
			try {
				head_commit = await git.revParse("HEAD", worktree_path)
			} catch {
				/* ignore */
			}
		}
		return reply.send({
			tx_id: txId,
			status,
			worktree_path: hasWorktree ? worktree_path : undefined,
			base_commit: meta?.base_commit,
			head_commit,
			target_branch: meta?.target_branch,
			isolation: meta?.isolation,
			test_command_configured: !!meta?.test_command,
		})
	})

	// Explicit discard of a transaction (idempotent)
	app.post("/tx/:tx_id/abort", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z.object({ reason: z.string().optional() }).parse((req as any).body || {})
		const txId = (req.params as any).tx_id
		const git = new Git({ repoRoot: app.repoRoot })
		const { killTxProcesses } = await import("../exec.js")
		const processes_killed = await killTxProcesses(app, txId)
		const sub_txs_removed = await git.cleanupAllSubTxs(txId)
		await git.removeTx(txId)
		if (app.db) {
			try {
				await finalizeTransaction(app.db, txId, "aborted")
			} catch {
				/* unknown tx in DB: still idempotent */
			}
		}
		const { setTxStatus } = await import("../tx-meta.js")
		setTxStatus(app, txId, "aborted")
		app.fileReservations.delete(txId)
		app.mergedSnapshots.delete(txId)
		app.log.info({ txId, reason: body.reason }, "Transaction aborted")
		return reply.send({ aborted: true, tx_id: txId, sub_txs_removed, processes_killed })
	})

	app.post("/tx/:tx_id/apply", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z.object({ file_path: z.string(), patch: z.string() }).parse((req as any).body || {})

		// SECURITY: Parse patch content to extract ALL file paths it modifies
		// Attack vector: file_path="src/safe.ts" but patch modifies "test/file.test.ts"
		const patchFilePaths = extractPatchFilePaths(body.patch)

		// Validate file_path parameter
		if (isTestFile(body.file_path) && !isTestModifyAllowed(body.file_path, app.testModifyAllowlist)) {
			return reply.code(403).send({
				code: "TEST_FILE_PROTECTED",
				message: `R31/R32 violation: Tests are "given". Modifying test file "${body.file_path}" is not allowed. Server must be configured with testModifyAllowlist to permit this.`,
				file_path: body.file_path,
			})
		}

		// SECURITY: Validate ALL files in patch content (not just file_path parameter)
		for (const patchFilePath of patchFilePaths) {
			if (isTestFile(patchFilePath) && !isTestModifyAllowed(patchFilePath, app.testModifyAllowlist)) {
				return reply.code(403).send({
					code: "TEST_FILE_PROTECTED",
					message: `R31/R32 violation: Patch content attempts to modify test file "${patchFilePath}" which is not allowed. Server must be configured with testModifyAllowlist to permit this.`,
					file_path: patchFilePath,
					patch_contains_test_file: true,
				})
			}
		}

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			await git.applyPatch((req.params as any).tx_id, body.file_path, body.patch)
			return reply.send({
				ok: true,
				bytes_applied: Buffer.byteLength(body.patch, "utf8"),
				files_touched: patchFilePaths.length > 0 ? patchFilePaths : [body.file_path],
			})
		} catch (e: any) {
			// R26: Surface deterministic error for .rej files
			if (e.code === "PATCH_REJECTED") {
				return reply.code(400).send({
					code: "PATCH_REJECTED",
					message: e.message,
					rej_files: e.details?.rej_files || e.details?.rejFiles || [],
					file_path: e.details?.file_path || body.file_path,
				})
			}
			if (e.code === "BAD_PATCH") {
				return reply.code(400).send({
					code: "BAD_PATCH",
					message: e.message,
					file_path: e.details?.file_path || body.file_path,
				})
			}
			return sendError(reply, e, 400)
		}
	})

	app.post("/tx/:tx_id/write", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({ file_path: z.string(), content_base64: z.string(), mode: z.string().optional() })
			.parse((req as any).body || {})

		// R31/R32: Tests are given — agents may neither modify existing tests nor
		// introduce new ones, unless the path is on the SERVER-SIDE allowlist.
		if (isTestFile(body.file_path) && !isTestModifyAllowed(body.file_path, app.testModifyAllowlist)) {
			const { existsSync } = await import("node:fs")
			const { join } = await import("node:path")
			const wt = new Git({ repoRoot: app.repoRoot }).worktreePath((req.params as any).tx_id)
			const exists = existsSync(join(wt, body.file_path))
			return reply.code(403).send({
				code: "TEST_FILE_PROTECTED",
				message: `R31/R32 violation: Tests are "given". ${exists ? "Modifying the existing" : "Creating a new"} test file "${body.file_path}" is not allowed.`,
				file_path: body.file_path,
			})
		}

		try {
			const bytesBuf = Buffer.from(body.content_base64, "base64")
			const git = new Git({ repoRoot: app.repoRoot })
			await git.writeFile((req.params as any).tx_id, body.file_path, bytesBuf, body.mode)
			return reply.send({ ok: true, bytes: bytesBuf.byteLength })
		} catch (e) {
			return sendError(reply, e, 400)
		}
	})

	app.get("/tx/:tx_id/read", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const query = z.object({ file_path: z.string() }).parse((req as any).query || {})
		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const { content, mode } = await git.readFile((req.params as any).tx_id, query.file_path)
			return reply.send({ content_base64: content.toString("base64"), mode })
		} catch (e) {
			return sendError(reply, e, 404)
		}
	})

	app.post("/tx/:tx_id/checkpoint", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				reason: z.string().min(1).max(64), // e.g. human | auto | manual | plan-group
				policy_snapshot: z.record(z.any()).optional(),
				trailers: z.record(z.string()).optional(),
			})
			.parse((req as any).body || {})

		const txId = (req.params as any).tx_id

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const worktreePath = git.worktreePath(txId)

			// R33: Progress Gate - check if test count is monotonically non-decreasing
			// Check DB first, then in-memory storage for testing
			let baseline: ProgressBaselineState | null = app.progressBaselines?.get(txId) ?? null

			if (!baseline && app.db) {
				const { getProgressBaseline, getLastProgressCheckpoint } = await import("../store.js")
				const dbBaseline = await getProgressBaseline(app.db, txId)
				if (dbBaseline) {
					const lastCp = await getLastProgressCheckpoint(app.db, txId)
					baseline = {
						passing_count: dbBaseline.passing_count,
						total_count: dbBaseline.total_count,
						test_command: dbBaseline.test_command,
						last_checkpoint_count: lastCp?.passing_count ?? dbBaseline.passing_count,
						last_checkpoint_sha: lastCp?.checkpoint_sha,
					}
				}
			}

			const { loadTxMeta } = await import("../tx-meta.js")
			const meta = await loadTxMeta(app, txId)

			// Last known-good state: the last passing checkpoint, else where the tx began.
			const lastGoodTarget = async (lastSha?: string) => {
				if (lastSha) return lastSha
				if (meta?.base_commit) return meta.base_commit
				return git.revParse("HEAD", worktreePath)
			}

			// R4: compile / type-check gate (a broken build is never a valid checkpoint)
			if (meta?.compile_command) {
				const { runCommand } = await import("../exec.js")
				const compile = await runCommand(worktreePath, meta.compile_command, {
					timeoutMs: app.cpConfig.testTimeoutMs,
					app,
					txId,
				})
				if (compile.exitCode !== 0) {
					const rollbackTarget = await lastGoodTarget(baseline?.last_checkpoint_sha)
					const snap = await git.snapshotAndReset(
						worktreePath,
						rollbackTarget,
						`compile-violation tx:${txId}`,
					)
					return reply.code(403).send({
						code: "PROGRESS_VIOLATION",
						kind: "compile",
						message: `Compile check failed (exit ${compile.exitCode}): ${meta.compile_command}`,
						compile_output: (compile.stdout + "\n" + compile.stderr).slice(-4096),
						rollback_to: rollbackTarget,
						backup_ref: snap.backup_ref,
					})
				}
			}

			if (baseline) {
				const { runTestsAndCount, isProgressValid, effectivePassing } = await import("../progress-gate.js")
				const currentResult = await runTestsAndCount(worktreePath, baseline.test_command, {
					timeoutMs: app.cpConfig.testTimeoutMs,
					app,
					txId,
				})
				const currentPassing = effectivePassing(currentResult, baseline.format)
				const lastPassingCount = baseline.last_checkpoint_count ?? baseline.passing_count

				// R33: Enforce monotonic non-decreasing
				if (!isProgressValid(lastPassingCount, currentPassing)) {
					const rollbackTarget = await lastGoodTarget(baseline.last_checkpoint_sha)
					// Keep the rejected work recoverable under a backup ref, then reset
					const snap = await git.snapshotAndReset(
						worktreePath,
						rollbackTarget,
						`progress-violation tx:${txId}`,
					)

					return reply.code(403).send({
						code: "PROGRESS_VIOLATION",
						kind: "tests",
						message: `Progress gate failed: passing test count decreased from ${lastPassingCount} to ${currentPassing}`,
						baseline_count: baseline.passing_count,
						last_checkpoint_count: lastPassingCount,
						current_count: currentPassing,
						failing_count: currentResult.failingCount,
						format: currentResult.format,
						rollback_to: rollbackTarget,
						backup_ref: snap.backup_ref,
					})
				}

				// Record this checkpoint's progress
				// Include checkpoint name from trailers so git log search can find it by name
				const progressTrailerMsg = body.trailers?.Message
				const msg = progressTrailerMsg ? `[cp] ${progressTrailerMsg} (tx:${txId})` : `[cp] tx:${txId}`
				const { sha, tag } = await git.checkpoint(txId, msg)

				// Update storage
				if (app.db) {
					const { recordProgressCheckpoint } = await import("../store.js")
					await recordProgressCheckpoint(app.db, txId, sha, currentPassing, currentResult.totalCount)

					const tx = await getTransaction(app.db, txId)
					if (tx) {
						await updateTransactionHead(app.db, tx.tx_id, sha)
						await insertVersion(
							app.db,
							tx.repo_id,
							sha,
							tag,
							(req.headers as any)["x-actor-id"],
							(req as any).body?.policy_snapshot || {},
						)
					}
				}
				// Keep the in-memory copy current in both modes (it carries the output format)
				baseline.last_checkpoint_count = currentPassing
				baseline.last_checkpoint_sha = sha
				app.progressBaselines!.set(txId, baseline)

				return reply.code(201).send({
					commit_sha: sha,
					tag,
					version_id: randomUUID(),
					progress: {
						passing_count: currentPassing,
						failing_count: currentResult.failingCount,
						total_count: currentResult.totalCount,
						baseline_count: baseline.passing_count,
						format: currentResult.format,
					},
				})
			}

			// No progress gate configured - proceed normally
			// Include checkpoint name from trailers so git log search can find it by name
			const trailerMsg = body.trailers?.Message
			const msg = trailerMsg ? `[cp] ${trailerMsg} (tx:${txId})` : `[cp] tx:${txId}`
			const { sha, tag } = await git.checkpoint(txId, msg)
			if (app.db) {
				const tx = await getTransaction(app.db, txId)
				if (tx) {
					await updateTransactionHead(app.db, tx.tx_id, sha)
					await insertVersion(
						app.db,
						tx.repo_id,
						sha,
						tag,
						(req.headers as any)["x-actor-id"],
						(req as any).body?.policy_snapshot || {},
					)
				}
			}
			return reply.code(201).send({ commit_sha: sha, tag, version_id: randomUUID() })
		} catch (e) {
			return sendError(reply, e)
		}
	})

	app.post("/tx/:tx_id/commit", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				// Defaults to the isolation policy the transaction was begun with
				strategy: z.enum(["fail-fast", "rebase", "hybrid"]).optional(),
				maxRebaseMs: z.number().int().optional(),
				maxConflictFiles: z.number().int().optional(),
				// Liveness check parameters (optional - can come from persisted state)
				required_steps: z.array(z.string()).optional(),
				completed_steps: z.array(z.string()).optional(),
				// Used only when the transaction has no stored test command
				test_command: z.string().min(1).optional(),
				// R6: refuse to commit when no liveness test command is configured
				require_liveness: z.boolean().default(false),
			})
			.parse((req as any).body || {})

		const txId = (req.params as any).tx_id

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const worktreePath = git.worktreePath(txId)
			const { loadTxMeta, setTxStatus } = await import("../tx-meta.js")
			const meta = await loadTxMeta(app, txId)
			if (meta && meta.status !== "active") {
				throw new CPError("TX_NOT_ACTIVE", `Transaction ${txId} is already ${meta.status}`, {
					status: meta.status,
				})
			}
			const strategy = body.strategy ?? meta?.isolation ?? "fail-fast"

			// Commit any uncommitted work in the tx worktree first, so liveness tests
			// exactly what is published (agents write files directly in the worktree).
			try {
				const { stdout } = await (git as any).git(["status", "--porcelain"], worktreePath)
				if (stdout.trim()) {
					await git.checkpoint(txId, `[cp] final changes (tx:${txId})`)
				}
			} catch {
				/* nothing to commit */
			}

			// R6, Slide 68: Liveness MUST run at FINAL commit point
			// Get test_command from progress baseline (stored "given tests")
			let testCommand: string | undefined = meta?.test_command
			let baseline: {
				passing_count: number
				total_count: number
				test_command: string
				last_checkpoint_sha?: string
			} | null = null

			if (app.db) {
				const { getProgressBaseline } = await import("../store.js")
				const dbBaseline = await getProgressBaseline(app.db, txId)
				if (dbBaseline) {
					baseline = {
						passing_count: dbBaseline.passing_count,
						total_count: dbBaseline.total_count,
						test_command: dbBaseline.test_command,
					}
					// Get last checkpoint SHA for rollback target
					const { getLastProgressCheckpoint } = await import("../store.js")
					const lastCp = await getLastProgressCheckpoint(app.db, txId)
					if (lastCp) {
						baseline.last_checkpoint_sha = lastCp.checkpoint_sha
					}
					testCommand = dbBaseline.test_command
				}
			} else if (app.progressBaselines?.has(txId)) {
				// In-memory storage for DB-less mode (testing)
				baseline = app.progressBaselines.get(txId) ?? null
				if (baseline) {
					testCommand = baseline.test_command
				}
			}

			testCommand = testCommand ?? body.test_command
			if (!testCommand && body.require_liveness) {
				throw new CPError(
					"LIVENESS_UNCONFIGURED",
					"Liveness is required at the final commit but no test command is configured for this transaction",
				)
			}

			let liveness: { ran: boolean; passed?: boolean; reason?: string } = {
				ran: false,
				reason: "no test command configured",
			}

			// Run liveness check if test_command is available (given tests)
			if (testCommand) {
				const { checkLiveness, createLivenessEvent } = await import("../liveness.js")

				const check = await checkLiveness(worktreePath, {
					testCommand,
					requiredSteps: body.required_steps,
					completedSteps: body.completed_steps,
					timeoutMs: app.cpConfig.testTimeoutMs,
				})
				liveness = { ran: true, passed: check.passed, reason: check.details.error }

				const event = createLivenessEvent(check, txId, true)

				app.log.info({ event }, `Liveness check at final commit: ${check.passed ? "PASSED" : "FAILED"}`)

				if (!check.passed) {
					// R7, Slide 68: Rollback to last good checkpoint on liveness failure
					// (last passing progress checkpoint, else where the tx began)
					const rollbackTarget =
						baseline?.last_checkpoint_sha ??
						app.progressBaselines?.get(txId)?.last_checkpoint_sha ??
						meta?.base_commit ??
						(await git.revParse("HEAD", worktreePath))

					// Perform rollback (rejected work stays recoverable under a backup ref)
					const snap = await git.snapshotAndReset(
						worktreePath,
						rollbackTarget,
						`liveness-violation tx:${txId}`,
					)

					return reply.code(403).send({
						code: "LIVENESS_FAILED",
						message:
							`Liveness check failed at final commit: ${check.details.error || "Tests failed or pending steps"}` +
							(app.progressBaselines?.get(txId)?.failing_at_base
								? " (the test suite was already failing when this transaction began)"
								: ""),
						baseline_was_failing: !!app.progressBaselines?.get(txId)?.failing_at_base,
						passed: false,
						testsPass: check.testsPass,
						noPendingSteps: check.noPendingSteps,
						details: check.details,
						event,
						rollback_to: rollbackTarget,
						backup_ref: snap.backup_ref,
					})
				}
			}

			// Liveness passed (or not configured) - proceed with commit
			const baseSha = meta?.base_commit ?? ""
			const targetBranch = meta?.target_branch ?? (await git.currentBranch()) ?? "main"

			const res = await git.commitToMain(txId, baseSha, strategy, targetBranch)
			if ("conflict" in res) {
				// The transaction stays OPEN: the caller may resolve (e.g. rebase,
				// clean the workspace) and retry, or abort explicitly.
				return reply.code(409).send({
					code: res.conflict.code,
					message: `Commit refused: ${res.conflict.code}`,
					details: { ...res.conflict.details },
					liveness,
				})
			}

			if (app.db) {
				await finalizeTransaction(app.db, txId, "committed")
			}
			setTxStatus(app, txId, "committed")
			// R30: Clean up file reservations for this transaction
			app.fileReservations.delete(txId)
			app.mergedSnapshots.delete(txId)
			return reply.send({
				merged_sha: res.merged_sha,
				advanced_head: true,
				target_branch: res.target_branch,
				strategy,
				liveness,
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	app.post("/tx/:tx_id/rollback", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z.object({ hash: z.string() }).parse((req as any).body || {})

		const startTime = Date.now()
		const txId = (req.params as any).tx_id

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const wt = git.worktreePath(txId)

			// Only commits that belong to this transaction's history are valid targets
			const target = await git.verifyCommit(body.hash, wt)
			if (!(await git.isAncestor(target, "HEAD", wt))) {
				throw new CPError("VALIDATION_ERROR", `Commit ${body.hash} is not part of transaction ${txId}`, {
					hash: body.hash,
				})
			}

			// Stop anything the transaction left running (dev servers, watchers, ...)
			const { killTxProcesses } = await import("../exec.js")
			const processesKilled = await killTxProcesses(app, txId)

			// Back up the discarded work, then reset + clean (ignored files are kept)
			const snap = await git.snapshotAndReset(wt, target, `rollback tx:${txId}`)
			const filesAffected = snap.files_affected

			const durationMs = Date.now() - startTime

			// Record rollback metrics
			if (app.db) {
				try {
					const { insertMetricRollback } = await import("../store.js")
					await insertMetricRollback(app.db, {
						tx_id: txId,
						duration_ms: durationMs,
						files_affected: filesAffected,
						bytes_rolled_back: snap.bytes_rolled_back,
						rollback_type: "transaction",
					})
				} catch (metricErr) {
					app.log.warn({ err: metricErr }, "Failed to record rollback metric")
				}
			}

			// Progress gate: a checkpoint that was rolled away can no longer be "last good"
			const pb = app.progressBaselines?.get(txId)
			if (pb && pb.last_checkpoint_sha && !(await git.isAncestor(pb.last_checkpoint_sha, target, wt))) {
				pb.last_checkpoint_sha = target
			}

			// R30: Clean up file reservations for this transaction
			app.fileReservations.delete(txId)
			return reply.send({
				rolled_back_to: target,
				message: `Rolled back to commit ${target}`,
				duration_ms: durationMs,
				files_affected: filesAffected,
				bytes_rolled_back: snap.bytes_rolled_back,
				backup_ref: snap.backup_ref,
				processes_killed: processesKilled,
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// Sub-transaction endpoints
	app.post("/tx/:tx_id/sub-tx/:sub_tx_id/begin", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				base: z.string().optional(),
				// Planning info for persistence
				title: z.string().optional(),
				description: z.string().optional(),
				agentType: z.string().optional(),
				prompt: z.string().optional(),
				dependsOn: z.array(z.string()).optional(),
				safetyChecks: z.array(z.string()).optional(),
			})
			.parse((req as any).body || {})

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const parentTxId = (req.params as any).tx_id
			const { assertSubTxId, toGlobalSubTxId } = await import("../ids.js")
			const relativeSubTxId = assertSubTxId(parentTxId, (req.params as any).sub_tx_id)
			const base = body.base || parentTxId

			// Make sub_tx_id globally unique by prefixing with parent tx_id
			// This ensures "st1" from tx-abc is different from "st1" from tx-def
			const globalSubTxId = toGlobalSubTxId(parentTxId, relativeSubTxId)
			const dependsOn = (body.dependsOn ?? []).map((d) => assertSubTxId(parentTxId, d))

			const worktreePath = await git.beginSubTx(parentTxId, relativeSubTxId, base)
			const baseCommit = await git.revParse("HEAD", worktreePath)
			subTxDeps.set(globalSubTxId, dependsOn)
			subTxStatus.set(globalSubTxId, "RUNNING")
			app.safetyGates.delete(globalSubTxId)
			if (body.safetyChecks && body.safetyChecks.length > 0) subTxHasChecks.add(globalSubTxId)

			// Persist sub-transaction to database
			if (app.db) {
				await insertSubTransaction(app.db, {
					sub_tx_id: globalSubTxId,
					tx_id: parentTxId,
					title: body.title,
					description: body.description,
					agent_type: body.agentType,
					prompt: body.prompt,
					depends_on: dependsOn,
					safety_checks: body.safetyChecks,
					base_commit: baseCommit,
					status: "RUNNING",
					worktree_path: worktreePath,
				})
			}

			return reply.send({
				worktree_path: worktreePath,
				sub_tx_id: globalSubTxId,
				relative_id: relativeSubTxId,
				parent_tx_id: parentTxId,
				base_commit: baseCommit,
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// Merge ONE sub-transaction (fallback path; prefer /merge-pipeline).
	// Enforces depends_on, the safety gate, and the strict structural policy
	// against every sub-tx already merged into the parent.
	app.post("/tx/:tx_id/sub-tx/:sub_tx_id/merge", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				// Safety gate result - if provided, MUST have ok=true to merge
				safetyGate: z
					.object({
						ok: z.boolean(),
						results: z.array(z.any()).optional(),
						failedAt: z.string().optional(),
					})
					.optional(),
				// Whether this sub-tx has safety checks defined
				hasSafetyChecks: z.boolean().default(false),
				// Skip the safety gate (testing/emergency only). Never skips the structural check.
				forceMerge: z.boolean().default(false),
			})
			.parse((req as any).body || {})

		const { requireSubTx } = await import("../guards.js")
		const sub = await requireSubTx(app, (req.params as any).tx_id, (req.params as any).sub_tx_id)
		const { parentTxId, rel: relativeSubTxId, global: globalSubTxId, git } = sub
		const { getDependsOn, getSubTxStatus, hasDeclaredSafetyChecks, getRecordedSafetyGate } = await import(
			"../subtx-state.js"
		)

		try {
			// Enforce dependency ordering: every depends_on must be COMMITTED first
			for (const depId of await getDependsOn(app, parentTxId, relativeSubTxId)) {
				const depStatus = await getSubTxStatus(app, `${parentTxId}:${depId}`)
				if (depStatus !== "COMMITTED") {
					return reply.code(409).send({
						code: "DEPENDENCY_NOT_MET",
						message: `Cannot merge: dependency "${depId}" has not been committed yet (status: ${depStatus ?? "NOT_FOUND"})`,
						dependency: depId,
						dependencyStatus: depStatus ?? "NOT_FOUND",
					})
				}
			}

			// Safety gate: required when checks were declared or a gate was run
			const recorded = await getRecordedSafetyGate(app, globalSubTxId)
			const gate = body.safetyGate ?? recorded ?? undefined
			const hasSafetyChecks =
				body.hasSafetyChecks || recorded !== null || (await hasDeclaredSafetyChecks(app, globalSubTxId))
			if (hasSafetyChecks && !body.forceMerge) {
				if (!gate) {
					return reply.code(403).send({
						code: "SAFETY_GATE_REQUIRED",
						message:
							"Safety checks are defined but no safety gate result was provided. Run safety-gate endpoint first.",
					})
				}
				if (!gate.ok || (recorded && !recorded.ok)) {
					await setSubTxStatus(app, globalSubTxId, "ABORTED", undefined, {
						kind: "SAFETY_FAIL",
						message: `Failed at: ${(body.safetyGate as any)?.failedAt ?? "recorded gate"}`,
					})
					return reply.code(403).send({
						code: "SAFETY_GATE_FAILED",
						message: `Safety checks failed at: ${(body.safetyGate as any)?.failedAt ?? "recorded gate"}. Merge blocked.`,
						safetyGate: gate,
					})
				}
			}

			// Strict structural policy (R16/R17): conflicts with an already-merged
			// sibling roll this sub-tx back even if git could merge it.
			const { checkAgainstMerged } = await import("../merge-pipeline.js")
			const check = await checkAgainstMerged(app, parentTxId, relativeSubTxId, sub.worktreePath)
			if (check.conflicts.length > 0) {
				await git.rollbackSubTx(parentTxId, relativeSubTxId)
				const [withId, conflict] = check.conflicts[0]!
				await setSubTxStatus(app, globalSubTxId, "ABORTED", undefined, {
					kind: "STRUCTURAL_CONFLICT",
					message: conflict.message ?? `conflicts with ${withId}`,
				})
				return reply.code(409).send({
					code: "STRUCTURAL_CONFLICT",
					message: `Structural conflict with already-merged sub-transaction(s): ${check.conflicts.map(([id]) => id).join(", ")}. Rolled back.`,
					sub_tx_id: globalSubTxId,
					conflicts_with: check.conflicts.map(([id]) => id),
					conflict_type: conflict.conflictType,
					files: conflict.conflictingFiles,
				})
			}

			// R15, R17: Detect conflicts at merge time and abort/rollback on failure
			const mergeResult = await git.mergeSubTx(parentTxId, relativeSubTxId)

			if (!mergeResult.merged && mergeResult.conflict) {
				// R17, R24: Abort and rollback conflicting work
				await setSubTxStatus(app, globalSubTxId, "ABORTED", undefined, {
					kind: "MERGE_CONFLICT",
					message: mergeResult.conflict,
				})
				return reply.code(409).send({
					code: "MERGE_CONFLICT",
					message: `Merge conflict detected: ${mergeResult.conflict}`,
					sub_tx_id: globalSubTxId,
				})
			}

			const mergeCommit = await git.revParse("HEAD", git.worktreePath(parentTxId))
			await setSubTxStatus(app, globalSubTxId, "COMMITTED", mergeCommit)
			const merged = app.mergedSnapshots.get(parentTxId) ?? []
			merged.push(check.snapshot)
			app.mergedSnapshots.set(parentTxId, merged)

			return reply.send({
				merged: true,
				sub_tx_id: globalSubTxId,
				relative_id: relativeSubTxId,
				parent_tx_id: parentTxId,
				merge_commit: mergeCommit,
				safetyGatePassed: gate?.ok ?? null,
			})
		} catch (e) {
			await setSubTxStatus(app, globalSubTxId, "ABORTED", undefined, {
				kind: "MERGE_CONFLICT",
				message: String(e),
			})
			return sendError(reply, e)
		}
	})

	app.post("/tx/:tx_id/sub-tx/:sub_tx_id/rollback", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				reason: z.string().optional(),
				failureKind: z
					.enum([
						"MERGE_CONFLICT",
						"STRUCTURAL_CONFLICT",
						"SAFETY_FAIL",
						"RUNTIME_ERROR",
						"TIMEOUT",
						"DEPENDENCY_FAILED",
						"WORKTREE_CREATE_FAILED",
						"PROGRESS_VIOLATION",
						"ABORTED",
					])
					.optional(),
			})
			.parse((req as any).body || {})

		const startTime = Date.now()

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const parentTxId = (req.params as any).tx_id
			const { assertSubTxId, toGlobalSubTxId } = await import("../ids.js")
			const subTxId = assertSubTxId(parentTxId, (req.params as any).sub_tx_id)
			const globalSubTxId = toGlobalSubTxId(parentTxId, subTxId)

			// Measure what is being discarded before it disappears
			let bytesRolledBack = 0
			let filesAffected = 0
			try {
				const subWt = git.subTxWorktreePath(parentTxId, subTxId)
				const parentHead = await git.revParse("HEAD", git.worktreePath(parentTxId))
				const stat = await git.diffSize(subWt, parentHead)
				bytesRolledBack = stat.bytes
				filesAffected = stat.files
			} catch {
				/* worktree already gone */
			}
			const { killTxProcesses } = await import("../exec.js")
			await killTxProcesses(app, `${parentTxId}_sub_${subTxId}`)

			// Idempotent rollback: don't fail if already cleaned up
			try {
				await git.rollbackSubTx(parentTxId, subTxId)
			} catch (e) {
				// If worktree/branch already cleaned up, that's OK (idempotent)
				const errMsg = String(e)
				if (
					!errMsg.includes("not a valid") &&
					!errMsg.includes("does not exist") &&
					!errMsg.includes("Cannot find")
				) {
					throw e // Re-throw unexpected errors
				}
				// Already cleaned up - return success (idempotent)
			}

			const durationMs = Date.now() - startTime

			// Persist rollback status and metrics
			app.safetyGates.delete(globalSubTxId)
			await setSubTxStatus(app, globalSubTxId, "ABORTED", undefined, {
				kind: body.failureKind || "RUNTIME_ERROR",
				message: body.reason || "Rolled back",
			})
			await recordSubTxRollbackMetric(app, parentTxId, globalSubTxId, durationMs, filesAffected, bytesRolledBack)

			return reply.send({
				rolled_back: true,
				sub_tx_id: globalSubTxId,
				relative_id: subTxId,
				parent_tx_id: parentTxId,
				duration_ms: durationMs,
				bytes_rolled_back: bytesRolledBack,
				files_affected: filesAffected,
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// ============================================================================
	// Safety Gate Endpoint (R4/R5/R8)
	// Runs the sub-transaction's safety rules in its worktree. Accepts legacy
	// shell `checks`, a declarative `clause`, or BOTH (both must pass). The
	// outcome is recorded and enforced by /merge and /merge-pipeline.
	// ============================================================================
	app.post("/tx/:tx_id/sub-tx/:sub_tx_id/safety-gate", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const { ClauseSchema } = await import("../clause-schema.js")
		const body = z
			.object({
				checks: z.array(z.string().trim().min(1)).optional(),
				clause: ClauseSchema.optional(),
			})
			.refine((d) => (d.checks && d.checks.length > 0) || d.clause, {
				message: "Either checks (non-empty array) or clause is required",
			})
			.parse((req as any).body || {})

		// 404 if the sub-transaction (and therefore its worktree) does not exist —
		// evaluating checks in a missing directory must never yield ok:true.
		const { requireSubTx } = await import("../guards.js")
		const subTx = await requireSubTx(app, (req.params as any).tx_id, (req.params as any).sub_tx_id)
		const globalSubTxId = subTx.global
		const subWt = subTx.worktreePath
		const procKey = `${subTx.parentTxId}_sub_${subTx.rel}`

		interface SafetyCheckResult {
			cmd: string
			exitCode: number
			durationMs: number
			stdoutTail: string
			stderrTail: string
			passed: boolean
		}
		const results: SafetyCheckResult[] = []
		let ok = true
		let failedAt: string | undefined
		let reason: string | undefined
		let error: string | undefined

		// ---- Legacy shell checks (each is action-safety checked first) ----
		const { runCommand } = await import("../exec.js")
		const { checkActionSafety } = await import("../action-safety.js")
		for (const cmd of body.checks ?? []) {
			const start = Date.now()
			const safety = checkActionSafety(
				"execute_command",
				{ command: cmd },
				{ worktreeRoot: subWt, unknownActionPolicy: app.cpConfig.unknownActionPolicy },
			)
			if (!safety.allowed) {
				results.push({
					cmd,
					exitCode: 126,
					durationMs: Date.now() - start,
					stdoutTail: "",
					stderrTail: `ACTION_BLOCKED: ${safety.reason}`,
					passed: false,
				})
				ok = false
				failedAt = cmd
				error = `ACTION_BLOCKED: ${safety.reason}`
				break
			}
			const r = await runCommand(subWt, cmd, { timeoutMs: app.cpConfig.testTimeoutMs, app, txId: procKey })
			const passed = r.exitCode === 0 && !r.spawnError && !r.timedOut
			results.push({
				cmd,
				exitCode: r.exitCode,
				durationMs: r.durationMs,
				stdoutTail: r.stdout.slice(-2048),
				stderrTail: (r.spawnError ? `${r.spawnError}\n` : "") + r.stderr.slice(-2048),
				passed,
			})
			if (!passed) {
				ok = false
				failedAt = cmd
				if (r.spawnError) error = `command could not be started: ${r.spawnError}`
				break // stop on first failure
			}
		}

		// ---- Declarative clause (R8) — evaluated even when checks are given ----
		let clauseLeaves: unknown[] | undefined
		if (ok && body.clause) {
			const { evalClause } = await import("../clause-eval.js")
			const start = Date.now()
			const clauseResult = await evalClause(body.clause, subWt, { app, txId: procKey })
			const clauseLabel = `clause:${body.clause.type}`
			results.push({
				cmd: clauseLabel,
				exitCode: clauseResult.ok ? 0 : 1,
				durationMs: Date.now() - start,
				stdoutTail: "",
				stderrTail: clauseResult.error || clauseResult.reason || "",
				passed: clauseResult.ok,
			})
			clauseLeaves = clauseResult.results ?? []
			if (!clauseResult.ok) {
				ok = false
				failedAt = clauseLabel
				reason = clauseResult.reason
				error = clauseResult.error
			}
		}

		// Record the outcome: in memory (enforced by the merge routes) and in the DB
		app.safetyGates.set(globalSubTxId, { ok, at: Date.now() })
		if (app.db) {
			await insertSafetyCheckResults(
				app.db,
				globalSubTxId,
				results.map((r) => ({
					cmd: r.cmd,
					exit_code: r.exitCode,
					duration_ms: r.durationMs,
					stdout_tail: r.stdoutTail,
					stderr_tail: r.stderrTail,
					passed: r.passed,
				})),
			)
			await insertSafetyGate(app.db, globalSubTxId, ok ? { ok: true } : { ok: false, failed_at: failedAt })
		}

		return reply.send({
			ok,
			results,
			// per-leaf detail of the clause (cmd_exits_0 / test_suite / file_exists)
			...(clauseLeaves ? { clause_results: clauseLeaves } : {}),
			...(failedAt ? { failedAt } : {}),
			...(reason ? { reason } : {}),
			...(error ? { error } : {}),
		})
	})

	// ============================================================================
	// Merge Pipeline Endpoint (R16, R17, R21–R24, R30) — spec-strict
	// See merge-pipeline.ts for the rules. A structurally conflicting later
	// sub-tx is rolled back even when git could merge it.
	// ============================================================================
	app.post("/tx/:tx_id/merge-pipeline", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				sub_tx_ids: z.array(z.string().min(1)).min(1),
				depends_on: z.record(z.array(z.string())).optional(),
				require_safety_gate: z.boolean().optional(),
			})
			.parse((req as any).body || {})
		const { runMergePipeline } = await import("../merge-pipeline.js")
		const result = await runMergePipeline(app, (req.params as any).tx_id, body)
		app.log.info(
			{
				txId: (req.params as any).tx_id,
				merged: result.merged_ids,
				rolled_back: result.rolled_back_ids,
				failed: result.failed_ids,
			},
			"merge-pipeline finished",
		)
		return reply.send(result)
	})

	// ============================================================================
	// Structural Conflict Check Endpoint (R16) — analysis only, no merging
	// ============================================================================
	app.post("/tx/:tx_id/structural-check", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z.object({ sub_tx_ids: z.array(z.string().min(1)).min(1) }).parse((req as any).body || {})
		const parentTxId = (req.params as any).tx_id
		const git = new Git({ repoRoot: app.repoRoot })
		const parentWt = git.worktreePath(parentTxId)
		const { requireSubTx } = await import("../guards.js")
		const { snapshotSubTx, analyzeStructuralConflicts } = await import("../structural-conflict.js")

		const snapshots = []
		for (const id of body.sub_tx_ids) {
			const sub = await requireSubTx(app, parentTxId, id)
			snapshots.push(await snapshotSubTx(git, sub.rel, sub.worktreePath, parentWt))
		}
		const analysis = await analyzeStructuralConflicts(
			git,
			parentWt,
			snapshots,
			app.mergedSnapshots.get(parentTxId) ?? [],
		)
		const sameFileConflicts = analysis.conflicts.filter((c) => c.conflictType === "same-file")
		const dependentFileConflicts = analysis.conflicts.filter((c) => c.conflictType === "dependent-file")
		return reply.send({
			hasConflicts: analysis.conflicts.length > 0,
			sameFileConflicts,
			dependentFileConflicts,
			dismissedByAst: analysis.dismissed,
			touchedFiles: Object.fromEntries(
				snapshots.map((s) => [s.rel, { subTxId: s.rel, files: s.files, linesChanged: s.linesChanged }]),
			),
			snapshots: Object.fromEntries(
				snapshots.map((s) => [s.rel, { base: s.base, head: s.head, added: s.added }]),
			),
		})
	})

	// ============================================================================
	// Action-Safety Endpoint (R6, Slides 39/64)
	// Check if an action is safe BEFORE execution. Blocks unsafe actions.
	// ============================================================================
	app.post("/tx/:tx_id/action-safety", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				action: z.string(), // e.g., "write_file", "bash", "delete"
				args: z.record(z.any()), // Action arguments
				sub_tx_id: z.string().optional(),
			})
			.parse((req as any).body || {})

		const txId = (req.params as any).tx_id

		try {
			const { checkActionSafety, createActionSafetyEvent } = await import("../action-safety.js")
			const { existsSync } = await import("node:fs")
			const git = new Git({ repoRoot: app.repoRoot })

			// Containment is checked against the worktree the action runs in:
			// the sub-tx worktree when it exists, otherwise the parent's.
			let worktreeRoot = git.worktreePath(txId)
			if (body.sub_tx_id) {
				try {
					const { assertSubTxId } = await import("../ids.js")
					const subWt = git.subTxWorktreePath(txId, assertSubTxId(txId, body.sub_tx_id))
					if (existsSync(subWt)) worktreeRoot = subWt
				} catch {
					/* unknown sub-tx id: fall back to the parent worktree */
				}
			}

			// Perform action-safety check
			const check = checkActionSafety(body.action, body.args, {
				worktreeRoot,
				unknownActionPolicy: app.cpConfig.unknownActionPolicy,
				testModifyAllowlist: app.testModifyAllowlist,
			})

			// Create structured log event
			const event = createActionSafetyEvent(check, txId, body.sub_tx_id)

			// Log the decision
			app.log.info({ event }, `Action-safety: ${check.allowed ? "ALLOWED" : "BLOCKED"} ${body.action}`)

			if (!check.allowed) {
				// Block the action with 403 Forbidden
				return reply.code(403).send({
					code: "ACTION_BLOCKED",
					allowed: false,
					action: body.action,
					actionType: check.actionType,
					reason: check.reason,
					rule: check.rule,
					event,
				})
			}

			// Action is allowed
			return reply.send({
				allowed: true,
				action: body.action,
				actionType: check.actionType,
				normalized_paths: check.normalized_paths,
				event,
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// ============================================================================
	// Liveness Check Endpoint (R8, Slide 68)
	// Deterministic check at FINAL commit point only.
	// ============================================================================
	app.post("/tx/:tx_id/liveness", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				test_command: z.string().optional(), // e.g., "pnpm test"
				required_steps: z.array(z.string()).optional(),
				completed_steps: z.array(z.string()).optional(),
				is_final_commit: z.boolean().default(true),
			})
			.parse((req as any).body || {})

		const txId = (req.params as any).tx_id
		const git = new Git({ repoRoot: app.repoRoot })
		const worktreePath = git.worktreePath(txId)

		try {
			const { checkLiveness, createLivenessEvent } = await import("../liveness.js")

			// Perform liveness check
			const check = await checkLiveness(worktreePath, {
				testCommand: body.test_command,
				requiredSteps: body.required_steps,
				completedSteps: body.completed_steps,
			})

			// Create structured log event
			const event = createLivenessEvent(check, txId, body.is_final_commit)

			// Log the decision
			app.log.info(
				{ event },
				`Liveness check: ${check.passed ? "PASSED" : "FAILED"} (final=${body.is_final_commit})`,
			)

			if (!check.passed) {
				return reply.code(403).send({
					code: "LIVENESS_FAILED",
					passed: false,
					testsPass: check.testsPass,
					noPendingSteps: check.noPendingSteps,
					details: check.details,
					event,
				})
			}

			return reply.send({
				passed: true,
				testsPass: check.testsPass,
				noPendingSteps: check.noPendingSteps,
				details: check.details,
				event,
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// ============================================================================
	// Tool Call Logging Endpoint (P3 Replay Support)
	// ============================================================================
	app.post("/tx/:tx_id/tool-call", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				sub_tx_id: z.string().optional(),
				tool_name: z.string(),
				args_json: z.record(z.any()),
				checkpoint_before: z.string().optional(),
				duration_ms: z.number().int().optional(),
				exit_code: z.number().int().optional(),
				result_digest: z.string().optional(),
			})
			.parse((req as any).body || {})

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const { insertToolCall } = await import("../store.js")
			const txId = (req.params as any).tx_id
			const callId = await insertToolCall(app.db, {
				tx_id: txId,
				...body,
				sub_tx_id: await resolveSubTxFk(app, txId, body.sub_tx_id),
			})

			return reply.code(201).send({ call_id: callId })
		} catch (e) {
			return sendError(reply, e)
		}
	})

	app.get("/tx/:tx_id/tool-calls", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const query = z
			.object({
				sub_tx_id: z.string().optional(),
			})
			.parse((req as any).query || {})

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const { getToolCallsForTx, getToolCallsForSubTx } = await import("../store.js")
			const txId = (req.params as any).tx_id
			const { toGlobalSubTxId } = await import("../ids.js")
			const calls = query.sub_tx_id
				? await getToolCallsForSubTx(app.db, toGlobalSubTxId(txId, query.sub_tx_id))
				: await getToolCallsForTx(app.db, txId)

			return reply.send({ tool_calls: calls })
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// ============================================================================
	// Model Call Logging Endpoint (P3 Reproducibility)
	// ============================================================================
	app.post("/tx/:tx_id/model-call", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				sub_tx_id: z.string().optional(),
				model_id: z.string(),
				prompt_hash: z.string(),
				message_count: z.number().int(),
				temperature: z.number().optional(),
				duration_ms: z.number().int().optional(),
			})
			.parse((req as any).body || {})

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const { insertModelCall } = await import("../store.js")
			const txId = (req.params as any).tx_id
			const callId = await insertModelCall(app.db, {
				tx_id: txId,
				...body,
				sub_tx_id: await resolveSubTxFk(app, txId, body.sub_tx_id),
			})

			return reply.code(201).send({ call_id: callId })
		} catch (e) {
			return sendError(reply, e)
		}
	})

	app.get("/tx/:tx_id/model-calls", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const { getModelCallsForTx } = await import("../store.js")
			const calls = await getModelCallsForTx(app.db, (req.params as any).tx_id)

			return reply.send({ model_calls: calls })
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// ============================================================================
	// Replay Endpoint (P3) — honest, file-level replay
	//
	// Re-applies the FILE effects of recorded tool calls on top of a checkpoint.
	// Only calls whose effect is fully determined by their arguments can be
	// replayed (write_to_file / write with full content, apply with a patch,
	// delete_file). Commands and model calls are not replayable deterministically
	// (their output is not recorded), so they are reported as "unsupported" and
	// the replay is refused unless allow_partial is set. Nothing is reset when the
	// replay is refused.
	// ============================================================================
	app.post("/tx/:tx_id/replay", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				from_checkpoint: z.string().min(1),
				tool_calls: z
					.array(z.object({ tool_name: z.string().min(1), args_json: z.record(z.any()) }))
					.optional(),
				// "log": replay the tool_call rows recorded for this tx (optionally one sub-tx)
				source: z.enum(["request", "log"]).default("request"),
				sub_tx_id: z.string().optional(),
				dry_run: z.boolean().default(false),
				allow_partial: z.boolean().default(false),
			})
			.parse((req as any).body || {})

		const startTime = Date.now()
		const txId = (req.params as any).tx_id
		const git = new Git({ repoRoot: app.repoRoot })
		const wt = git.worktreePath(txId)
		const from = await git.verifyCommit(body.from_checkpoint, wt)

		let calls: Array<{ tool_name: string; args_json: Record<string, unknown> }> = body.tool_calls ?? []
		if (body.source === "log") {
			if (!app.db) throw new CPError("NOT_IMPLEMENTED", "source=log requires the database")
			const { getToolCallsForTx, getToolCallsForSubTx } = await import("../store.js")
			const { toGlobalSubTxId } = await import("../ids.js")
			const rows = body.sub_tx_id
				? await getToolCallsForSubTx(app.db, toGlobalSubTxId(txId, body.sub_tx_id))
				: await getToolCallsForTx(app.db, txId)
			// Only calls recorded after the checkpoint we replay from
			const idx = rows.findIndex((r: any) => r.checkpoint_before && from.startsWith(String(r.checkpoint_before)))
			calls = (idx >= 0 ? rows.slice(idx) : rows).map((r: any) => ({
				tool_name: r.tool_name,
				args_json: typeof r.args_json === "string" ? JSON.parse(r.args_json) : r.args_json,
			}))
		}

		type Plan =
			| { kind: "write"; path: string; content: string }
			| { kind: "apply"; path: string; patch: string }
			| { kind: "delete"; path: string }
		const classify = (c: { tool_name: string; args_json: Record<string, unknown> }): Plan | null => {
			const a = c.args_json ?? {}
			const p = (a.path ?? a.file_path) as string | undefined
			switch (c.tool_name) {
				case "write_to_file":
				case "write":
					if (typeof p === "string" && typeof a.content === "string")
						return { kind: "write", path: p, content: a.content }
					if (typeof p === "string" && typeof a.content_base64 === "string")
						return {
							kind: "write",
							path: p,
							content: Buffer.from(a.content_base64, "base64").toString("utf8"),
						}
					return null
				case "apply":
					if (typeof p === "string" && typeof a.patch === "string")
						return { kind: "apply", path: p, patch: a.patch }
					return null
				case "delete_file":
					return typeof p === "string" ? { kind: "delete", path: p } : null
				default:
					return null
			}
		}
		const plans = calls.map((c) => ({ call: c, plan: classify(c) }))
		const unsupported = plans.filter((p) => !p.plan).map((p) => p.call.tool_name)
		const replayable = plans.filter((p) => p.plan)

		if (calls.length > 0 && replayable.length === 0) {
			throw new CPError("REPLAY_UNSUPPORTED", "None of the tool calls can be replayed deterministically", {
				unsupported,
			})
		}
		if (unsupported.length > 0 && !body.allow_partial) {
			throw new CPError(
				"REPLAY_PARTIAL",
				`${unsupported.length} tool call(s) cannot be replayed deterministically; pass allow_partial to replay the rest`,
				{ unsupported },
			)
		}

		const results: Array<{
			tool_name: string
			status: "applied" | "would_apply" | "unsupported" | "failed"
			error?: string
		}> = []
		let backup_ref: string | undefined
		let failed = false
		if (!body.dry_run) {
			backup_ref = (await git.snapshotAndReset(wt, from, `replay tx:${txId}`)).backup_ref
		}
		for (const { call, plan } of plans) {
			if (!plan) {
				results.push({ tool_name: call.tool_name, status: "unsupported" })
				continue
			}
			if (body.dry_run) {
				results.push({ tool_name: call.tool_name, status: "would_apply" })
				continue
			}
			if (failed) {
				results.push({ tool_name: call.tool_name, status: "failed", error: "skipped after an earlier failure" })
				continue
			}
			try {
				if (plan.kind === "write") await git.writeFile(txId, plan.path, Buffer.from(plan.content, "utf8"))
				else if (plan.kind === "apply") await git.applyPatch(txId, plan.path, plan.patch)
				else await git.run(["rm", "-f", "--", plan.path], wt)
				results.push({ tool_name: call.tool_name, status: "applied" })
			} catch (e) {
				failed = true
				results.push({ tool_name: call.tool_name, status: "failed", error: String((e as any)?.message ?? e) })
			}
		}

		let finalCommit = await git.revParse("HEAD", wt)
		const applied = results.filter((r) => r.status === "applied").length
		if (!body.dry_run && applied > 0) {
			finalCommit = (
				await git.checkpoint(
					txId,
					`[cp] replay of ${applied} tool call(s) from ${from.slice(0, 7)} (tx:${txId})`,
				)
			).sha
		}
		const complete = !failed && unsupported.length === 0
		const durationMs = Date.now() - startTime

		if (app.db && !body.dry_run) {
			try {
				await app.db.query(
					`INSERT INTO replay_log (tx_id, from_checkpoint, to_checkpoint, tool_calls_replayed, success, error_message, duration_ms)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[
						txId,
						from,
						finalCommit,
						applied,
						complete,
						complete
							? null
							: results
									.filter((r) => r.status !== "applied")
									.map((r) => `${r.tool_name}:${r.status}`)
									.join(", "),
						durationMs,
					],
				)
			} catch (e) {
				app.log.warn({ err: e }, "Failed to record replay_log row")
			}
		}

		return reply.send({
			replayed_from: from,
			final_commit: finalCommit,
			complete,
			tools_replayed: applied,
			results,
			unsupported,
			backup_ref,
			dry_run: body.dry_run,
			duration_ms: durationMs,
		})
	})

	// ============================================================================
	// Metrics Endpoints (Section 11 Evaluation)
	// ============================================================================

	// Record rollback metric
	app.post("/tx/:tx_id/metric/rollback", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				sub_tx_id: z.string().optional(),
				duration_ms: z.number().int(),
				files_affected: z.number().int().optional(),
				bytes_rolled_back: z.number().int().optional(),
				rollback_type: z.enum(["transaction", "sub_transaction", "checkpoint"]),
			})
			.parse((req as any).body || {})

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const { insertMetricRollback } = await import("../store.js")
			const id = await insertMetricRollback(app.db, {
				tx_id: (req.params as any).tx_id,
				...body,
			})

			return reply.code(201).send({ id })
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// Record execution metric (parallel vs serial timing)
	app.post("/tx/:tx_id/metric/execution", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				execution_mode: z.enum(["parallel", "serial"]),
				sub_tx_count: z.number().int(),
				total_duration_ms: z.number().int(),
				wall_clock_ms: z.number().int(),
			})
			.parse((req as any).body || {})

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const { insertMetricExecution } = await import("../store.js")
			const id = await insertMetricExecution(app.db, {
				tx_id: (req.params as any).tx_id,
				...body,
			})

			return reply.code(201).send({ id })
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// Get aggregated metrics
	app.get("/metrics/rollback", async (req, reply) => {
		const query = z
			.object({
				tx_id: z.string().optional(),
			})
			.parse((req as any).query || {})

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const { getMetricRollbackStats } = await import("../store.js")
			const stats = await getMetricRollbackStats(app.db, query.tx_id)

			return reply.send(stats)
		} catch (e) {
			return sendError(reply, e)
		}
	})

	app.get("/metrics/speedup", async (req, reply) => {
		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const { getParallelSpeedupStats } = await import("../store.js")
			const stats = await getParallelSpeedupStats(app.db)

			return reply.send(stats)
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// Get sub-transaction history for a transaction
	app.get("/tx/:tx_id/history", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const txId = (req.params as any).tx_id
			const { getSubTransactionsForTx, getToolCallsForTx, getModelCallsForTx } = await import("../store.js")

			const [subTransactions, toolCalls, modelCalls] = await Promise.all([
				getSubTransactionsForTx(app.db, txId),
				getToolCallsForTx(app.db, txId),
				getModelCallsForTx(app.db, txId),
			])

			return reply.send({
				tx_id: txId,
				sub_transactions: subTransactions,
				tool_calls: toolCalls,
				model_calls: modelCalls,
				summary: {
					total_sub_transactions: subTransactions.length,
					committed: subTransactions.filter((s) => s.status === "COMMITTED").length,
					aborted: subTransactions.filter((s) => s.status === "ABORTED").length,
					total_tool_calls: toolCalls.length,
					total_model_calls: modelCalls.length,
				},
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// ============================================================================
	// Plan Persistence Endpoints (P1 - Plans must survive restarts)
	// ============================================================================

	// Persist a generated plan
	app.post("/tx/:tx_id/plan", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				title: z.string().optional(),
				summary: z.string().optional(),
				user_prompt: z.string().optional(),
				plan_json: z.record(z.any()),
				sub_tx_count: z.number().int().default(0),
			})
			.parse((req as any).body || {})

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const txId = (req.params as any).tx_id
			const planId = await insertPlan(app.db, {
				tx_id: txId,
				title: body.title,
				summary: body.summary,
				user_prompt: body.user_prompt,
				plan_json: body.plan_json,
				sub_tx_count: body.sub_tx_count,
			})

			return reply.code(201).send({
				plan_id: planId,
				tx_id: txId,
				message: "Plan persisted successfully",
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// Get plan for a transaction
	app.get("/tx/:tx_id/plan", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const txId = (req.params as any).tx_id
			const plan = await getPlan(app.db, txId)

			if (!plan) {
				return reply.code(404).send({ error: "No plan found for this transaction" })
			}

			return reply.send({
				plan_id: plan.plan_id,
				tx_id: plan.tx_id,
				title: plan.title,
				summary: plan.summary,
				user_prompt: plan.user_prompt,
				plan_json: plan.plan_json,
				sub_tx_count: plan.sub_tx_count,
				created_at: plan.created_at,
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// List all plans (for research/auditing)
	app.get("/plans", async (req, reply) => {
		const query = z
			.object({
				limit: z.coerce.number().int().min(1).max(100).default(50),
			})
			.parse((req as any).query || {})

		try {
			if (!app.db) {
				return reply.code(503).send({ error: "Database not available" })
			}

			const plans = await listPlans(app.db, query.limit)

			return reply.send({
				plans: plans.map((p) => ({
					plan_id: p.plan_id,
					tx_id: p.tx_id,
					title: p.title,
					summary: p.summary,
					sub_tx_count: p.sub_tx_count,
					created_at: p.created_at,
				})),
				total: plans.length,
			})
		} catch (e) {
			return sendError(reply, e)
		}
	})

	// -----------------------------------------------------------------------
	// R30: New-file reservation (scoped to a PARENT transaction, so sibling
	// sub-transactions cannot both create the same new file). Enforced again
	// at merge time by /merge-pipeline (R30_FILE_RESERVED).
	// -----------------------------------------------------------------------
	app.post("/tx/:tx_id/reserve-file", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				file_path: z.string().min(1),
				claimer_id: z.string().min(1),
			})
			.parse((req as any).body || {})

		const txId = (req.params as any).tx_id
		const { normalizeTargetPath } = await import("../action-safety.js")
		const { normalizeReservedPath } = await import("../merge-pipeline.js")
		const { toRelativeSubTxId } = await import("../ids.js")
		const git = new Git({ repoRoot: app.repoRoot })
		const wt = git.worktreePath(txId)

		const v = normalizeTargetPath(body.file_path, wt)
		if (!v.ok) {
			throw new CPError("VALIDATION_ERROR", `file_path ${v.reason}`, { file_path: body.file_path })
		}
		const key = normalizeReservedPath(v.rel)
		const claimer = toRelativeSubTxId(txId, body.claimer_id)

		// R30 is about NEW files: a path that already exists in the parent cannot be reserved
		const { existsSync } = await import("node:fs")
		const { join } = await import("node:path")
		if (existsSync(join(wt, v.rel))) {
			return reply.code(409).send({
				code: "FILE_EXISTS",
				message: `${v.rel} already exists in the transaction; reservation is only for new files`,
				file_path: v.rel,
			})
		}

		let txReservations = app.fileReservations.get(txId)
		if (!txReservations) {
			txReservations = new Map<string, string>()
			app.fileReservations.set(txId, txReservations)
		}
		const existingClaimer = txReservations.get(key)
		if (existingClaimer && existingClaimer !== claimer) {
			return reply.code(409).send({
				code: "FILE_ALREADY_RESERVED",
				message: `${v.rel} is already reserved by ${existingClaimer}`,
				file_path: v.rel,
				by: existingClaimer,
			})
		}

		// First reservation or idempotent re-reservation by same claimer
		txReservations.set(key, claimer)
		return reply.send({ reserved: true, file_path: v.rel, by: claimer })
	})
}
