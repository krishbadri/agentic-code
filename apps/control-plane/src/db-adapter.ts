/**
 * Database Adapter - Unified interface for PostgreSQL and SQLite
 * 
 * Provides a Pool-compatible interface so existing store functions work with both database types.
 */

import type { Pool } from "pg"
import type Database from "better-sqlite3"

export interface QueryResult {
	rows: any[]
	rowCount: number
}

/**
 * Pool-compatible interface that works with both PostgreSQL and SQLite
 */
export interface DbPool {
	query(text: string, params?: any[]): Promise<QueryResult>
	end(): Promise<void>
}

/**
 * PostgreSQL adapter (wraps pg Pool) - Pool-compatible
 */
export class PostgresPool implements DbPool {
	constructor(private pool: Pool) {}

	async query(text: string, params?: any[]): Promise<QueryResult> {
		const result = await this.pool.query(text, params)
		return {
			rows: result.rows,
			rowCount: result.rowCount || 0,
		}
	}

	async end(): Promise<void> {
		await this.pool.end()
	}
}

/**
 * SQLite adapter (wraps better-sqlite3 Database) - Pool-compatible
 */
export class SqlitePool implements DbPool {
	constructor(private db: Database.Database) {}

	async query(text: string, params?: any[]): Promise<QueryResult> {
		// Convert PostgreSQL-style $1, $2, $3 to SQLite ? placeholders
		let sql = text
		const sqliteParams: any[] = []

		if (params && params.length > 0) {
			// Replace $1, $2, etc. with ? and collect params in order
			sql = text.replace(/\$(\d+)/g, (match, num) => {
				const index = parseInt(num, 10) - 1
				if (index < params.length) {
					// Serialize JSON objects/arrays to strings for SQLite
					const param = params[index]
					if (param && typeof param === "object" && !(param instanceof Date) && !Buffer.isBuffer(param)) {
						sqliteParams.push(JSON.stringify(param))
					} else {
						sqliteParams.push(param)
					}
					return "?"
				}
				return match
			})
		}

		// Handle PostgreSQL-specific functions and syntax
		// Replace now() with datetime('now') for SQLite
		sql = sql.replace(/\bnow\(\)/gi, "datetime('now')")
		// Replace gen_random_uuid() with lower(hex(randomblob(16))) for SQLite
		sql = sql.replace(/\bgen_random_uuid\(\)/gi, "lower(hex(randomblob(16)))")
		// Replace TIMESTAMPTZ with TEXT (SQLite doesn't have timezone-aware timestamps)
		sql = sql.replace(/\bTIMESTAMPTZ\b/gi, "TEXT")
		// Replace JSONB with TEXT (SQLite stores JSON as TEXT)
		sql = sql.replace(/\bJSONB\b/gi, "TEXT")
		// Replace BIGSERIAL with INTEGER PRIMARY KEY AUTOINCREMENT
		sql = sql.replace(/\bBIGSERIAL\b/gi, "INTEGER PRIMARY KEY AUTOINCREMENT")
		// Replace UUID with TEXT (SQLite doesn't have UUID type)
		sql = sql.replace(/\bUUID\b/gi, "TEXT")
		// Replace BOOLEAN with INTEGER (SQLite uses INTEGER for booleans)
		sql = sql.replace(/\bBOOLEAN\b/gi, "INTEGER")

		// Handle RETURNING clause (SQLite doesn't support RETURNING, need to query separately)
		const hasReturning = /RETURNING\s+(\w+)/i.test(sql)
		let returningColumn: string | null = null
		let tableName: string | null = null
		
		if (hasReturning) {
			const match = sql.match(/RETURNING\s+(\w+)/i)
			returningColumn = (match && match[1]) ? match[1] : null
			const tableMatch = sql.match(/INSERT\s+INTO\s+(\w+)/i)
			tableName = (tableMatch && tableMatch[1]) ? tableMatch[1] : null
			// Remove RETURNING clause for SQLite
			sql = sql.replace(/\s+RETURNING\s+[\w, ]+/i, "")
		}

		// Check if this is a multi-statement SQL (e.g., migration scripts)
		// Use exec() for multi-statement, prepare() for single statement
		const statements = sql.split(";").filter((s) => s.trim().length > 0)
		const isMultiStatement = statements.length > 1

		if (isMultiStatement) {
			// For multi-statement SQL (migrations), use exec()
			this.db.exec(sql)
			return { rows: [], rowCount: 0 }
		}

		// Execute single statement query
		const stmt = this.db.prepare(sql)
		
		// Determine if it's a SELECT (returns rows) or mutation (returns changes)
		const isSelect = sql.trim().toUpperCase().startsWith("SELECT")
		
		if (isSelect) {
			const rows = stmt.all(...sqliteParams) as any[]
			// Parse JSON fields
			const parsedRows = rows.map((row) => {
				const parsed: any = {}
				for (const [key, value] of Object.entries(row)) {
					if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
						try {
							parsed[key] = JSON.parse(value)
						} catch {
							parsed[key] = value
						}
					} else {
						parsed[key] = value
					}
				}
				return parsed
			})
			return {
				rows: parsedRows,
				rowCount: parsedRows.length,
			}
		} else {
			const result = stmt.run(...sqliteParams)
			
			// If RETURNING was requested, query the inserted row
			if (hasReturning && returningColumn && tableName) {
				// For INSERT with RETURNING, get the last inserted row
				// SQLite uses lastInsertRowid for INTEGER PRIMARY KEY AUTOINCREMENT
				// For TEXT primary keys (UUIDs), we need to extract from params or query by a unique field
				
				if (result.lastInsertRowid && result.lastInsertRowid > 0) {
					// INTEGER primary key (call_id, id, etc.)
					const selectStmt = this.db.prepare(`SELECT ${returningColumn} FROM ${tableName} WHERE rowid = ?`)
					const row = selectStmt.get(result.lastInsertRowid) as any
					
					return {
						rows: row ? [row] : [],
						rowCount: row ? 1 : 0,
					}
				} else {
					// TEXT primary key (UUID like plan_id) - find by the returning column value
					// Extract column list from INSERT statement to find which param is the returning column
					const columnMatch = sql.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)/i)
					if (columnMatch && columnMatch[1] && returningColumn && tableName) {
						const columns = columnMatch[1].split(",").map((c) => c.trim())
						const columnIndex = columns.findIndex((col) => col === returningColumn)
						
						if (columnIndex >= 0 && columnIndex < sqliteParams.length) {
							const selectStmt = this.db.prepare(`SELECT ${returningColumn} FROM ${tableName} WHERE ${returningColumn} = ?`)
							const row = selectStmt.get(sqliteParams[columnIndex]) as any
							
							return {
								rows: row ? [row] : [],
								rowCount: row ? 1 : 0,
							}
						}
					}
				}
			}
			
			return {
				rows: [],
				rowCount: result.changes || 0,
			}
		}
	}

	async end(): Promise<void> {
		this.db.close()
	}
}

/**
 * Create Pool-compatible adapter from database URL or use SQLite fallback
 */
export async function createDbPool(
	databaseUrl?: string,
	sqlitePath?: string,
): Promise<DbPool | null> {
	if (databaseUrl && databaseUrl.startsWith("postgresql://")) {
		// Use PostgreSQL
		const { Pool } = await import("pg")
		const pool = new Pool({ connectionString: databaseUrl })
		return new PostgresPool(pool)
	} else if (sqlitePath) {
		// Use SQLite as fallback
		const { default: Database } = await import("better-sqlite3")
		const db = new Database(sqlitePath)
		
		// Enable foreign keys and WAL mode for better concurrency
		db.pragma("foreign_keys = ON")
		db.pragma("journal_mode = WAL")
		
		return new SqlitePool(db)
	}
	
	return null
}

// Legacy alias for backward compatibility
export type DbAdapter = DbPool
export async function createDbAdapter(
	databaseUrl?: string,
	sqlitePath?: string,
): Promise<DbAdapter | null> {
	return createDbPool(databaseUrl, sqlitePath)
}
