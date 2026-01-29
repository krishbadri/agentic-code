import type { Pool } from "pg"
import { createDbPool, type DbPool } from "./db-adapter.js"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"

/**
 * Create database pool (PostgreSQL or SQLite)
 * Returns a Pool-compatible interface that works with existing store functions
 */
export async function createDatabase(
	databaseUrl?: string,
	repoRoot?: string,
): Promise<DbPool | null> {
	try {
		if (databaseUrl && databaseUrl.startsWith("postgresql://")) {
			// Use PostgreSQL
			const pool = await createDbPool(databaseUrl)
			if (pool) {
				try {
					await migratePostgres(pool)
				} catch (migrationError) {
					console.error("[db] PostgreSQL migration failed:", migrationError)
					// Close pool and return null to fall back to in-memory
					await pool.end().catch(() => {})
					return null
				}
			}
			return pool
		} else if (repoRoot) {
			// Use SQLite as fallback
			try {
				const dbDir = join(repoRoot, ".cp")
				if (!existsSync(dbDir)) {
					await mkdir(dbDir, { recursive: true })
				}
				const sqlitePath = join(dbDir, "db.sqlite")
				const pool = await createDbPool(undefined, sqlitePath)
				if (pool) {
					try {
						await migrateSqlite(pool)
					} catch (migrationError) {
						console.error("[db] SQLite migration failed:", migrationError)
						// Close pool and return null to fall back to in-memory
						await pool.end().catch(() => {})
						return null
					}
				}
				return pool
			} catch (sqliteError) {
				// SQLite file creation or initialization failed (permissions, disk full, etc.)
				console.error("[db] SQLite initialization failed:", sqliteError)
				return null
			}
		}
	} catch (error) {
		// Catch any unexpected errors during database initialization
		console.error("[db] Database initialization failed:", error)
		return null
	}
	
	return null
}

/**
 * Migrate PostgreSQL database
 */
async function migratePostgres(pool: DbPool): Promise<void> {
	const migrations = [
		"001_init.sql",
		"002_sub_transactions.sql",
		"003_research_metrics.sql",
		"004_plans.sql",
		"005_progress_gate.sql",
	]

	for (const migration of migrations) {
		const sql = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL(`../db/migrations/${migration}`, import.meta.url), "utf8"),
		)
		await pool.query(sql)
	}
}

/**
 * Migrate SQLite database
 */
async function migrateSqlite(pool: DbPool): Promise<void> {
	const migrations = [
		"001_init.sql",
		"002_sub_transactions.sql",
		"003_research_metrics.sql",
		"004_plans.sql",
		"005_progress_gate.sql",
	]

	for (const migration of migrations) {
		const sql = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL(`../db/migrations-sqlite/${migration}`, import.meta.url), "utf8"),
		)
		await pool.query(sql)
	}

	// SQLite-specific: Add columns that might not exist (for tool_call table)
	// Check if columns exist by trying to query them
	try {
		await pool.query(`SELECT sub_tx_id FROM tool_call LIMIT 1`)
	} catch {
		// Column doesn't exist, add it
		try {
			await pool.query(`ALTER TABLE tool_call ADD COLUMN sub_tx_id TEXT`)
			// Create index after adding the column
			await pool.query(`CREATE INDEX IF NOT EXISTS idx_tool_call_sub_tx ON tool_call(sub_tx_id)`)
		} catch {
			// Ignore if already exists or table doesn't exist yet
		}
	}

	try {
		await pool.query(`SELECT checkpoint_before FROM tool_call LIMIT 1`)
	} catch {
		try {
			await pool.query(`ALTER TABLE tool_call ADD COLUMN checkpoint_before TEXT`)
		} catch {
			// Ignore
		}
	}
}

// Legacy exports for backward compatibility
export function createPool(databaseUrl: string): Pool {
	const { Pool } = require("pg")
	return new Pool({ connectionString: databaseUrl })
}

export async function migrate(pool: Pool): Promise<void> {
	const client = await pool.connect()
	try {
		const sql = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL("../db/migrations/001_init.sql", import.meta.url), "utf8"),
		)
		await client.query(sql)
	} finally {
		client.release()
	}
}
