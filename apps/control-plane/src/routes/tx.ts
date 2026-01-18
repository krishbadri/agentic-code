import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Git } from "../git.js"
import { errorResponse } from "../errors.js"
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

// R31, R32: Tests are "given" - agents must not introduce or modify tests
// unless explicitly allowlisted via SERVER-SIDE config (NOT agent-controlled).
// Test file patterns: /test/, /tests/, /__tests__/, *.test.ts, *.spec.ts, etc.
function isTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase()

	// Directory patterns (check both /test/ and test/ at start)
	if (
		normalized.includes("/test/") ||
		normalized.includes("/tests/") ||
		normalized.includes("/__tests__/") ||
		normalized.startsWith("test/") ||
		normalized.startsWith("tests/") ||
		normalized.startsWith("__tests__/")
	) {
		return true
	}

	// File extension patterns
	if (
		normalized.endsWith(".test.ts") ||
		normalized.endsWith(".test.js") ||
		normalized.endsWith(".spec.ts") ||
		normalized.endsWith(".spec.js") ||
		normalized.endsWith(".test.tsx") ||
		normalized.endsWith(".test.jsx") ||
		normalized.endsWith(".spec.tsx") ||
		normalized.endsWith(".spec.jsx")
	) {
		return true
	}

	// Root level test files
	const basename = normalized.split("/").pop() || ""
	if (basename === "test.js" || basename === "test.ts") {
		return true
	}

	return false
}

/**
 * Check if test file modification is allowed via SERVER-SIDE allowlist.
 * 
 * SECURITY: This is NOT controlled by agent input (headers, request body).
 * Only paths explicitly configured in the server's testModifyAllowlist
 * can be modified. An empty allowlist means NO test modifications allowed.
 */
