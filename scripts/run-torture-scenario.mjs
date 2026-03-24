#!/usr/bin/env node
/**
 * Run torture repo scenario via Roo Code extension API (IPC)
 * Based on packages/evals/src/cli/runTask.ts pattern
 * 
 * Usage: 
 *   node scripts/run-torture-scenario.mjs record [vcr-dir]
 *   node scripts/run-torture-scenario.mjs replay [vcr-dir]
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execa } from "execa"
import pWaitFor from "p-wait-for"
import { fileURLToPath } from "url"
import { dirname } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Import types and IPC client
const { IpcClient } = await import("@roo-code/ipc")
const { TaskCommandName, RooCodeEventName, IpcMessageType } = await import("@roo-code/types")

const mode = process.argv[2] || "record"
const vcrDirArg = process.argv[3]

if (!["record", "replay"].includes(mode)) {
	console.error("Mode must be 'record' or 'replay'")
	process.exit(1)
}

// Torture repo paths
const tortureRepo = "C:\\Users\\kpb20\\Downloads\\txn-agent-torture-repo\\txn-agent-torture-repo"

// Add SQLite-backed persistence
const TORTURE_PROMPT = `Add SQLite-backed persistence to this repo while keeping in-memory as the default.
I should be able to switch via CLI: --store sqlite and env var TXN_TODO_DB for the path.

Requirements:
- Create a SqliteKV class that implements the KVStore interface in app/store.py
- Update make_store() to return SqliteKV when kind="sqlite"
- Add unit tests that cover SQLite persistence across process restarts
- Update README with usage examples

Success criteria:
- All existing tests pass
- New SQLite tests pass
- CLI works with --store sqlite`

if (!fs.existsSync(tortureRepo)) {
	console.error(`Torture repo not found: ${tortureRepo}`)
	process.exit(1)
}

// Create or use VCR directory
const vcrDir = vcrDirArg || path.join(os.tmpdir(), `vcr-torture-${Date.now()}`)
fs.mkdirSync(vcrDir, { recursive: true })

// Set VCR environment
process.env.ROO_VCR_MODE = mode
process.env.ROO_VCR_DIR = vcrDir

console.log(`[torture-runner] Mode: ${mode}`)
console.log(`[torture-runner] VCR Dir: ${vcrDir}`)
console.log(`[torture-runner] Workspace: ${tortureRepo}`)

// Use inline prompt
const prompt = TORTURE_PROMPT
console.log(`[torture-runner] Prompt length: ${prompt.length} chars`)

// IPC socket path
const ipcSocketPath = process.env.ROO_CODE_IPC_SOCKET_PATH || 
	path.join(os.tmpdir(), `torture-${Date.now()}.sock`)

// Open VS Code with workspace
const codeCommand = `code --disable-workspace-trust -n "${tortureRepo}"`
console.log(`[torture-runner] Opening VS Code: ${codeCommand}`)

const subprocess = execa({ env: { ...process.env, ROO_CODE_IPC_SOCKET_PATH: ipcSocketPath }, shell: true })`${codeCommand}`

// Give VS Code time to spawn
await new Promise((resolve) => setTimeout(resolve, 5000))

// Connect via IPC
let client
let attempts = 10

while (attempts > 0) {
	try {
		client = new IpcClient(ipcSocketPath, (...args) => console.log("[ipc]", ...args))
		await pWaitFor(() => client.isReady, { interval: 250, timeout: 2000 })
		break
	} catch (error) {
		client?.disconnect()
		attempts--
		if (attempts <= 0) {
			console.error(`[torture-runner] Failed to connect to IPC socket: ${ipcSocketPath}`)
			console.error("[torture-runner] Make sure VS Code extension is running and IPC is enabled")
			process.exit(1)
		}
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}
}

console.log("[torture-runner] Connected to extension via IPC")

// Track task state
let taskId = null
let firstError = null
let taskCompleted = false
let taskAborted = false

client.on(IpcMessageType.TaskEvent, (taskEvent) => {
	const { eventName, payload } = taskEvent
	
	if (eventName === RooCodeEventName.TaskStarted) {
		taskId = payload[0]
		console.log(`[torture-runner] Task started: ${taskId}`)
	}
	
	if (eventName === RooCodeEventName.TaskToolFailed) {
		const [_taskId, toolName, error] = payload
		if (!firstError) {
			firstError = { toolName, error, taskId: _taskId, stack: error?.stack }
			console.error(`[torture-runner] FIRST ERROR:`)
			console.error(`  Tool: ${toolName}`)
			console.error(`  Error: ${error}`)
		}
	}
	
	if (eventName === RooCodeEventName.TaskCompleted) {
		taskCompleted = true
		console.log(`[torture-runner] Task completed: ${payload[0]}`)
	}
	
	if (eventName === RooCodeEventName.TaskAborted) {
		taskAborted = true
		console.log(`[torture-runner] Task aborted: ${payload[0]}`)
	}
})

// Send StartNewTask command
console.log("[torture-runner] Sending StartNewTask command...")
client.sendCommand({
	commandName: TaskCommandName.StartNewTask,
	data: {
		text: prompt,
		configuration: {
			// Use default - will be overridden by extension settings
		},
		newTab: true,
	},
})

// Wait for completion (30 minute timeout)
const TIMEOUT_MS = 30 * 60 * 1000
try {
	await pWaitFor(() => taskCompleted || taskAborted, {
		timeout: TIMEOUT_MS,
		interval: 1000,
	})
} catch (error) {
	console.error("[torture-runner] Task timed out or failed to complete")
	process.exit(1)
}

// Cleanup
if (taskId && !taskAborted) {
	client.sendCommand({ commandName: TaskCommandName.CloseTask, data: taskId })
	await new Promise((resolve) => setTimeout(resolve, 2000))
}

client.disconnect()
subprocess.kill()

// Output results
console.log("\n=== RESULTS ===")
console.log(`VCR Dir: ${vcrDir}`)
console.log(`Mode: ${mode}`)
console.log(`Task ID: ${taskId || "N/A"}`)
console.log(`Completed: ${taskCompleted}`)
console.log(`Aborted: ${taskAborted}`)

if (firstError) {
	console.log("\n=== FIRST ERROR ===")
	console.log(`Tool: ${firstError.toolName}`)
	console.log(`Error: ${firstError.error}`)
	console.log(`Task ID: ${firstError.taskId}`)
	process.exit(1)
} else if (taskCompleted) {
	console.log("\n[torture-runner] Task completed successfully")
	process.exit(0)
} else {
	console.log("\n[torture-runner] Task aborted")
	process.exit(1)
}
