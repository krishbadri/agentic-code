import Fastify from "fastify"
import fastifyCors from "@fastify/cors"
import fastifyFormbody from "@fastify/formbody"
import fastifyCompress from "@fastify/compress"
import fastifySwagger from "@fastify/swagger"
import fastifySwaggerUI from "@fastify/swagger-ui"
import { registerTxRoutes } from "./routes/tx.js"
import { registerGitRoutes } from "./routes/git.js"
import { registerVersionRoutes } from "./routes/versions.js"
import { registerShellRoutes } from "./routes/shell.js"
import { createPool, migrate } from "./db.js"
import { Git } from "./git.js"
import * as errorsModule from "./errors.js"
import type { ChildProcess } from "node:child_process"
// registerMcp will be imported dynamically to avoid loading MCP SDK when disabled

export type ServerConfig = {
	repoRoot: string
	port: number
	databaseUrl?: string
	disableDb?: boolean
	disableMcp?: boolean
	// R31, R32: Server-side allowlist for test file modifications
	// Only paths explicitly listed here can be modified by agents.
	// This is a SERVER-SIDE config, NOT controllable by agent requests.
	testModifyAllowlist?: string[]
	// R33/R6: default test command used for progress + liveness gates when the
	// caller of /tx/begin does not provide one.
	testCommand?: string
	// R8: named test suites usable from `test_suite` clauses.
	testSuites?: Record<string, string>
	// Timeout for test / clause commands (ms).
	testTimeoutMs?: number
	// R9: policy for actions the action-safety checker does not recognise.
	unknownActionPolicy?: "deny" | "allow"
}

export type ProgressBaselineState = {
	passing_count: number
	total_count: number
	test_command: string
	last_checkpoint_count?: number
	last_checkpoint_sha?: string
	format?: import("./progress-gate.js").TestOutputFormat
	exit_code?: number
}

export type TxMeta = {
	base_commit: string
	isolation: "fail-fast" | "rebase" | "hybrid"
	target_branch: string
	test_command?: string
	compile_command?: string
	status: "active" | "committed" | "aborted"
}

export async function startServer(config: ServerConfig) {
	const app = Fastify({ logger: true })

	// Uniform error mapping: ZodError → 400, CPError → mapped status, else 500.
	app.setErrorHandler((err, _req, reply) => {
		const { errorStatusAndBody } = errorsModule
		const fastifyStatus = (err as any)?.statusCode
		if (typeof fastifyStatus === "number" && fastifyStatus >= 400 && fastifyStatus < 500 && !(err as any)?.issues) {
			// Fastify's own client errors (bad JSON body, unsupported media type, ...)
			return reply.code(fastifyStatus).send({ code: "VALIDATION_ERROR", message: err.message })
		}
		const { status, body } = errorStatusAndBody(err)
		if (status >= 500) app.log.error({ err }, "Unhandled route error")
		return reply.code(status).send(body)
	})

	app.register(fastifyCors)
	app.register(fastifyFormbody)
	app.register(fastifyCompress)
	app.register(fastifySwagger, {
		openapi: {
			openapi: "3.1.0",
			info: { title: "Roo Control-Plane", version: "0.0.1" },
		},
	})
	app.register(fastifySwaggerUI, { routePrefix: "/docs" })

	app.decorate("repoRoot", config.repoRoot)
	app.decorate("databaseUrl", config.databaseUrl || "")
	// R31, R32: Server-side allowlist for test file modifications (NOT agent-controlled)
	app.decorate("testModifyAllowlist", config.testModifyAllowlist || [])
	// R33: In-memory progress baselines for DB-less mode (testing) - only used if database fails
	app.decorate("progressBaselines", new Map<string, ProgressBaselineState>())
	// R30: In-memory file reservations per transaction (tx_id → Map<file_path, claimer_id>)
	app.decorate("fileReservations", new Map<string, Map<string, string>>())
	// Per-transaction metadata (base commit, isolation, target branch, commands).
	// Authoritative in DB-less mode; a cache in DB mode.
	app.decorate("txMeta", new Map<string, TxMeta>())
	// R4/R5: latest safety-gate outcome per GLOBAL sub-tx id.
	app.decorate("safetyGates", new Map<string, { ok: boolean; at: number }>())
	// R16/R17: snapshots of sub-txs already merged into each parent (for strict structural checks).
	app.decorate("mergedSnapshots", new Map<string, import("./structural-conflict.js").SubTxSnapshot[]>())
	// Processes spawned on behalf of a transaction (killed on rollback/abort).
	app.decorate("txProcesses", new Map<string, Set<ChildProcess>>())
	app.decorate("cpConfig", {
		testCommand: config.testCommand,
		testSuites: config.testSuites ?? {},
		testTimeoutMs: config.testTimeoutMs ?? 300_000,
		unknownActionPolicy: config.unknownActionPolicy ?? "deny",
	})
	// Every route with a :tx_id param: validate the id, and (except for log /
	// metric / lifecycle routes that must work after a tx's worktree is gone)
	// require the transaction worktree to exist → 404 TX_NOT_FOUND.
	const TX_EXISTENCE_EXEMPT = new Set([
		"/tx/:tx_id",
		"/tx/:tx_id/abort",
		"/tx/:tx_id/tool-call",
		"/tx/:tx_id/tool-calls",
		"/tx/:tx_id/model-call",
		"/tx/:tx_id/model-calls",
		"/tx/:tx_id/metric/rollback",
		"/tx/:tx_id/metric/execution",
		"/tx/:tx_id/history",
		"/tx/:tx_id/plan",
	])
	app.addHook("preHandler", async (req) => {
		const params = (req.params ?? {}) as Record<string, unknown>
		if (!("tx_id" in params)) return
		const { assertTxId } = await import("./ids.js")
		assertTxId(params.tx_id)
		const routeUrl = (req as any).routeOptions?.url ?? (req as any).routerPath
		if (TX_EXISTENCE_EXEMPT.has(routeUrl)) return
		const { requireTx } = await import("./guards.js")
		await requireTx(app, params.tx_id)
	})
	app.addHook("onClose", async () => {
		try {
			await app.db?.end()
		} catch {
			/* ignore */
		}
	})

	// Initialize database (PostgreSQL if URL provided, otherwise SQLite fallback)
	if (!config.disableDb) {
		try {
			const { createDatabase } = await import("./db.js")
			const db = await createDatabase(config.databaseUrl, config.repoRoot)
			if (db) {
				app.decorate("db", db)
				app.log.info("Database initialized successfully")
			} else {
				app.log.warn("Database initialization failed - continuing with in-memory storage only")
			}
		} catch (error) {
			app.log.error({ err: error }, "Database initialization threw an error - continuing without database")
			// Server continues without database (graceful degradation)
		}
	} else {
		app.log.info("Database disabled via flag")
	}

	// P3 FIX: Clean up stale worktrees on startup
	// This prevents leaked worktrees/branches after crashes/restarts
	await cleanupStaleWorktreesOnStartup(app, config.repoRoot)

	registerTxRoutes(app)
	registerGitRoutes(app)
	registerVersionRoutes(app)
	registerShellRoutes(app)
	if (!config.disableMcp) {
		try {
			const { registerMcp } = await import("./mcp.js")
			registerMcp(app)
		} catch (e) {
			app.log.warn({ err: e }, "Failed to init MCP; continuing without it")
		}
	} else {
		app.log.info("MCP disabled via flag")
	}

	await app.listen({ port: config.port, host: "127.0.0.1" })
	app.log.info(`Control-Plane listening on http://127.0.0.1:${config.port}`)
	return app
}

