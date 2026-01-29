import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import * as child_process from "child_process"
import * as net from "net"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted, createDeferred } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

const TORTURE_REPO = "C:\\Users\\kpb20\\Downloads\\txn-agent-torture-repo2\\txn-agent-torture-repo"

// Hard timeout for torture test - MUST complete within this time
// Increased to allow slow models to complete complex tasks
const TORTURE_TIMEOUT_MS = 600_000 // 600 seconds (10 minutes) - correctness matters more than speed

// Fast-fail threshold for consecutive API failures
const MAX_CONSECUTIVE_API_FAILURES = 3

// The P1 prompt from PROMPTS.md - Add SQLite-backed persistence
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


const stage_2_prompt = `
STAGE 2 TORTURE TASK (Single agent + checkpoints + rollback required)

You are operating on the txn-agent-torture-repo workspace (NOT the Roo-Code monorepo). Confirm you are in the right repo by locating:
- app/core.py
- app/store.py
- tests/test_basic.py
If these do not exist in the current workspace, locate the torture repo root via environment variables (TORTURE_REPO_ROOT / TEST_TORTURE_REPO_WORKSPACE / TXN_AGENT_TORTURE_REPO) and switch to that directory before making changes.

Goal
Implement an atomic bulk-add operation for todos, and prove atomicity via unit tests, for BOTH backends (memory + sqlite).
This task is specifically meant to exercise CHECKPOINTS and ROLLBACK in the agent system.

Functional Requirements
1) Add a new service API:
   - In app/core.py, add TodoService.bulk_add(titles: list[str]) -> list[str]
   - It creates one todo per title (same semantics as add(): strip, reject empty).
   - Returns the created todo IDs in the same order as input titles.

2) Atomicity requirement (must be enforced):
   - bulk_add is ALL-OR-NOTHING.
   - If ANY title is invalid (empty or whitespace after strip), then:
     - bulk_add raises ValueError
     - and NO todos from that call are persisted (no partial writes).
   - Atomicity must hold for both backends:
     - store.kind == "memory"
     - store.kind == "sqlite" (file-backed)

3) Store-level transaction support (so atomicity is real, not best-effort deletes):
   - Extend the KVStore abstraction to support a transaction context manager.
   - Implement it for MemoryKV and SqliteKV.
   - bulk_add must use this transaction mechanism so the operation is atomic.
   Notes:
   - SqliteKV currently commits inside each operation via `with self._conn:`. You must refactor so that multiple put/delete operations can participate in ONE transaction when running inside KVStore.transaction().
   - MemoryKV should snapshot and restore state on rollback (thread-safe).

4) CLI + docs:
   - Add a new CLI command:
       todo bulk-add <titles...>
     Example:
       python -m app.cli bulk-add "a" "b" "c"
   - It should print the created IDs (one per line is fine).
   - Update README.md with a short example.

Testing Requirements
Add tests (pytest) that prove atomicity, at minimum:
- Memory backend:
  - calling bulk_add(["ok1", "   ", "ok2"]) raises ValueError
  - and leaves the todo list unchanged (no ok1 added).
- Sqlite backend:
  - same invalid-input test verifies no partial writes.
  - also add a “success” test that bulk_add adds N items and they persist.

Put tests in a new file tests/test_bulk_add.py (preferred) or the most appropriate existing tests file.
Do not delete existing tests.

Mandatory Stage 2 Checkpoints + Rollback (THIS IS THE POINT OF STAGE 2)
You MUST create checkpoints and you MUST perform at least one rollback, even if you could implement everything correctly on the first try.

Follow this exact process:

Checkpoint C1 — “tests+spec”
A) First implement ONLY:
   - the new tests
   - the new method signature in TodoService (can be stubbed to raise NotImplementedError)
   - any minimal interface scaffolding needed to compile/import
B) Run tests and confirm the new tests fail for the right reason.
C) Create checkpoint named: C1 tests+spec

Checkpoint C2 — “naive-impl”
A) Implement a naive bulk_add that is NOT atomic (sequential adds; will partially write before failing).
B) Run tests; confirm the atomicity tests fail due to partial writes.
C) Create checkpoint named: C2 naive-impl

Rollback (required)
Rollback from C2 back to C1. After rollback:
- verify the workspace reflects C1 state (naive changes gone)
- then proceed to the real implementation.

Checkpoint C3 — “atomic-impl”
A) Implement the real atomic solution:
   - KVStore.transaction()
   - MemoryKV + SqliteKV transaction behavior
   - TodoService.bulk_add uses transaction()
   - CLI command bulk-add
B) Run full tests and ensure all pass.
C) Create checkpoint named: C3 atomic-impl

Checkpoint C4 — “docs+cleanup”
A) Update README.md docs and do any cleanup (formatting, typing, small refactors).
B) Run tests again; ensure pass.
C) Create checkpoint named: C4 docs+cleanup

Output / Reporting (end of task)
At the end, output:
- files changed (list)
- exact commands run
- test results summary
- the checkpoint/rollback sequence you performed (C1 -> C2 -> rollback to C1 -> C3 -> C4)

Constraints
- Do not ask me questions.
- Do not introduce new heavy dependencies.
- Keep existing behavior intact except for adding the bulk-add functionality.
- Prefer small, well-scoped changes over large refactors.
`

// Lifecycle checkpoints
interface LifecycleCheckpoint {
	name: string
	timestamp: number
	elapsedMs: number
}

const checkpoints: LifecycleCheckpoint[] = []
const startTime = Date.now()

function checkpoint(name: string): void {
	const now = Date.now()
	const elapsed = now - startTime
	checkpoints.push({ name, timestamp: now, elapsedMs: elapsed })
	console.log(`[checkpoint] ${name} (elapsed: ${elapsed}ms)`)
}

function getLastCheckpoint(): LifecycleCheckpoint | null {
	return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null
}

function printCheckpoints(): void {
	originalConsoleError("\n========== LIFECYCLE CHECKPOINTS ==========")
	for (const cp of checkpoints) {
		originalConsoleError(`  ${cp.name}: +${cp.elapsedMs}ms`)
	}
	const last = getLastCheckpoint()
	if (last) {
		const now = Date.now()
		const sinceLast = now - last.timestamp
		originalConsoleError(`  [NOW]: +${now - startTime}ms (${sinceLast}ms since last checkpoint)`)
	}
	originalConsoleError("========== END CHECKPOINTS ==========\n")
}

