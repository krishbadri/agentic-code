import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as path from "node:path"
const pexec = promisify(execFile)

const HeadersSchema = z.object({
	"x-actor-id": z.string().min(1),
	"x-repo-id": z.string().min(1).optional(),
})

const BodySchema = z.object({
	cmd: z.string(),
	args: z.array(z.string()).default([]),
	cwd_rel: z.string().default(""),
	stdin_base64: z.string().nullable().optional(),
	timeout_ms: z.number().int().default(600000),
	env: z.record(z.string()).default({}),
})

export function registerShellRoutes(app: FastifyInstance) {
	app.post("/shell/exec/:tx_id", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = BodySchema.parse((req as any).body || {})
		const whitelist = new Set([
			"node",
			"pnpm",
			"npm",
			"yarn",
			"pytest",
			"go",
			"cargo",
			"make",
			"eslint",
			"prettier",
			"ruff",
			"bash",
			"powershell",
			"pwsh",
			"cmd",
			"cmd.exe",
		])
		if (!whitelist.has(body.cmd)) {
			return reply.code(403).send({ code: "DENIED", message: "Command not allowed" })
		}
		const started = Date.now()
		const cwd = path.join(app.repoRoot, body.cwd_rel)
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), body.timeout_ms)
		try {
			const res = await pexec(body.cmd, body.args, {
				cwd,
				env: { ...process.env, ...body.env },
				signal: controller.signal,
				windowsHide: true,
			})
			const duration_ms = Date.now() - started
			clearTimeout(timeout)
			return reply.send({
				exit_code: 0,
				stdout_base64: Buffer.from(res.stdout ?? "").toString("base64"),
				stderr_base64: Buffer.from(res.stderr ?? "").toString("base64"),
				truncated: false,
				duration_ms,
			})
		} catch (err: any) {
			const duration_ms = Date.now() - started
			clearTimeout(timeout)
			const exit_code = typeof err?.code === "number" ? err.code : 1
			return reply.send({
				exit_code,
				stdout_base64: Buffer.from(err?.stdout ?? "").toString("base64"),
				stderr_base64: Buffer.from(err?.stderr ?? String(err)).toString("base64"),
				truncated: false,
				duration_ms,
			})
		}
	})
}