declare module "fastify" {
	interface FastifyInstance {
		repoRoot: string
		databaseUrl: string
		db?: import("./db-adapter.js").DbPool
		// R31, R32: Server-side allowlist for test file modifications (NOT agent-controlled)
		testModifyAllowlist: string[]
		// R33: In-memory progress baselines for DB-less mode (testing)
		progressBaselines?: Map<string, ProgressBaselineState>
		// R30: In-memory file reservations per transaction (tx_id → Map<file_path, claimer_id>)
		fileReservations: Map<string, Map<string, string>>
		txMeta: Map<string, TxMeta>
		safetyGates: Map<string, { ok: boolean; at: number }>
		mergedSnapshots: Map<string, import("./structural-conflict.js").SubTxSnapshot[]>
		txProcesses: Map<string, Set<ChildProcess>>
		cpConfig: {
			testCommand?: string
			testSuites: Record<string, string>
			testTimeoutMs: number
			unknownActionPolicy: "deny" | "allow"
		}
	}
}

/**
 * P3 FIX: Clean up stale worktrees on startup
 *
 * Goal: Prevent leaked worktrees/branches after crashes.
 *
 * Strategy:
 * 1. Get list of active transaction IDs from database (if available)
 * 2. Remove any worktrees not associated with active transactions
 * 3. Log cleanup results
 */
async function cleanupStaleWorktreesOnStartup(app: import("fastify").FastifyInstance, repoRoot: string): Promise<void> {
	const git = new Git({ repoRoot })

	// Without a database we cannot know which transactions are still active, and
	// deleting worktrees would destroy in-flight work (e.g. a task resumed after a
	// window reload). Only prune git's bookkeeping in that case.
	if (!app.db) {
		try {
			await (git as any).git(["worktree", "prune"])
		} catch {
			/* ignore */
		}
		return
	}

	try {
		// Get active transaction IDs from database
		const activeTxIds = new Set<string>()

		if (app.db) {
			try {
				// Query for transactions that are still in progress (not committed/aborted)
				const result = await app.db.query(
					`SELECT tx_id FROM "transaction" WHERE state IS NULL OR state = 'active'`,
				)
				for (const row of result.rows) {
					activeTxIds.add(row.tx_id)
				}
				app.log.info(`Found ${activeTxIds.size} active transactions in database`)
			} catch (e) {
				app.log.warn({ err: e }, "Could not query active transactions - will clean up all worktrees")
			}
		}

		// Clean up stale worktrees
		const worktreeResult = await git.cleanupStaleWorktrees(activeTxIds)

		if (worktreeResult.worktreesRemoved.length > 0) {
			app.log.info(
				{
					worktreesRemoved: worktreeResult.worktreesRemoved.length,
					branchesRemoved: worktreeResult.branchesRemoved.length,
				},
				"Cleaned up stale worktrees",
			)
		}

		if (worktreeResult.errors.length > 0) {
			app.log.warn(
				{
					errors: worktreeResult.errors,
				},
				"Some worktree cleanup errors occurred",
			)
		}

		// Clean up orphaned branches
		const branchResult = await git.cleanupOrphanedBranches(activeTxIds)

		if (branchResult.removed.length > 0) {
			app.log.info(
				{
					branchesRemoved: branchResult.removed.length,
				},
				"Cleaned up orphaned branches",
			)
		}

		if (branchResult.errors.length > 0) {
			app.log.warn(
				{
					errors: branchResult.errors,
				},
				"Some branch cleanup errors occurred",
			)
		}
	} catch (e) {
		app.log.warn({ err: e }, "Worktree cleanup failed - continuing startup")
		// Don't fail startup due to cleanup issues
	}
}