// Collect console output for timeout dump
const consoleBuffer: string[] = []
const originalConsoleLog = console.log
const originalConsoleError = console.error
function captureConsole() {
	console.log = (...args: unknown[]) => {
		const msg = args.map(a => String(a)).join(" ")
		consoleBuffer.push(`[LOG] ${msg}`)
		originalConsoleLog.apply(console, args)
	}
	console.error = (...args: unknown[]) => {
		const msg = args.map(a => String(a)).join(" ")
		consoleBuffer.push(`[ERR] ${msg}`)
		originalConsoleError.apply(console, args)
	}
}
function restoreConsole() {
	console.log = originalConsoleLog
	console.error = originalConsoleError
}
function dumpLast200Lines() {
	const last200 = consoleBuffer.slice(-200)
	originalConsoleError("\n========== LAST 200 LINES OF OUTPUT (TIMEOUT) ==========")
	for (const line of last200) {
		originalConsoleError(line)
	}
	originalConsoleError("========== END OF OUTPUT DUMP ==========\n")
}

async function killProcessByPort(port: number): Promise<void> {
	if (process.platform !== "win32") {
		return
	}
	return new Promise((resolve) => {
		child_process.exec(`netstat -ano | findstr :${port}`, (error, stdout) => {
			if (error || !stdout) {
				resolve()
				return
			}
			const pids = new Set<number>()
			for (const line of stdout.split(/\r?\n/)) {
				const parts = line.trim().split(/\s+/)
				const pidStr = parts[parts.length - 1]
				const pid = Number(pidStr)
				if (Number.isFinite(pid)) {
					pids.add(pid)
				}
			}
			if (pids.size === 0) {
				resolve()
				return
			}
			const killCmd = `taskkill /T /F ${Array.from(pids).map((pid) => `/PID ${pid}`).join(" ")}`
			child_process.exec(killCmd, () => resolve())
		})
	})
}

async function waitForPort(port: number, timeoutMs = 60000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now()
		const tryConnect = () => {
			const socket = new net.Socket()
			socket.setTimeout(750)
			socket.once("connect", () => {
				socket.destroy()
				resolve()
			})
			socket.once("timeout", () => {
				socket.destroy()
			if (Date.now() - start > timeoutMs) {
				reject(new Error(`Control-Plane port ${port} did not open within ${timeoutMs}ms`))
			} else {
				setTimeout(tryConnect, 250)
			}
			})
			socket.once("error", () => {
				socket.destroy()
			if (Date.now() - start > timeoutMs) {
				reject(new Error(`Control-Plane port ${port} did not open within ${timeoutMs}ms`))
			} else {
				setTimeout(tryConnect, 250)
			}
			})
			socket.connect(port, "127.0.0.1")
		}
		tryConnect()
	})
}

