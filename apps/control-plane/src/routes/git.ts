import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { Git } from "../git.js"

const HeadersSchema = z.object({
	"x-actor-id": z.string().min(1),
	"x-repo-id": z.string().min(1).optional(),
})

export function registerGitRoutes(app: FastifyInstance) {
	app.get("/git/status/:tx_id", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const git = new Git({ repoRoot: app.repoRoot })
		const { changes } = await git.status((req.params as any).tx_id)
		return reply.send({ changes })
	})

	app.get("/git/show/:sha", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const q = z.object({ path: z.string() }).parse((req as any).query || {})
		const git = new Git({ repoRoot: app.repoRoot })
		try {
			const buf = await git.showFileAt((req.params as any).sha, q.path)
			return reply.send({ content_base64: buf.toString("base64") })
		} catch (e) {
			return reply.code(404).send({ code: "DENIED", message: String(e) })
		}
	})

	app.get("/tx/:tx_id/checkpoints", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const git = new Git({ repoRoot: app.repoRoot })
		try {
			const checkpoints = await git.getCheckpoints((req.params as any).tx_id)
			return reply.send({ checkpoints })
		} catch (e) {
			return reply.code(500).send({ code: "ERROR", message: String(e) })
		}
	})

	app.get("/tx/:tx_id/suggest-rollback", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const query = z
			.object({
				context: z.string().optional(),
				message: z.string().optional(),
			})
			.parse((req as any).query || {})

		const git = new Git({ repoRoot: app.repoRoot })
		try {
			const checkpoints = await git.getCheckpoints((req.params as any).tx_id)

			// Simple heuristics for now
			let suggested = null
			if (query.context === "error" && query.message) {
				// Find last checkpoint before error (by timestamp)
				const errorTime = Date.now()
				suggested = checkpoints.find((cp) => cp.timestamp < errorTime) || checkpoints[checkpoints.length - 1]
			} else {
				// Default: suggest most recent manual checkpoint
				suggested = checkpoints.find((cp) => cp.reason === "manual") || checkpoints[0]
			}

			return reply.send({
				suggested: suggested
					? {
							hash: suggested.hash,
							reason: suggested.reason,
							timestamp: suggested.timestamp,
							message: suggested.message,
						}
					: null,
			})
		} catch (e) {
			return reply.code(500).send({ code: "ERROR", message: String(e) })
		}
	})
}
