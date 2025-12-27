import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { getOrCreateRepo, listVersions } from "../store.js"

export function registerVersionRoutes(app: FastifyInstance) {
	app.get("/versions", async (req, reply) => {
		const query = z
			.object({ limit: z.string().optional(), after: z.string().optional() })
			.parse((req as any).query || {})
		if (!app.db) {
			return reply.send({ items: [] })
		}
		const repo_id = await getOrCreateRepo(app.db, app.repoRoot)
		const items = await listVersions(app.db, repo_id, query.limit ? Number(query.limit) : 50, query.after)
		return reply.send({ items })
	})
}
