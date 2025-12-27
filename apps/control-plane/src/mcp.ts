import type { FastifyInstance } from "fastify"

// For now, disable MCP server to avoid startup failures across environments.
// This keeps the Control-Plane resilient; REST remains available.
export function registerMcp(app: FastifyInstance) {
	app.log.warn("MCP disabled (non-fatal); REST API is available")
}
