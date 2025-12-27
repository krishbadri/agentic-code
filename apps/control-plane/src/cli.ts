#!/usr/bin/env node
import { startServer } from "./server.js"
import getPort from "get-port"

function parseArgs(argv: string[]) {
	const args: Record<string, string | boolean> = {}
	let cmd = "start"
	const rest: string[] = []
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i]
		if (!a) continue
		if (!a.startsWith("-")) {
			if (i === 2) cmd = a
			else rest.push(a)
			continue
		}
		const key = a.replace(/^--/, "")
		const eq = key.indexOf("=")
		if (eq !== -1) {
			const k = key.slice(0, eq)
			const v = key.slice(eq + 1)
			args[k] = v
		} else {
			const k = key
			const next = argv[i + 1]
			if (next && !next.startsWith("-")) {
				args[k] = next
				i++
			} else {
				args[k] = true
			}
		}
	}
	return { cmd, args, rest }
}

async function main() {
	const { cmd, args } = parseArgs(process.argv)
	if (cmd === "dev" || cmd === "start") {
		const repo = (args.repo as string) || process.cwd()
		let port = Number(args.port ?? 8899)
		const strict = !!args.strictPort
		if (port === 0) {
			port = await getPort()
		} else {
			const free = await getPort({ port })
			if (free !== port) {
				if (strict) {
					console.error(`Port ${port} busy; use --port 0 or omit --strictPort`)
					process.exit(1)
				}
				console.warn(`Port ${port} busy, using ${free}`)
				port = free
			}
		}
		const disableDb = !!args.disableDb
		const disableMcp = !!args.disableMcp
		const db = disableDb ? undefined : (args.db as string) || process.env.CP_DATABASE_URL
		await startServer({ repoRoot: repo, port, databaseUrl: db, disableDb, disableMcp })
		// Output the actual port for child-process callers
		console.log(JSON.stringify({ port }))
		return
	}
	console.error(`Unknown command: ${cmd}`)
	process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
