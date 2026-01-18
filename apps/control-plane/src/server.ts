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
}

export async function startServer(config: ServerConfig) {
	const app = Fastify({ logger: true })

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
	// R33: In-memory progress baselines for DB-less mode (testing)
	app.decorate("progressBaselines", new Map<string, { passing_count: number; total_count: number; test_command: string; last_checkpoint_count?: number; last_checkpoint_sha?: string }>())

	if (!config.disableDb && config.databaseUrl) {
		const pool = createPool(config.databaseUrl)
		await migrate(pool)
		app.decorate("db", pool)
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
		db?: import("pg").Pool
		// R31, R32: Server-side allowlist for test file modifications (NOT agent-controlled)
		testModifyAllowlist: string[]
		// R33: In-memory progress baselines for DB-less mode (testing)
		progressBaselines?: Map<
			string,
			{ passing_count: number; total_count: number; test_command: string; last_checkpoint_count?: number; last_checkpoint_sha?: string }
		>
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

	try {
		// Get active transaction IDs from database
		const activeTxIds = new Set<string>()

		if (app.db) {
			try {
				// Query for transactions that are still in progress (not committed/aborted)
				const result = await app.db.query(
					`SELECT tx_id FROM transaction WHERE state IS NULL OR state = 'active'`,
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