suite("Roo Code Task", function () {
	setDefaultSuiteTimeout(this)

		test("Should handle prompt and response correctly", async function () {
		// VERIFICATION-ONLY: If TEST_TORTURE_REPO is set, run torture repo scenario instead
		if (process.env.TEST_TORTURE_REPO) {
			// Hard timeout - test MUST complete within this time
			this.timeout(TORTURE_TIMEOUT_MS + 5000) // Mocha timeout slightly longer than our internal timeout
			
			// Start capturing console output for potential timeout dump
			captureConsole()
			
			// Log test start with comprehensive context
			const testStartTime = Date.now()
			console.log(`[TEST-LIFECYCLE] ========================================`)
			console.log(`[TEST-LIFECYCLE] TEST STARTED at ${new Date().toISOString()}`)
			console.log(`[TEST-LIFECYCLE] Timeout: ${TORTURE_TIMEOUT_MS}ms (${TORTURE_TIMEOUT_MS / 1000}s)`)
			console.log(`[TEST-LIFECYCLE] Process PID: ${process.pid}`)
			console.log(`[TEST-LIFECYCLE] Node version: ${process.version}`)
			console.log(`[TEST-LIFECYCLE] Platform: ${process.platform}`)
			console.log(`[TEST-LIFECYCLE] ========================================`)
			
			// Track VS Code process
			let vscodeProcessPid: number | null = null
			let vscodeProcessExited = false
			let vscodeExitCode: number | null = null
			let vscodeExitSignal: string | null = null
			
			// Track unhandled rejections
			const unhandledRejections: Array<{ reason: unknown; promise: Promise<unknown> }> = []
			process.on('unhandledRejection', (reason, promise) => {
				console.error(`[TEST-LIFECYCLE] ========================================`)
				console.error(`[TEST-LIFECYCLE] UNHANDLED REJECTION DETECTED!`)
				console.error(`[TEST-LIFECYCLE] Reason:`, reason)
				console.error(`[TEST-LIFECYCLE] Promise:`, promise)
				console.error(`[TEST-LIFECYCLE] Test duration: ${Date.now() - testStartTime}ms`)
				console.error(`[TEST-LIFECYCLE] ========================================`)
				unhandledRejections.push({ reason, promise })
			})
			
			// Track uncaught exceptions
			process.on('uncaughtException', (error) => {
				console.error(`[TEST-LIFECYCLE] ========================================`)
				console.error(`[TEST-LIFECYCLE] UNCAUGHT EXCEPTION DETECTED!`)
				console.error(`[TEST-LIFECYCLE] Error:`, error)
				console.error(`[TEST-LIFECYCLE] Stack:`, error.stack)
				console.error(`[TEST-LIFECYCLE] Test duration: ${Date.now() - testStartTime}ms`)
				console.error(`[TEST-LIFECYCLE] ========================================`)
			})
			
			checkpoint("VS Code launched")
			console.log(`[torture-test] Starting with hard timeout of ${TORTURE_TIMEOUT_MS / 1000}s`)

			// VERIFICATION-ONLY: Assert workspace root is correct
			const expectedWorkspace = process.env.TEST_TORTURE_REPO_WORKSPACE
			if (expectedWorkspace) {
				const actualWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
				const expectedPath = path.normalize(expectedWorkspace).replace(/[\/\\]+$/, "")
				const actualPath = actualWorkspace ? path.normalize(actualWorkspace).replace(/[\/\\]+$/, "") : ""
				
				// Check if the expected file exists at the correct location
				const correctFilePath = path.join(expectedPath, "app", "store.py")
				const wrongFilePath = path.join(path.dirname(expectedPath), "app", "store.py")
				const correctFileExists = await fs.access(correctFilePath).then(() => true).catch(() => false)
				const wrongFileExists = await fs.access(wrongFilePath).then(() => true).catch(() => false)
				
				// Case-insensitive comparison on Windows
				const pathsMatch = process.platform === "win32" 
					? expectedPath.toLowerCase() === actualPath.toLowerCase()
					: expectedPath === actualPath
				
				if (!pathsMatch) {
					const errorMsg = `[torture-vcr] WORKSPACE ROOT MISMATCH:
  Expected: ${expectedPath}
  Actual: ${actualPath}
  Correct file exists: ${correctFileExists} (${correctFilePath})
  Wrong file exists: ${wrongFileExists} (${wrongFilePath})
  
  The workspace root must match TEST_TORTURE_REPO_WORKSPACE for deterministic testing.
  getWorkspacePath() should use the override when TEST_TORTURE_REPO_WORKSPACE is set.`
					console.error(errorMsg)
					assert.fail(errorMsg)
				}
				
				if (!correctFileExists) {
					const errorMsg = `[torture-vcr] EXPECTED FILE NOT FOUND:
  Expected workspace: ${expectedPath}
  Expected file: ${correctFilePath}
  File exists: ${correctFileExists}
  
  The workspace root is correct, but the expected file does not exist.`
					console.error(errorMsg)
					assert.fail(errorMsg)
				}
				
				console.log(`[torture-vcr] ✓ Workspace root verified: ${expectedPath}`)
			}

			checkpoint("Workspace ready")

			const api = globalThis.api
			let cpPortForCleanup: number | null = null
			
			// Determine provider dynamically
			let apiProvider = "openai-native"
			let apiKey: string | undefined
			let apiModelId = "gpt-4.1"

			// 1. Try OpenAI Native (Env)
			if (process.env.OPENAI_API_KEY) {
				apiProvider = "openai-native"
				apiKey = process.env.OPENAI_API_KEY
				apiModelId = "gpt-4.1"
			} 
			// 2. Try OpenRouter (Env)
			else if (process.env.OPENROUTER_API_KEY) {
				apiProvider = "openrouter"
				apiKey = process.env.OPENROUTER_API_KEY
				// Check VS Code settings for model, fallback to default
				const config = vscode.workspace.getConfiguration("roo-cline")
				apiModelId = config.get<string>("openRouterModelId") || "liquid/lfm-2.5-1.2b-instruct:free"
			}
			// 3. Try Settings (VS Code)
			else {
				const config = vscode.workspace.getConfiguration("roo-cline")
				const provider = config.get<string>("apiProvider")
				if (provider) {
					apiProvider = provider
					if (apiProvider === "openai-native") {
						apiKey = config.get<string>("openAiNativeApiKey")
						apiModelId = config.get<string>("apiModelId") || "gpt-4.1"
					} else if (apiProvider === "openrouter") {
						apiKey = config.get<string>("openRouterApiKey")
						apiModelId = config.get<string>("openRouterModelId") || "liquid/lfm-2.5-1.2b-instruct:free"
					}
				}
			}
			
			console.log(`[torture-test] PROVIDER SELECTION:`)
			console.log(`  Provider: ${apiProvider}`)
			console.log(`  Model: ${apiModelId}`)
			console.log(`  Key present: ${!!apiKey}`)
			
			if (!apiKey || apiKey.trim().length === 0) {
				const error = `[torture-test] FAST-FAIL: No valid API key found for ${apiProvider}`
				console.error(error)
				restoreConsole()
				assert.fail(error)
			}
			
			// Sanitize key for logging (show first 8 and last 4 chars)
			const sanitizedKey = (apiKey?.length || 0) > 12 
				? `${apiKey!.substring(0, 8)}...${apiKey!.substring(apiKey!.length - 4)}`
				: "***REDACTED***"
			console.log(`  API Key (sanitized): ${sanitizedKey}`)
			
			const vcrDir = process.env.ROO_VCR_DIR || path.join(os.tmpdir(), `vcr-torture-${Date.now()}`)
			await fs.mkdir(vcrDir, { recursive: true })

			// Use the P1 prompt for SQLite backend implementation
			const prompt = TORTURE_PROMPT
			type FirstError = { toolName: string; error: string; taskId: string }
			let firstError: FirstError | null = null
			let recordModeError: FirstError | null = null

			// Normalize error signature: strip UUIDs, temp dirs, timestamps
			function normalizeErrorSignature(err: FirstError): string {
				let normalized = err.error
					.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[UUID]")
					.replace(/C:\\Users\\[^\\]+\\AppData\\Local\\Temp[^"'\s]+/gi, "[TEMP_DIR]")
					.replace(/\/tmp\/[^"'\s]+/gi, "[TEMP_DIR]")
					.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "[TIMESTAMP]")
				return `${err.toolName}||${normalized}`
			}

			// Load record mode error signature if in replay mode
			const recordErrorFile = path.join(vcrDir, ".record-error-signature.txt")
			let recordModeSignature: string | null = null
			if (process.env.ROO_VCR_MODE === "replay") {
				try {
					recordModeSignature = await fs.readFile(recordErrorFile, "utf-8")
				} catch {
					// File doesn't exist yet - will be created in record mode
				}
			}

			// Task configuration with auto-approval enabled (define early for use in handlers)
			const taskConfig = {
				mode: "code" as const,
				autoApprovalEnabled: true,
				alwaysAllowWrite: true,
				alwaysAllowReadOnly: true,
				alwaysAllowReadOnlyOutsideWorkspace: true,
				alwaysAllowExecute: true,
				alwaysApproveResubmit: true, // Enable automatic retry for API failures (non-401 errors)
				// Use dynamic provider
				apiProvider: apiProvider as any,
				openAiNativeApiKey: apiProvider === "openai-native" ? apiKey : undefined,
				openRouterApiKey: apiProvider === "openrouter" ? apiKey : undefined,
				apiModelId: apiProvider === "openai-native" ? apiModelId : undefined,
				openRouterModelId: apiProvider === "openrouter" ? apiModelId : undefined,
				includeMaxTokens: true,
				modelMaxTokens: 512,
			}
			
			// Validate provider matches expected
			if (taskConfig.apiProvider !== apiProvider) {
				const error = `[torture-test] FAST-FAIL: Provider mismatch. Expected: ${apiProvider}, Got: ${taskConfig.apiProvider}`
				console.error(error)
				restoreConsole()
				assert.fail(error)
			}
			
			// Track consecutive API failures for fast-fail
			let consecutiveApiFailures = 0
			let lastApiFailure: { provider: string; model: string; error: string; timestamp: number } | null = null
			let taskAborted = false
			let taskId: string | null = null
			
			const abortTask = async (reason: string) => {
				if (taskAborted) return
				taskAborted = true
				checkpoint(`Task aborted: ${reason}`)
				console.error(`[torture-test] FAST-FAIL: ${reason}`)
				try {
					// Try to cancel the current task if it's the one we started
					await api.cancelCurrentTask()
				} catch (e) {
					// Ignore cancel errors
				}
				fatalFail(reason)
			}

			const killVsCodeProcess = () => {
				// NOTE: vscodeProcess is always null currently (not exposed by @vscode/test-electron)
				if (vscodeProcess) {
					try {
						vscodeProcess.kill("SIGTERM")
						setTimeout(() => {
							if (vscodeProcess && !vscodeProcess.killed) {
								vscodeProcess.kill("SIGKILL")
							}
						}, 100)
					} catch (e) {
						// Ignore kill errors
					}
					return
				}

				if (vscodePid) {
					try {
						if (process.platform === "win32") {
							child_process.exec(`taskkill /T /F /PID ${vscodePid}`, (error) => {
								if (error) {
									originalConsoleErrorForCapture(
										`[torture-test] Failed to kill VS Code process ${vscodePid}: ${error.message}`,
									)
								}
							})
						} else {
							child_process.exec(`kill -9 -${vscodePid}`, (error) => {
								if (error) {
									originalConsoleErrorForCapture(
										`[torture-test] Failed to kill VS Code process ${vscodePid}: ${error.message}`,
									)
								}
							})
						}
					} catch (e) {
						// Ignore kill errors
					}
				}
			}

			const fatalFail = (reason: string) => {
				if (finished) {
					console.log(`[TEST-LIFECYCLE] fatalFail called but already finished: ${reason}`)
					return
				}
				finished = true
				
				const elapsed = Date.now() - testStartTime
				console.error(`[TEST-LIFECYCLE] ========================================`)
				console.error(`[TEST-LIFECYCLE] FATAL FAILURE`)
				console.error(`[TEST-LIFECYCLE] Reason: ${reason}`)
				console.error(`[TEST-LIFECYCLE] Test duration: ${elapsed}ms (${elapsed / 1000}s)`)
				console.error(`[TEST-LIFECYCLE] Unhandled rejections: ${unhandledRejections.length}`)
				if (unhandledRejections.length > 0) {
					unhandledRejections.forEach((ur, i) => {
						console.error(`[TEST-LIFECYCLE]   Rejection ${i + 1}:`, ur.reason)
					})
				}
				console.error(`[TEST-LIFECYCLE] VS Code process exited: ${vscodeProcessExited}`)
				if (vscodeProcessExited) {
					console.error(`[TEST-LIFECYCLE]   Exit code: ${vscodeExitCode}`)
					console.error(`[TEST-LIFECYCLE]   Exit signal: ${vscodeExitSignal}`)
				}
				console.error(`[TEST-LIFECYCLE] ========================================`)

				dumpLast200Lines()
				printCheckpoints()
				restoreConsole()

				if (taskAbortedHandler) {
					api.off(RooCodeEventName.TaskAborted, taskAbortedHandler)
				}
				if (taskCompletedHandler) {
					api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
				}
				if (messageHandler) {
					api.off(RooCodeEventName.Message, messageHandler)
				}
				if (taskStartedHandler) {
					api.off(RooCodeEventName.TaskStarted, taskStartedHandler)
				}
				api.off(RooCodeEventName.TaskToolFailed, taskToolFailedHandler)

				killVsCodeProcess()
				if (cpPortForCleanup) {
					void killProcessByPort(cpPortForCleanup)
				}

				try {
					failFast.reject(new Error(`[torture-test] FAST-FAIL: ${reason}`))
				} catch {
					// Ignore double reject
				}

				assert.fail(`[torture-test] FAST-FAIL: ${reason}`)
			}
			
			// Store original console functions for later override
			const originalConsoleLogForCapture = console.log
			const originalConsoleErrorForCapture = console.error
			
			// Track consecutive failures per tool to allow retries with feedback
			const toolFailureCounts = new Map<string, number>()
			const MAX_CONSECUTIVE_TOOL_FAILURES = 5
			let lastExecutedTool: string | null = null
			
			const taskToolFailedHandler = (taskIdParam: string, tool: string, errorParam: string) => {
				// Track first error for VCR signature
				if (firstError === null) {
					firstError = { toolName: tool, error: errorParam, taskId: taskIdParam }
					const signature = normalizeErrorSignature(firstError)
					console.error(`[torture-vcr] FIRST ERROR: ${tool} - ${errorParam}`)
					console.log(`[torture-vcr] FIRST_ERROR_SIGNATURE=${signature}`)
					
					// Save signature in record mode for replay comparison
					if (process.env.ROO_VCR_MODE === "record") {
						fs.writeFile(recordErrorFile, signature, "utf-8").catch(() => {})
					}
				}
				
				// Increment failure count for this tool
				const currentCount = (toolFailureCounts.get(tool) || 0) + 1
				toolFailureCounts.set(tool, currentCount)
				
				console.log(`[TEST-LIFECYCLE] Tool failure: ${tool} (consecutive failures: ${currentCount}/${MAX_CONSECUTIVE_TOOL_FAILURES})`)
				console.log(`[TEST-LIFECYCLE] Error: ${errorParam.substring(0, 200)}${errorParam.length > 200 ? '...' : ''}`)
				
				// Only fail if we've hit the maximum consecutive failures
				if (currentCount >= MAX_CONSECUTIVE_TOOL_FAILURES) {
					console.error(`[TEST-LIFECYCLE] ========================================`)
					console.error(`[TEST-LIFECYCLE] MAXIMUM CONSECUTIVE FAILURES REACHED`)
					console.error(`[TEST-LIFECYCLE] Tool: ${tool}`)
					console.error(`[TEST-LIFECYCLE] Consecutive failures: ${currentCount}`)
					console.error(`[TEST-LIFECYCLE] Last error: ${errorParam}`)
					console.error(`[TEST-LIFECYCLE] ========================================`)
					fatalFail(`${tool} failed ${currentCount} consecutive times. Last error: ${errorParam}`)
				} else {
					// Allow retry - error feedback will be sent to LLM automatically via pushToolResult
					console.log(`[TEST-LIFECYCLE] Allowing retry (${currentCount}/${MAX_CONSECUTIVE_TOOL_FAILURES} failures). Error feedback will be sent to LLM.`)
				}
			}
			api.on(RooCodeEventName.TaskToolFailed, taskToolFailedHandler)
			
			// Gate to ensure only first terminal event wins (prevents multiple handlers from running)
			let finished = false
			
			// Create deferred promise for fast-fail mechanism
			const failFast = createDeferred<never>()
			
			// Get VS Code process handle for killing
			// NOTE: @vscode/test-electron's runTests doesn't expose ChildProcess handle
			// We use parent process PID as fallback (test runs inside VS Code extension host)
			// TODO: Modify runTest.ts to spawn VS Code manually and pass process handle via env/global
			const vscodePid = process.env.VSCODE_PID 
				? parseInt(process.env.VSCODE_PID, 10) 
				: (process.platform === "win32" ? process.ppid : null) // Use parent PID on Windows as fallback
			// vscodeProcess will be set if runTest.ts is modified to expose the ChildProcess handle
			// For now, we only use PID-based killing since @vscode/test-electron doesn't expose the process
			// When runTest.ts is modified, uncomment and use this:
			// const vscodeProcess: child_process.ChildProcess | null = (globalThis as any).__vscodeProcess || null
			const vscodeProcess: child_process.ChildProcess | null = null
			
			// Store handler references for cleanup
			let taskStartedHandler: ((taskIdParam: string) => void) | null = null
			let taskAbortedHandler: ((taskIdParam: string) => void) | null = null
			let taskCompletedHandler: ((taskIdParam: string) => void) | null = null
			let messageHandler: (({ message }: { message: any }) => void) | null = null
			
			// Fast-fail function for blocked Task#ask - called immediately when pattern detected in console
			const fastFailBlockedAsk = (askType: string, triggerLine: string) => {
				const errorMsg = `[torture-test] Blocked Task#ask in e2e mode: ${askType} (child task)`
				originalConsoleErrorForCapture(`[torture-test] FAST-FAIL: ${errorMsg}`)
				originalConsoleErrorForCapture(`[torture-test] Triggered by: ${triggerLine}`)
				fatalFail(errorMsg)
			}
			
			// Track task lifecycle events for checkpoints
			taskStartedHandler = (taskIdParam: string) => {
				if (taskIdParam === taskId) {
					checkpoint("Task started")
				}
			}
			api.on(RooCodeEventName.TaskStarted, taskStartedHandler)
			
			// Track task abortion (e.g., from LLM timeout or blocked Task#ask)
			// Note: fastFailBlockedAsk handles blocked Task#ask immediately in console capture,
			// so this handler is mainly for other abort reasons
			taskAbortedHandler = (taskIdParam: string) => {
				if (finished || taskIdParam !== taskId) {
					console.log(`[TEST-LIFECYCLE] TaskAborted event ignored: finished=${finished}, taskId match=${taskIdParam === taskId}`)
					return
				}
				const elapsed = Date.now() - testStartTime
				console.error(`[TEST-LIFECYCLE] ========================================`)
				console.error(`[TEST-LIFECYCLE] TASK ABORTED EVENT RECEIVED`)
				console.error(`[TEST-LIFECYCLE] Task ID: ${taskIdParam}`)
				console.error(`[TEST-LIFECYCLE] Test duration: ${elapsed}ms (${elapsed / 1000}s)`)
				console.error(`[TEST-LIFECYCLE] Unhandled rejections: ${unhandledRejections.length}`)
				if (unhandledRejections.length > 0) {
					unhandledRejections.forEach((ur, i) => {
						console.error(`[TEST-LIFECYCLE]   Rejection ${i + 1}:`, ur.reason)
					})
				}
				console.error(`[TEST-LIFECYCLE] VS Code process exited: ${vscodeProcessExited}`)
				if (vscodeProcessExited) {
					console.error(`[TEST-LIFECYCLE]   Exit code: ${vscodeExitCode}`)
					console.error(`[TEST-LIFECYCLE]   Exit signal: ${vscodeExitSignal}`)
				}
				console.error(`[TEST-LIFECYCLE] ========================================`)
				checkpoint("Task aborted")
				const allLogs = consoleBuffer.join("\n")
				if (allLogs.includes("LLM request stalled (no response/stream completion)")) {
					fatalFail("LLM request stalled (no response/stream completion)")
				}
				fatalFail("Task aborted")
			}
			api.on(RooCodeEventName.TaskAborted, taskAbortedHandler)
			
			// Track task completion
			taskCompletedHandler = (taskIdParam: string) => {
				if (finished || taskIdParam !== taskId) {
					console.log(`[TEST-LIFECYCLE] TaskCompleted event ignored: finished=${finished}, taskId match=${taskIdParam === taskId}`)
					return
				}
				// Reset all failure counts on task completion (all tools succeeded)
				toolFailureCounts.clear()
				console.log(`[TEST-LIFECYCLE] Task completed - reset all tool failure counts`)
				
				const elapsed = Date.now() - testStartTime
				console.log(`[TEST-LIFECYCLE] ========================================`)
				console.log(`[TEST-LIFECYCLE] TASK COMPLETED EVENT RECEIVED`)
				console.log(`[TEST-LIFECYCLE] Task ID: ${taskIdParam}`)
				console.log(`[TEST-LIFECYCLE] Test duration: ${elapsed}ms (${elapsed / 1000}s)`)
				console.log(`[TEST-LIFECYCLE] ========================================`)
				finished = true
				checkpoint("Task completed")
				console.log(`[torture-test] Task completed successfully`)
			}
			api.on(RooCodeEventName.TaskCompleted, taskCompletedHandler)
			
			messageHandler = ({ message }: { message: any }) => {
				const text = (message?.text ?? "").toString()
				const lowered = text.toLowerCase()
				// Fail fast on API request failure/cancel asks (subtask or parent)
				if (message.type === "ask" && (message.ask === "api_req_failed" || message.ask === "api_req_cancelled")) {
					const errorMsg = `${message.ask}`
					fatalFail(errorMsg)
					return
				}
				// Allow retries; log a single-line warning for visibility
				if (message.type === "say" && (message.say === "api_req_retry_delayed" || message.say === "api_req_retried")) {
					const warn = `[torture-test] WARN: ${message.say}`
					consoleBuffer.push(`[WARN] ${warn}`)
					originalConsoleLogForCapture(warn)
					return
				}
				// Fail fast on terminal API failures (structured say)
				if (message.type === "say" && (message.say === "api_req_failed" || message.say === "api_req_cancelled")) {
					const errorMsg = `${message.say}`
					fatalFail(errorMsg)
					return
				}
				// Fail fast on terminal API failure text surfaced in say/error messages
				if (
					lowered.includes("rate limit exceeded") ||
					lowered.includes("too many requests") ||
					lowered.includes("http 429") ||
					lowered.includes("request too large") ||
					lowered.includes("api request failed") ||
					lowered.includes("api request cancelled")
				) {
					fatalFail(text)
					return
				}
				// Track first LLM request (message with type that indicates LLM interaction)
				if (message.type === "say" && checkpoints.findIndex((cp) => cp.name === "First LLM request") === -1) {
					checkpoint("First LLM request")
				}
			}
			api.on(RooCodeEventName.Message, messageHandler)
			
			// NOW override console.log/console.error AFTER fastFailBlockedAsk and handlers are defined
			// This ensures fastFailBlockedAsk can access all handlers when called
			console.log = (...args: unknown[]) => {
				const msg = args.map(a => String(a)).join(" ")
				consoleBuffer.push(`[LOG] ${msg}`)
				originalConsoleLogForCapture.apply(console, args)
				
				// IMMEDIATE DETECTION: Check for blocked Task#ask patterns and fast-fail
				// Pattern 1: "Blocked Task#ask in e2e mode: <type> (child task)" - preferred
				const blockedAskMatch = msg.match(/Blocked Task#ask in e2e mode: (\w+)(?:\s*\(child task\))?/)
				if (blockedAskMatch && (msg.includes("(child task)") || msg.includes("waitForChildren"))) {
					const askType = blockedAskMatch[1]
					fastFailBlockedAsk(askType, msg)
					return // fastFailBlockedAsk rejects promise, no throw needed
				}
				
				// Pattern 2: "Task#ask will block -> type: <type>" - fallback
				const willBlockMatch = msg.match(/Task#ask will block -> type: (\w+)/)
				if (willBlockMatch) {
					const askType = willBlockMatch[1]
					fastFailBlockedAsk(askType, msg)
					return // fastFailBlockedAsk rejects promise, no throw needed
				}
				
				// Detect api_req_failed from console output (legacy tracking, but fast-fail takes precedence)
				if (msg.includes("Task#ask will block -> type: api_req_failed")) {
					consecutiveApiFailures++
					const provider = taskConfig.apiProvider || "unknown"
					const model = taskConfig.openRouterModelId || "unknown"
					// Extract error message if available (may be in next log line)
					const error = "API request failed"
					lastApiFailure = { provider, model, error, timestamp: Date.now() }
					
					originalConsoleErrorForCapture(`[torture-test] API failure #${consecutiveApiFailures}/${MAX_CONSECUTIVE_API_FAILURES}`)
					originalConsoleErrorForCapture(`  Provider: ${provider}`)
					originalConsoleErrorForCapture(`  Model: ${model}`)
					originalConsoleErrorForCapture(`  Error: ${error}`)
					
					if (consecutiveApiFailures >= MAX_CONSECUTIVE_API_FAILURES) {
						const sanitizedError = error.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-***REDACTED***")
						abortTask(
							`${MAX_CONSECUTIVE_API_FAILURES} consecutive API failures. ` +
							`Provider: ${provider}, Model: ${model}, Error: ${sanitizedError}`
						)
					}
				} else if (msg.includes("Task#ask will block -> type:") && !msg.includes("api_req_failed")) {
					// Reset counter on non-API failures (tool calls, etc.)
					consecutiveApiFailures = 0
				}
				
				// Track first tool call
				if (msg.includes("[Task#logToolCall]") && checkpoints.findIndex(cp => cp.name === "First tool call") === -1) {
					checkpoint("First tool call")
				}
				
				// Reset failure count when a tool executes successfully
				// When we see "[AUDIT:EXECUTED] Executing tool:", it means a tool is being executed
				// If it's a different tool than the last failed one, reset the failure count for the previous tool
				// This indicates the previous tool succeeded and LLM moved on to a different tool
				const toolExecMatch = msg.match(/\[AUDIT:EXECUTED\] Executing tool: (\w+)/)
				if (toolExecMatch) {
					const executedTool = toolExecMatch[1]
					// If a different tool is executed, reset failure count for the previous tool
					// This indicates the previous tool succeeded and LLM moved on
					if (lastExecutedTool && executedTool !== lastExecutedTool && toolFailureCounts.has(lastExecutedTool)) {
						toolFailureCounts.delete(lastExecutedTool)
						console.log(`[TEST-LIFECYCLE] Tool ${lastExecutedTool} succeeded (different tool ${executedTool} executed). Reset failure count.`)
					}
					lastExecutedTool = executedTool
				}
				
				// Track first sub-tx creation
				if (msg.includes("[createTask] child task") && checkpoints.findIndex(cp => cp.name === "First sub-tx created") === -1) {
					checkpoint("First sub-tx created")
				}
				
				// Track first merge
				if (msg.includes("Successfully merged sub-transaction") && checkpoints.findIndex(cp => cp.name === "First merge") === -1) {
					checkpoint("First merge")
				}
			}
			
			// Also capture console.error for blocked Task#ask detection
			console.error = (...args: unknown[]) => {
				const msg = args.map(a => String(a)).join(" ")
				consoleBuffer.push(`[ERR] ${msg}`)
				originalConsoleErrorForCapture.apply(console, args)
				
				// IMMEDIATE DETECTION: Check for blocked Task#ask patterns and fast-fail
				// Pattern 1: "Blocked Task#ask in e2e mode: <type> (child task)" - preferred
				const blockedAskMatch = msg.match(/Blocked Task#ask in e2e mode: (\w+)(?:\s*\(child task\))?/)
				if (blockedAskMatch && (msg.includes("(child task)") || msg.includes("waitForChildren"))) {
					const askType = blockedAskMatch[1]
					fastFailBlockedAsk(askType, msg)
					return // fastFailBlockedAsk rejects promise, no throw needed
				}
				
				// Pattern 2: "Task#ask will block -> type: <type>" - fallback
				const willBlockMatch = msg.match(/Task#ask will block -> type: (\w+)/)
				if (willBlockMatch) {
					const askType = willBlockMatch[1]
					fastFailBlockedAsk(askType, msg)
					return // fastFailBlockedAsk rejects promise, no throw needed
				}
			}

			// Ensure extension is activated before running commands
			console.log("[torture-test] Waiting for extension activation...")
			const extension = vscode.extensions.getExtension("RooVeterinaryInc.roo-cline")
			if (!extension) {
				fatalFail("Extension RooVeterinaryInc.roo-cline not found")
				return
			}
			await extension.activate()
			console.log("[torture-test] Extension activated")

			// Clean up any existing Control-Plane processes on port 8899 before starting
			console.log("[torture-test] Cleaning up any existing Control-Plane processes...")
			await killProcessByPort(8899)
			// Give it a moment to fully terminate
			await new Promise(resolve => setTimeout(resolve, 1000))
			
			// Start Control-Plane and verify it is reachable BEFORE starting task
			let cpPort = 8899
			try {
				await vscode.commands.executeCommand("roo.startControlPlaneHere")
				const storedPort = await vscode.commands.executeCommand<number>("roo.internal.getCpPort")
				if (storedPort) {
					cpPort = storedPort
				}
				cpPortForCleanup = cpPort
				await waitForPort(cpPort, 60_000)
			} catch (e) {
				fatalFail(`Control-Plane start failed: ${e instanceof Error ? e.message : String(e)}`)
			}
			try {
				await api.setCpPort(cpPort)
				console.log(`[torture-test] Control-Plane port set to ${cpPort}`)
			} catch (e) {
				fatalFail(`Control-Plane setCpPort failed: ${e instanceof Error ? e.message : String(e)}`)
			}
			checkpoint("Control-Plane connected")

			// Log auto-approval configuration at startup
			console.log(`[torture-test] AUTO-APPROVAL CONFIG:`)
			console.log(`  autoApprovalEnabled: ${taskConfig.autoApprovalEnabled}`)
			console.log(`  alwaysAllowWrite: ${taskConfig.alwaysAllowWrite}`)
			console.log(`  alwaysAllowReadOnly: ${taskConfig.alwaysAllowReadOnly}`)
			console.log(`  alwaysAllowExecute: ${taskConfig.alwaysAllowExecute}`)
			console.log(`  apiProvider: ${taskConfig.apiProvider} (validated)`)
			console.log(`  Model: ${apiModelId}`)
			console.log(`  Key present: ${!!apiKey}`)

			try {
				taskId = await api.startNewTask({
					configuration: taskConfig,
					text: prompt,
				})
			} catch (e) {
				fatalFail(`startNewTask failed: ${e instanceof Error ? e.message : String(e)}`)
			}
			checkpoint("Task created")

			// Wait for task completion with hard timeout
			// Use Promise.race to immediately fail if fastFailBlockedAsk rejects
			try {
				if (!taskId) {
					throw new Error("Task ID not set")
				}
				
				console.log(`[TEST-LIFECYCLE] Starting wait for task completion`)
				console.log(`[TEST-LIFECYCLE] Task ID: ${taskId}`)
				console.log(`[TEST-LIFECYCLE] Timeout: ${TORTURE_TIMEOUT_MS}ms`)
				
				// Set up periodic progress logging
				const progressInterval = setInterval(() => {
					const elapsed = Date.now() - testStartTime
					const remaining = TORTURE_TIMEOUT_MS - elapsed
					if (remaining > 0 && !finished) {
						console.log(`[TEST-LIFECYCLE] Progress: ${elapsed}ms elapsed, ${remaining}ms remaining (${Math.round(remaining / 1000)}s)`)
					}
				}, 30000) // Log every 30 seconds
				
				// Check if already finished before waiting
				if (finished) {
					clearInterval(progressInterval)
					console.log(`[TEST-LIFECYCLE] Task already finished before wait`)
					return // Task already aborted/completed, handlers have run
				}
				
				// Race between waitUntilCompleted and failFast.promise
				// If fastFailBlockedAsk is called, failFast.promise will reject immediately
				console.log(`[TEST-LIFECYCLE] Waiting for task completion or timeout...`)
				await Promise.race([
					waitUntilCompleted({ api, taskId, timeout: TORTURE_TIMEOUT_MS }).then(() => {
						clearInterval(progressInterval)
						const elapsed = Date.now() - testStartTime
						console.log(`[TEST-LIFECYCLE] waitUntilCompleted resolved after ${elapsed}ms`)
					}).catch((err) => {
						clearInterval(progressInterval)
						const elapsed = Date.now() - testStartTime
						console.error(`[TEST-LIFECYCLE] waitUntilCompleted rejected after ${elapsed}ms:`, err)
						throw err
					}),
					failFast.promise.then(() => {
						clearInterval(progressInterval)
						console.log(`[TEST-LIFECYCLE] failFast.promise resolved`)
					}).catch((err) => {
						clearInterval(progressInterval)
						console.error(`[TEST-LIFECYCLE] failFast.promise rejected:`, err)
						throw err
					}),
				])
				
				clearInterval(progressInterval)
				
				// Check if finished flag was set (task aborted during wait)
				if (finished) {
					console.log(`[TEST-LIFECYCLE] Task finished flag was set during wait`)
					return // TaskAborted handler already called assert.fail
				}
				
				const elapsed = Date.now() - testStartTime
				console.log(`[TEST-LIFECYCLE] Promise.race completed after ${elapsed}ms`)
				checkpoint("Task completed")
				console.log(`[torture-test] Task completed successfully`)
				printCheckpoints()
			} catch (error) {
				const elapsedError = Date.now() - testStartTime
				console.error(`[TEST-LIFECYCLE] ========================================`)
				console.error(`[TEST-LIFECYCLE] ERROR IN WAIT LOOP`)
				console.error(`[TEST-LIFECYCLE] Error:`, error)
				console.error(`[TEST-LIFECYCLE] Test duration: ${elapsedError}ms (${elapsedError / 1000}s)`)
				console.error(`[TEST-LIFECYCLE] Finished flag: ${finished}`)
				console.error(`[TEST-LIFECYCLE] Unhandled rejections: ${unhandledRejections.length}`)
				if (unhandledRejections.length > 0) {
					unhandledRejections.forEach((ur, i) => {
						console.error(`[TEST-LIFECYCLE]   Rejection ${i + 1}:`, ur.reason)
					})
				}
				console.error(`[TEST-LIFECYCLE] ========================================`)
				// Check if error is from fastFailBlockedAsk (exact format match)
				const errorMessage = error instanceof Error ? error.message : String(error)
				if (errorMessage.includes("[torture-test] Blocked Task#ask in e2e mode:")) {
					// Error from fastFailBlockedAsk - re-throw to ensure test fails
					// Console and listeners already cleaned up by fastFailBlockedAsk
					throw error
				}
				
				// If finished flag is set, TaskAborted handler already called assert.fail
				// and the test should have exited. If we're here, it's a different error.
				if (finished) {
					// TaskAborted handler should have already failed the test
					// Re-throw to ensure test fails
					throw error
				}
				
				// Check if error is due to task abortion (from waitUntilCompleted)
				if (errorMessage.includes("was aborted")) {
					// Task was aborted but handler didn't catch it - check console buffer
					const lastLogs = consoleBuffer.slice(-200).join("\n")
					
					// Detect blocked Task#ask patterns
					let askType: string | null = null
					const blockedAskMatch = lastLogs.match(/Blocked Task#ask in e2e mode: (\w+)(?:\s*\(child task\))?/)
					if (blockedAskMatch) {
						askType = blockedAskMatch[1]
					} else {
						const willBlockMatch = lastLogs.match(/Task#ask will block -> type: (\w+)/)
						if (willBlockMatch) {
							askType = willBlockMatch[1]
						}
					}
					
					if (askType) {
						dumpLast200Lines()
						printCheckpoints()
						restoreConsole()
						throw new Error(`[torture-test] Blocked Task#ask in e2e mode: ${askType} (child task)`)
					}
				}
				
				// Dump last 200 lines of output on timeout or other error
				const elapsed = Date.now() - testStartTime
				console.error(`[TEST-LIFECYCLE] ========================================`)
				console.error(`[TEST-LIFECYCLE] TIMEOUT OR ERROR IN FINALLY BLOCK`)
				console.error(`[TEST-LIFECYCLE] Test duration: ${elapsed}ms (${elapsed / 1000}s)`)
				console.error(`[TEST-LIFECYCLE] Finished flag: ${finished}`)
				console.error(`[TEST-LIFECYCLE] Unhandled rejections: ${unhandledRejections.length}`)
				if (unhandledRejections.length > 0) {
					unhandledRejections.forEach((ur, i) => {
						console.error(`[TEST-LIFECYCLE]   Rejection ${i + 1}:`, ur.reason)
					})
				}
				console.error(`[TEST-LIFECYCLE] VS Code process exited: ${vscodeProcessExited}`)
				if (vscodeProcessExited) {
					console.error(`[TEST-LIFECYCLE]   Exit code: ${vscodeExitCode}`)
					console.error(`[TEST-LIFECYCLE]   Exit signal: ${vscodeExitSignal}`)
				}
				console.error(`[TEST-LIFECYCLE] ========================================`)
				dumpLast200Lines()
				printCheckpoints()
				restoreConsole()
				const lastCp = getLastCheckpoint()
				const lastCpInfo = lastCp 
					? `Last checkpoint: ${lastCp.name} at +${lastCp.elapsedMs}ms (${Date.now() - lastCp.timestamp}ms ago)`
					: "No checkpoints recorded"
				fatalFail(
					`TIMEOUT after ${TORTURE_TIMEOUT_MS / 1000}s - task did not complete. ${lastCpInfo}. See output dump above.`
				)
			} finally {
				const elapsedFinally = Date.now() - testStartTime
				console.log(`[TEST-LIFECYCLE] ========================================`)
				console.log(`[TEST-LIFECYCLE] FINALLY BLOCK EXECUTING`)
				console.log(`[TEST-LIFECYCLE] Test duration: ${elapsedFinally}ms (${elapsedFinally / 1000}s)`)
				console.log(`[TEST-LIFECYCLE] Finished flag: ${finished}`)
				console.log(`[TEST-LIFECYCLE] ========================================`)
				restoreConsole()
				if (cpPortForCleanup) {
					await killProcessByPort(cpPortForCleanup)
				}
			}

			// Verify fixtures in record mode
			if (process.env.ROO_VCR_MODE === "record") {
				const fixtures = await fs.readdir(vcrDir, { recursive: true })
				const jsonFiles = fixtures.filter((f) => typeof f === "string" && f.endsWith(".json"))
				assert.ok(jsonFiles.length > 0, "VCR fixtures must be created in record mode")
			}

			// In replay mode, compare error signature with record mode
			if (process.env.ROO_VCR_MODE === "replay" && recordModeSignature) {
				if (firstError) {
					const replaySig = normalizeErrorSignature(firstError)
					if (recordModeSignature !== replaySig) {
						console.error(`[torture-vcr] ERROR SIGNATURE MISMATCH:`)
						console.error(`  Record: ${recordModeSignature}`)
						console.error(`  Replay: ${replaySig}`)
						assert.fail(`Error signature mismatch: record=${recordModeSignature}, replay=${replaySig}`)
					}
					console.log(`[torture-vcr] ✓ Error signatures match: ${replaySig}`)
				} else {
					// No error in replay but there was one in record mode
					console.error(`[torture-vcr] ERROR SIGNATURE MISMATCH: Record had error but replay did not`)
					console.error(`  Record: ${recordModeSignature}`)
					assert.fail(`Error signature mismatch: record had error but replay did not`)
				}
			} else if (process.env.ROO_VCR_MODE === "replay" && !recordModeSignature && firstError) {
				// Replay had error but record mode didn't save one (shouldn't happen)
				console.error(`[torture-vcr] WARNING: Replay had error but no record signature file found`)
			}
		} else {
			// Original test behavior
			const api = globalThis.api

			const messages: ClineMessage[] = []

			api.on(RooCodeEventName.Message, ({ message }) => {
				if (message.type === "say" && message.partial === false) {
					messages.push(message)
				}
			})

			const taskId = await api.startNewTask({
				configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
				text: "Hello world, what is your name? Respond with 'My name is ...'",
			})

			await waitUntilCompleted({ api, taskId })

			assert.ok(
				!!messages.find(
					({ say, text }) => (say === "completion_result" || say === "text") && text?.includes("My name is Roo"),
				),
				`Completion should include "My name is Roo"`,
			)
		}
	})
})
