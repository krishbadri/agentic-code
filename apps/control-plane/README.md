# Roo Control-Plane (Fastify)

Local daemon that gates all file and shell actions via REST + MCP.

## Run

pnpm --filter @roo-code/control-plane dev --repo /path/to/workspace --port 8899 --db postgres://localhost/agentic_cp

## REST

- POST /tx/begin
- POST /tx/:tx_id/apply
- POST /tx/:tx_id/write
- POST /tx/:tx_id/checkpoint
- POST /tx/:tx_id/commit
- POST /tx/:tx_id/rollback
- GET /git/status/:tx_id
- GET /versions
- POST /shell/exec/:tx_id

See /docs for OpenAPI.

## MCP

SSE endpoint at /mcp exposes tools mirroring REST.

When transactional mode is enabled, the Roo extension auto-writes `.roo/mcp.json` with:

```
{
	"mcpServers": {
		"roo-control-plane": { "url": "http://127.0.0.1:8899/mcp" }
	}
}
```

OpenAPI UI is available at `/docs`.