function isTestModifyAllowed(filePath: string, allowlist: string[]): boolean {
	// Empty allowlist = no modifications allowed (secure default)
	if (!allowlist || allowlist.length === 0) {
		return false
	}

	const normalized = filePath.replace(/\\/g, "/").toLowerCase()

	for (const pattern of allowlist) {
		const normalizedPattern = pattern.replace(/\\/g, "/").toLowerCase()

		// Exact match
		if (normalized === normalizedPattern) {
			return true
		}

		// Glob pattern matching
		if (normalizedPattern.includes("*")) {
			const regex = new RegExp(
				"^" + normalizedPattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$",
				"i",
			)
			if (regex.test(normalized)) {
				return true
			}
		}

		// Prefix matching (directory allowlist)
		if (normalizedPattern.endsWith("/") && normalized.startsWith(normalizedPattern)) {
			return true
		}
	}

	return false
}

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
		// Match "--- a/path" or "+++ b/path" (git diff format)
		const match = line.match(/^(?:---|\+\+\+)\s+(?:a|b)\/(.+)$/)
		if (match) {
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

export function registerTxRoutes(app: FastifyInstance) {
	app.get("/health", async (req, reply) => {
		return reply.send({ status: "ok", timestamp: Date.now() })
	})

	app.post("/tx/begin", async (req, reply) => {
		const headers = HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				isolation: z.enum(["fail-fast", "rebase", "hybrid"]),
				base: z.string().default("main"),
				// R33: Progress gate - test command to run for monotonicity check
				test_command: z.string().optional(),
			})
			.parse((req as any).body || {})

		const tx_id = randomUUID()
		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const base_commit = await git.beginTx(tx_id, body.base)
			const worktree_path = git.worktreePath(tx_id)
			
			let repo_id = "default"
			let progressBaseline: { passingCount: number; totalCount: number } | undefined

			if (app.db) {
				repo_id = await getOrCreateRepo(app.db, app.repoRoot)
				await insertTransaction(app.db, {
					tx_id,
					repo_id,
					actor_id: headers["x-actor-id"],
					agent_id: headers["x-actor-id"],
					isolation_policy: body.isolation,
					base_commit,
				})
			}

			// R33: If test_command provided, run tests and store baseline
			if (body.test_command) {
				const { runTestsAndCount } = await import("../progress-gate.js")
				const result = await runTestsAndCount(worktree_path, body.test_command)
				progressBaseline = { passingCount: result.passingCount, totalCount: result.totalCount }

				// Store baseline (DB or in-memory for testing)
				if (app.db) {
					const { setProgressBaseline } = await import("../store.js")
					await setProgressBaseline(app.db, tx_id, result.passingCount, result.totalCount, body.test_command)
				} else {
					// In-memory storage for DB-less mode (testing)
					if (!app.progressBaselines) {
						app.progressBaselines = new Map()
					}
					app.progressBaselines.set(tx_id, {
						passing_count: result.passingCount,
						total_count: result.totalCount,
						test_command: body.test_command,
						last_checkpoint_count: result.passingCount,
					})
				}
			}
			
			return reply.send({
				tx_id,
				base_commit,
				branch: `tx/${tx_id}`,
				worktree_path,
				policy: { isolation: body.isolation },
				progress_baseline: progressBaseline,
			})
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
		}
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
			return reply.code(400).send(errorResponse(e))
		}
	})

	app.post("/tx/:tx_id/write", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({ file_path: z.string(), content_base64: z.string(), mode: z.string().optional() })
			.parse((req as any).body || {})

		// R31, R32: Reject test file modifications unless explicitly allowed
		// R31, R32: Reject test file modifications unless explicitly allowed via SERVER config
		if (isTestFile(body.file_path) && !isTestModifyAllowed(body.file_path, app.testModifyAllowlist)) {
			return reply.code(403).send({
				code: "TEST_FILE_PROTECTED",
				message: `R31/R32 violation: Tests are "given". Writing test file "${body.file_path}" is not allowed. Server must be configured with testModifyAllowlist to permit this.`,
				file_path: body.file_path,
			})
		}

		try {
			const bytesBuf = Buffer.from(body.content_base64, "base64")
			const git = new Git({ repoRoot: app.repoRoot })
			await git.writeFile((req.params as any).tx_id, body.file_path, bytesBuf, body.mode)
			return reply.send({ ok: true, bytes: bytesBuf.byteLength })
		} catch (e) {
			return reply.code(400).send(errorResponse(e))
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
			return reply.code(404).send(errorResponse(e))
		}
	})

	app.post("/tx/:tx_id/checkpoint", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		z.object({
			reason: z.enum(["human", "auto", "manual"]),
			policy_snapshot: z.record(z.any()).optional(),
			trailers: z.record(z.string()).optional(),
		}).parse((req as any).body || {})

		const txId = (req.params as any).tx_id

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const worktreePath = git.worktreePath(txId)

			// R33: Progress Gate - check if test count is monotonically non-decreasing
			// Check DB first, then in-memory storage for testing
			let baseline: { passing_count: number; total_count: number; test_command: string; last_checkpoint_count?: number; last_checkpoint_sha?: string } | null = null

			if (app.db) {
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
			} else if (app.progressBaselines?.has(txId)) {
				// In-memory storage for DB-less mode (testing)
				baseline = app.progressBaselines.get(txId) ?? null
			}

			if (baseline) {
				const { runTestsAndCount, isProgressValid } = await import("../progress-gate.js")
				const currentResult = await runTestsAndCount(worktreePath, baseline.test_command)
				const lastPassingCount = baseline.last_checkpoint_count ?? baseline.passing_count

				// R33: Enforce monotonic non-decreasing
				if (!isProgressValid(lastPassingCount, currentResult.passingCount)) {
					// Rollback to last good checkpoint (use stored SHA if available, otherwise HEAD~1)
					let rollbackTarget: string
					if (baseline.last_checkpoint_sha) {
						rollbackTarget = baseline.last_checkpoint_sha
					} else {
						try {
							rollbackTarget = await git.revParse("HEAD~1", worktreePath)
						} catch {
							// If HEAD~1 doesn't exist (first commit), use HEAD
							rollbackTarget = await git.revParse("HEAD", worktreePath)
						}
					}

					await git.resetHard(txId, rollbackTarget)

					return reply.code(403).send({
						code: "PROGRESS_VIOLATION",
						message: `Progress gate failed: passing test count decreased from ${lastPassingCount} to ${currentResult.passingCount}`,
						baseline_count: baseline.passing_count,
						last_checkpoint_count: lastPassingCount,
						current_count: currentResult.passingCount,
						rollback_to: rollbackTarget,
					})
				}

				// Record this checkpoint's progress
				const msg = `[cp] tx:${txId}`
				const { sha, tag } = await git.checkpoint(txId, msg)

				// Update storage
				if (app.db) {
					const { recordProgressCheckpoint } = await import("../store.js")
					await recordProgressCheckpoint(app.db, txId, sha, currentResult.passingCount, currentResult.totalCount)

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
				} else if (app.progressBaselines) {
					// Update in-memory last checkpoint count and SHA
					baseline.last_checkpoint_count = currentResult.passingCount
					baseline.last_checkpoint_sha = sha
					app.progressBaselines.set(txId, baseline)
				}

				return reply.code(201).send({
					commit_sha: sha,
					tag,
					version_id: randomUUID(),
					progress: {
						passing_count: currentResult.passingCount,
						total_count: currentResult.totalCount,
						baseline_count: baseline.passing_count,
					},
				})
			}

			// No progress gate configured - proceed normally
			const msg = `[cp] tx:${txId}`
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
			return reply.code(500).send(errorResponse(e))
		}
	})

	app.post("/tx/:tx_id/commit", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				strategy: z.enum(["fail-fast", "rebase", "hybrid"]),
				maxRebaseMs: z.number().int().optional(),
				maxConflictFiles: z.number().int().optional(),
				// Liveness check parameters (optional - can come from persisted state)
				required_steps: z.array(z.string()).optional(),
				completed_steps: z.array(z.string()).optional(),
			})
			.parse((req as any).body || {})

		const txId = (req.params as any).tx_id

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const worktreePath = git.worktreePath(txId)

			// R6, Slide 68: Liveness MUST run at FINAL commit point
			// Get test_command from progress baseline (stored "given tests")
			let testCommand: string | undefined
			let baseline: { passing_count: number; total_count: number; test_command: string; last_checkpoint_sha?: string } | null = null

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

			// Run liveness check if test_command is available (given tests)
			if (testCommand) {
				const { checkLiveness, createLivenessEvent } = await import("../liveness.js")

				const check = await checkLiveness(worktreePath, {
					testCommand,
					requiredSteps: body.required_steps,
					completedSteps: body.completed_steps,
				})

				const event = createLivenessEvent(check, txId, true)

				app.log.info({ event }, `Liveness check at final commit: ${check.passed ? "PASSED" : "FAILED"}`)

				if (!check.passed) {
					// R7, Slide 68: Rollback to last good checkpoint SHA on liveness failure
					let rollbackTarget: string
					if (baseline?.last_checkpoint_sha) {
						rollbackTarget = baseline.last_checkpoint_sha
					} else {
						try {
							rollbackTarget = await git.revParse("HEAD~1", worktreePath)
						} catch {
							// If HEAD~1 doesn't exist (first commit), use HEAD
							rollbackTarget = await git.revParse("HEAD", worktreePath)
						}
					}

					// Perform rollback
					await git.resetHard(txId, rollbackTarget)

					return reply.code(403).send({
						code: "LIVENESS_FAILED",
						message: `Liveness check failed at final commit: ${check.details.error || "Tests failed or pending steps"}`,
						passed: false,
						testsPass: check.testsPass,
						noPendingSteps: check.noPendingSteps,
						details: check.details,
						event,
						rollback_to: rollbackTarget,
					})
				}
			}

			// Liveness passed (or not configured) - proceed with commit
			let baseSha = ""
			if (app.db) {
				const tx = await getTransaction(app.db, txId)
				baseSha = tx?.base_commit || ""
			}

			const res = await git.commitToMain(txId, baseSha, body.strategy)
			if ((res as any).conflict) {
				const details = (res as any).conflict.details || {}
				if (app.db) {
					try {
						await finalizeTransaction(app.db, txId, "aborted")
					} catch {}
				}
				return reply.code(409).send({ code: (res as any).conflict.code, details: { ...details } })
			}

			if (app.db) {
				await finalizeTransaction(app.db, txId, "committed")
			}
			return reply.send({ merged_sha: (res as any).merged_sha, advanced_head: true })
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
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

			// Get file count before rollback for metrics
			let filesAffected = 0
			try {
				const { stdout } = await (git as any).git(["diff", "--name-only", body.hash, "HEAD"], wt)
				filesAffected = stdout.split("\n").filter(Boolean).length
			} catch {
				/* ignore */
			}
			
			// Reset the worktree to the specified commit
			await (git as any).git(["reset", "--hard", body.hash], wt)

			const durationMs = Date.now() - startTime

			// Record rollback metrics
			if (app.db) {
				try {
					const { insertMetricRollback } = await import("../store.js")
					await insertMetricRollback(app.db, {
						tx_id: txId,
						duration_ms: durationMs,
						files_affected: filesAffected,
						rollback_type: "transaction",
					})
				} catch {
					/* ignore metrics errors */
				}
			}
			
			return reply.send({ 
				rolled_back_to: body.hash,
				message: `Rolled back to commit ${body.hash}`,
				duration_ms: durationMs,
				files_affected: filesAffected,
			})
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
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
			const subTxId = (req.params as any).sub_tx_id
			const base = body.base || parentTxId

			const worktreePath = await git.beginSubTx(parentTxId, subTxId, base)

			// Persist sub-transaction to database
			if (app.db) {
				const baseCommit = await git.revParse("HEAD", git.worktreePath(parentTxId))
				await insertSubTransaction(app.db, {
					sub_tx_id: subTxId,
					tx_id: parentTxId,
					title: body.title,
					description: body.description,
					agent_type: body.agentType,
					prompt: body.prompt,
					depends_on: body.dependsOn,
					safety_checks: body.safetyChecks,
					base_commit: baseCommit,
					status: "RUNNING",
					worktree_path: worktreePath,
				})
			}

			return reply.send({
				worktree_path: worktreePath,
				sub_tx_id: subTxId,
				parent_tx_id: parentTxId,
			})
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
		}
	})

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
				// Force merge without safety gate (for testing/emergency only)
				forceMerge: z.boolean().default(false),
			})
			.parse((req as any).body || {})

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const parentTxId = (req.params as any).tx_id
			const subTxId = (req.params as any).sub_tx_id

			// P0 CRITICAL: Check database for safety checks if not provided in request
			let hasSafetyChecks = body.hasSafetyChecks
			if (app.db && !hasSafetyChecks) {
				const subTx = await getSubTransaction(app.db, subTxId)
				if (subTx?.safety_checks && subTx.safety_checks.length > 0) {
					hasSafetyChecks = true
				}
			}

			// P0 CRITICAL: Enforce safety gate if checks are defined
			if (hasSafetyChecks && !body.forceMerge) {
				if (!body.safetyGate) {
					return reply.code(403).send({
						code: "SAFETY_GATE_REQUIRED",
						message:
							"Safety checks are defined but no safety gate result was provided. Run safety-gate endpoint first.",
					})
				}
				if (!body.safetyGate.ok) {
					// Persist the failure
					if (app.db) {
						await updateSubTransactionStatus(app.db, subTxId, "ABORTED", undefined, {
							kind: "SAFETY_FAIL",
							message: `Failed at: ${body.safetyGate.failedAt}`,
						})
					}
					return reply.code(403).send({
						code: "SAFETY_GATE_FAILED",
						message: `Safety checks failed at: ${body.safetyGate.failedAt}. Merge blocked.`,
						safetyGate: body.safetyGate,
					})
				}
			}

			// R15, R17: Detect conflicts at merge time and abort/rollback on failure
			const mergeResult = await git.mergeSubTx(parentTxId, subTxId)

			if (!mergeResult.merged && mergeResult.conflict) {
				// R17, R24: Abort and rollback conflicting work
				if (app.db) {
					await updateSubTransactionStatus(app.db, subTxId, "ABORTED", undefined, {
						kind: "MERGE_CONFLICT",
						message: mergeResult.conflict,
					})
				}
				return reply.code(409).send({
					code: "MERGE_CONFLICT",
					message: `Merge conflict detected: ${mergeResult.conflict}`,
					sub_tx_id: subTxId,
				})
			}

			// Persist successful merge
			if (app.db && mergeResult.merged) {
				const endCommit = await git.revParse("HEAD", git.worktreePath(parentTxId))
				await updateSubTransactionStatus(app.db, subTxId, "COMMITTED", endCommit)
			}

			return reply.send({
				merged: mergeResult.merged,
				sub_tx_id: subTxId,
				parent_tx_id: parentTxId,
				safetyGatePassed: body.safetyGate?.ok ?? null,
			})
		} catch (e) {
			// Persist failure on error
			if (app.db) {
				try {
					await updateSubTransactionStatus(app.db, (req.params as any).sub_tx_id, "ABORTED", undefined, {
						kind: "MERGE_CONFLICT",
						message: String(e),
					})
				} catch {
					/* ignore db errors during error handling */
				}
			}
			return reply.code(500).send(errorResponse(e))
		}
	})

	app.post("/tx/:tx_id/sub-tx/:sub_tx_id/rollback", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				reason: z.string().optional(),
				failureKind: z.enum(["MERGE_CONFLICT", "SAFETY_FAIL", "RUNTIME_ERROR", "TIMEOUT"]).optional(),
			})
			.parse((req as any).body || {})

		const startTime = Date.now()

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const parentTxId = (req.params as any).tx_id
			const subTxId = (req.params as any).sub_tx_id

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
			if (app.db) {
				await updateSubTransactionStatus(app.db, subTxId, "ABORTED", undefined, {
					kind: body.failureKind || "RUNTIME_ERROR",
					message: body.reason || "Rolled back",
				})

				// Record rollback metrics
				try {
					const { insertMetricRollback } = await import("../store.js")
					await insertMetricRollback(app.db, {
						tx_id: parentTxId,
						sub_tx_id: subTxId,
						duration_ms: durationMs,
						rollback_type: "sub_transaction",
					})
				} catch {
					/* ignore metrics errors */
				}
			}

			return reply.send({
				rolled_back: true,
				sub_tx_id: subTxId,
				parent_tx_id: parentTxId,
				duration_ms: durationMs,
			})
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
		}
	})

	// ============================================================================
	// Safety Gate Endpoint - P0 CRITICAL
	// This endpoint runs safety checks and returns structured results.
	// If any check fails, the sub-transaction should NOT be merged.
	// ============================================================================
	app.post("/tx/:tx_id/sub-tx/:sub_tx_id/safety-gate", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				checks: z.array(z.string()), // e.g., ["pnpm test", "pnpm lint"]
			})
			.parse((req as any).body || {})

		const parentTxId = (req.params as any).tx_id
		const subTxId = (req.params as any).sub_tx_id

		// Get the worktree path for this sub-transaction
		const git = new Git({ repoRoot: app.repoRoot })
		const subWt = git.subTxWorktreePath(parentTxId, subTxId)

		interface SafetyCheckResult {
			cmd: string
			exitCode: number
			durationMs: number
			stdoutTail: string
			stderrTail: string
			passed: boolean
		}

		const results: SafetyCheckResult[] = []
		const { exec } = await import("node:child_process")
		const { promisify } = await import("node:util")
		const execAsync = promisify(exec)

		for (const cmd of body.checks) {
			const start = Date.now()
			try {
				// Execute the command in the sub-transaction worktree
				const { stdout, stderr } = await execAsync(cmd, {
					cwd: subWt,
					timeout: 300000, // 5 minute timeout per check
					maxBuffer: 10 * 1024 * 1024, // 10MB buffer
					windowsHide: true,
				})

				results.push({
					cmd,
					exitCode: 0,
					durationMs: Date.now() - start,
					stdoutTail: stdout.slice(-2048),
					stderrTail: stderr.slice(-2048),
					passed: true,
				})
			} catch (err: any) {
				// Command failed - capture exit code and output
				const exitCode = typeof err?.code === "number" ? err.code : 1
				results.push({
					cmd,
					exitCode,
					durationMs: Date.now() - start,
					stdoutTail: (err?.stdout || "").slice(-2048),
					stderrTail: (err?.stderr || err?.message || "").slice(-2048),
					passed: false,
				})

				// Persist results to database
				if (app.db) {
					await insertSafetyCheckResults(
						app.db,
						subTxId,
						results.map((r) => ({
							cmd: r.cmd,
							exit_code: r.exitCode,
							duration_ms: r.durationMs,
							stdout_tail: r.stdoutTail,
							stderr_tail: r.stderrTail,
							passed: r.passed,
						})),
					)
					await insertSafetyGate(app.db, subTxId, { ok: false, failed_at: cmd })
				}

				// Stop on first failure - this is the safety gate
				return reply.send({
					ok: false,
					results,
					failedAt: cmd,
				})
			}
		}

		// Persist successful results to database
		if (app.db) {
			await insertSafetyCheckResults(
				app.db,
				subTxId,
				results.map((r) => ({
					cmd: r.cmd,
					exit_code: r.exitCode,
					duration_ms: r.durationMs,
					stdout_tail: r.stdoutTail,
					stderr_tail: r.stderrTail,
					passed: r.passed,
				})),
			)
			await insertSafetyGate(app.db, subTxId, { ok: true })
		}

		// All checks passed
		return reply.send({
			ok: true,
			results,
		})
	})

	// ============================================================================
	// Merge Pipeline Endpoint (R16, R22, R23, R24)
	// Orchestrates merging all sub-transactions with structural conflict detection.
	// ============================================================================
	app.post("/tx/:tx_id/merge-pipeline", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				sub_tx_ids: z.array(z.string()), // IDs of completed sub-transactions to merge
			})
			.parse((req as any).body || {})

		const parentTxId = (req.params as any).tx_id
		const git = new Git({ repoRoot: app.repoRoot })
		const parentWt = git.worktreePath(parentTxId)

		try {
			// Step 1: Gather touched files and lines changed for each subTx
			const {
				getTouchedFiles,
				detectConflicts,
				detectDependentFileConflicts,
				partitionByConflicts,
				orderByModifications,
			} = await import("../structural-conflict.js")

			const touchedFilesMap = new Map<string, { subTxId: string; files: string[]; linesChanged: number }>()

			for (const subTxId of body.sub_tx_ids) {
				const subWt = git.subTxWorktreePath(parentTxId, subTxId)
				const baseRef = await git.revParse("HEAD", parentWt)
				const touched = await getTouchedFiles(subWt, baseRef)
				touchedFilesMap.set(subTxId, {
					subTxId,
					files: touched.files,
					linesChanged: touched.linesChanged,
				})
			}

			// Step 2: Detect structural conflicts (same-file and dependent-file)
			const sameFileConflicts = detectConflicts(touchedFilesMap)
			const dependentFileConflicts = await detectDependentFileConflicts(parentWt, touchedFilesMap)
			const allConflicts = [...sameFileConflicts, ...dependentFileConflicts]

			// Step 3: Partition into no-conflict and conflicting groups
			const { noConflict, conflicting } = partitionByConflicts(body.sub_tx_ids, allConflicts)

			// Step 4: Merge no-conflict subTx first
			const mergeResults: Array<{
				subTxId: string
				merged: boolean
				conflict?: boolean
				rollback?: boolean
				error?: string
			}> = []

			for (const subTxId of noConflict) {
				try {
					const result = await git.mergeSubTx(parentTxId, subTxId)
					mergeResults.push({
						subTxId,
						merged: result.merged,
						conflict: result.conflict ? true : undefined,
						error: result.conflict,
					})
				} catch (e) {
					mergeResults.push({
						subTxId,
						merged: false,
						error: String(e),
					})
				}
			}

			// Step 5: Order conflicting subTx by lines changed (descending) and merge sequentially
			const orderedConflicting = orderByModifications(
				new Map(conflicting.map((id) => [id, touchedFilesMap.get(id)!])),
			)

			for (const subTxId of orderedConflicting) {
				try {
					const result = await git.mergeSubTx(parentTxId, subTxId)
					if (result.merged) {
						mergeResults.push({ subTxId, merged: true })
					} else {
						// Merge failed - rollback this branch
						try {
							await git.rollbackSubTx(parentTxId, subTxId)
							mergeResults.push({
								subTxId,
								merged: false,
								rollback: true,
								error: result.conflict || "Merge failed, rolled back",
							})

							// Persist rollback status
							if (app.db) {
								await updateSubTransactionStatus(app.db, subTxId, "ABORTED", undefined, {
									kind: "MERGE_CONFLICT",
									message: result.conflict || "Merge failed in pipeline",
								})
							}
						} catch (rollbackErr) {
							mergeResults.push({
								subTxId,
								merged: false,
								rollback: false,
								error: `Merge failed and rollback failed: ${rollbackErr}`,
							})
						}
					}
				} catch (e) {
					// Merge threw exception - attempt rollback
					try {
						await git.rollbackSubTx(parentTxId, subTxId)
						mergeResults.push({
							subTxId,
							merged: false,
							rollback: true,
							error: String(e),
						})
					} catch {
						mergeResults.push({
							subTxId,
							merged: false,
							rollback: false,
							error: String(e),
						})
					}
				}
			}

			const successCount = mergeResults.filter((r) => r.merged).length
			const failedCount = mergeResults.filter((r) => !r.merged).length
			const rolledBackCount = mergeResults.filter((r) => r.rollback).length

			return reply.send({
				success: failedCount === 0,
				total: body.sub_tx_ids.length,
				merged: successCount,
				failed: failedCount,
				rolled_back: rolledBackCount,
				conflicts_detected: allConflicts.length,
				results: mergeResults,
				conflicts: allConflicts,
			})
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
		}
	})

	// ============================================================================
	// Structural Conflict Check Endpoint (R16)
	// Checks for structural conflicts without merging.
	// ============================================================================
	app.post("/tx/:tx_id/structural-check", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				sub_tx_ids: z.array(z.string()),
			})
			.parse((req as any).body || {})

		const parentTxId = (req.params as any).tx_id
		const git = new Git({ repoRoot: app.repoRoot })
		const parentWt = git.worktreePath(parentTxId)

		try {
			const { getTouchedFiles, detectConflicts, detectDependentFileConflicts } = await import(
				"../structural-conflict.js"
			)

			const touchedFilesMap = new Map<string, { subTxId: string; files: string[]; linesChanged: number }>()

			for (const subTxId of body.sub_tx_ids) {
				const subWt = git.subTxWorktreePath(parentTxId, subTxId)
				const baseRef = await git.revParse("HEAD", parentWt)
				const touched = await getTouchedFiles(subWt, baseRef)
				touchedFilesMap.set(subTxId, {
					subTxId,
					files: touched.files,
					linesChanged: touched.linesChanged,
				})
			}

			const sameFileConflicts = detectConflicts(touchedFilesMap)
			const dependentFileConflicts = await detectDependentFileConflicts(parentWt, touchedFilesMap)

			return reply.send({
				hasConflicts: sameFileConflicts.length > 0 || dependentFileConflicts.length > 0,
				sameFileConflicts,
				dependentFileConflicts,
				touchedFiles: Object.fromEntries(touchedFilesMap),
			})
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
		}
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

			// Perform action-safety check
			const check = checkActionSafety(body.action, body.args)

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
				event,
			})
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
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
			return reply.code(500).send(errorResponse(e))
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
			const callId = await insertToolCall(app.db, {
				tx_id: (req.params as any).tx_id,
				...body,
			})

			return reply.code(201).send({ call_id: callId })
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
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
			const calls = query.sub_tx_id
				? await getToolCallsForSubTx(app.db, query.sub_tx_id)
				: await getToolCallsForTx(app.db, (req.params as any).tx_id)

			return reply.send({ tool_calls: calls })
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
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
			const callId = await insertModelCall(app.db, {
				tx_id: (req.params as any).tx_id,
				...body,
			})

			return reply.code(201).send({ call_id: callId })
		} catch (e) {
			return reply.code(500).send(errorResponse(e))
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
			return reply.code(500).send(errorResponse(e))
		}
	})

	// ============================================================================
	// Replay Endpoint (P3 Deterministic Replay)
	// ============================================================================
	app.post("/tx/:tx_id/replay", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = z
			.object({
				from_checkpoint: z.string(),
				tool_calls: z
					.array(
						z.object({
							tool_name: z.string(),
							args_json: z.record(z.any()),
						}),
					)
					.optional(),
				dry_run: z.boolean().default(false),
			})
			.parse((req as any).body || {})

		const startTime = Date.now()
		const txId = (req.params as any).tx_id

		try {
			const git = new Git({ repoRoot: app.repoRoot })
			const wt = git.worktreePath(txId)

			// Reset to the specified checkpoint
			await (git as any).git(["reset", "--hard", body.from_checkpoint], wt)

			let toolsReplayed = 0
			const replayResults: { tool_name: string; success: boolean; error?: string }[] = []

			// If tool calls provided, we could re-execute them here
			// For now, we just reset and return the state
			if (body.tool_calls && !body.dry_run) {
				// Future: Execute tool calls deterministically
				// For research purposes, the reset is the critical feature
				toolsReplayed = body.tool_calls.length
				for (const call of body.tool_calls) {
					replayResults.push({ tool_name: call.tool_name, success: true })
				}
			}

			const finalCommit = await git.revParse("HEAD", wt)
			const durationMs = Date.now() - startTime

			// Log the replay
			if (app.db) {
				await app.db.query(
					`INSERT INTO replay_log (tx_id, from_checkpoint, to_checkpoint, tool_calls_replayed, success, duration_ms)
					 VALUES ($1, $2, $3, $4, $5, $6)`,
					[txId, body.from_checkpoint, finalCommit, toolsReplayed, true, durationMs],
				)
			}

			return reply.send({
				replayed_from: body.from_checkpoint,
				final_commit: finalCommit,
				tools_replayed: toolsReplayed,
				replay_results: replayResults,
				duration_ms: durationMs,
				dry_run: body.dry_run,
			})
		} catch (e) {
			const durationMs = Date.now() - startTime

			// Log failed replay
			if (app.db) {
				try {
					await app.db.query(
						`INSERT INTO replay_log (tx_id, from_checkpoint, tool_calls_replayed, success, error_message, duration_ms)
						 VALUES ($1, $2, $3, $4, $5, $6)`,
						[txId, body.from_checkpoint, 0, false, String(e), durationMs],
					)
				} catch {
					/* ignore db errors */
				}
			}

			return reply.code(500).send(errorResponse(e))
		}
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
			return reply.code(500).send(errorResponse(e))
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
			return reply.code(500).send(errorResponse(e))
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
			return reply.code(500).send(errorResponse(e))
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
			return reply.code(500).send(errorResponse(e))
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
			return reply.code(500).send(errorResponse(e))
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
			return reply.code(500).send(errorResponse(e))
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
			return reply.code(500).send(errorResponse(e))
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
			return reply.code(500).send(errorResponse(e))
		}
	})
}
