import { Pool } from "pg"

export function createPool(databaseUrl: string) {
	const pool = new Pool({ connectionString: databaseUrl })
	return pool
}

export async function migrate(pool: Pool) {
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
