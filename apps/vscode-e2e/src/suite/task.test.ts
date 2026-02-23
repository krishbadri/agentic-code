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
// Temporarily increased to 900s for recording complete successful run
const TORTURE_TIMEOUT_MS = 900_000 // 900 seconds (15 minutes) - temporarily increased for recording

// Fast-fail threshold for consecutive API failures
const MAX_CONSECUTIVE_API_FAILURES = 3

// The P1 prompt from PROMPTS.md - Add SQLite-backed persistence
const TORTURE_PROMPT = `Add SQLite-backed persistence to this repo while keeping in-memory as the default.
I should be able to switch via CLI: --store sqlite and env var TXN_TODO_DB for the path.

Requirements:
- Create a SqliteKV class that implements the KVStore interface in app/store.py
- IMPORTANT: Update make_store() function to REPLACE the "raise NotImplementedError" with "return SqliteKV(sqlite_path)" when kind="sqlite"
  - You MUST use write_to_file to rewrite app/store.py with both the SqliteKV class AND the updated make_store() function
  - The current make_store() has a stub that raises NotImplementedError - this stub MUST be removed
- Add unit tests for SQLite persistence (create tests/test_sqlite_store.py with at least 3 tests)
- Update README with usage examples

Success criteria:
- All existing tests pass
- New SQLite tests pass (at least 3 new tests)
- CLI works with --store sqlite (must NOT raise NotImplementedError)`

const stage_2_prompt = `Implement "named projects" for todos so one store can hold multiple independent todo lists. A todo belongs to a project string. Default project is "default".

Functional requirements
1) Isolation by project
- Todos must be isolated by project. Listing project A must never show items from project B.
- done/delete must only affect items within the selected project.

2) Works for both backends
- Behavior must be correct for both the in-memory backend and the sqlite backend.
- Persistence for sqlite must preserve project isolation across process restarts.

CLI requirements
- Add a global CLI option: --project <name> with default "default".
- Commands add/list/done/delete must operate within the selected project.
- Keep existing output formats unless you must change them. If you change output, keep it minimal.

Tests (this is required)
- Add new unit tests covering:
  a) project isolation in-memory
  b) project isolation in sqlite
  c) sqlite persistence across a fresh store instance (simulate restart) does not mix projects
- Do not modify existing tests except for necessary imports/fixtures if absolutely required. Prefer adding new tests only.
- All tests must pass at the end.

Checkpoint + rollback protocol
Complete the work in three transaction boundaries with checkpoints.
IMPORTANT: save_checkpoint and rollback_to_checkpoint are XML tools, NOT shell commands.
Do NOT run them with execute_command. Use them as XML tool calls like this:

To save a checkpoint:
<save_checkpoint>
<name>C1_tests</name>
</save_checkpoint>

To rollback to a checkpoint:
<rollback_to_checkpoint>
<checkpoint_name>C1_tests</checkpoint_name>
</rollback_to_checkpoint>

Do NOT use git reset, git restore, or any git commands for rollback.

Boundary 1: tests/spec
- Make any interface/type updates needed for project scoping.
- Add the new tests first (they should fail before implementation).
- Run tests to confirm they fail for the expected reason.
- Save checkpoint C1_tests using the save_checkpoint XML tool shown above.

Rollback drill (mandatory)
- After C1_tests checkpoint, create ROLLBACK_SENTINEL.txt at repo root.
- Make a small intentional incorrect code change to force test failure.
- Run tests and confirm failure.
- Roll back to C1_tests using the rollback_to_checkpoint XML tool shown above.
- Confirm ROLLBACK_SENTINEL.txt no longer exists and repo state matches C1_tests.

Boundary 2: implementation
- Implement project scoping end-to-end (store keys/schema, service logic, CLI wiring).
- Ensure both backends pass all tests.
- Save checkpoint C2_impl using the save_checkpoint XML tool.

Boundary 3: docs/cleanup
- Update README with examples (default project, named project, sqlite + project usage).
- Any small cleanup required (formatting/refactor) with no behavior change.
- Run full tests again.
- Save checkpoint C3_docs using the save_checkpoint XML tool.

Completion output
- The exact commands you ran for tests
- Confirmation that the rollback drill removed ROLLBACK_SENTINEL.txt
- A concise summary of code changes (files touched and what changed)
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
		const msg = args.map((a) => String(a)).join(" ")
		consoleBuffer.push(`[LOG] ${msg}`)
		originalConsoleLog.apply(console, args)
	}
	console.error = (...args: unknown[]) => {
		const msg = args.map((a) => String(a)).join(" ")
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
		// IMPORTANT: netstat output includes both LISTENERS and CLIENT connections.
		// We MUST ONLY kill the LISTENING process bound to the local port, otherwise we can kill
		// the VS Code extension host itself (it may have an ESTABLISHED connection to the port).
		child_process.exec(`netstat -ano | findstr :${port}`, (error, stdout) => {
			if (error || !stdout) {
				resolve()
				return
			}
			const pids = new Set<number>()
			for (const line of stdout.split(/\r?\n/)) {
				const trimmed = line.trim()
				if (!trimmed) continue

				const parts = trimmed.split(/\s+/)
				// Typical Windows netstat formats:
				// TCP  0.0.0.0:8899     0.0.0.0:0        LISTENING       1234
				// TCP  [::]:8899        [::]:0           LISTENING       1234
				// TCP  127.0.0.1:12345  127.0.0.1:8899   ESTABLISHED     5678
				const local = parts[1]
				const state = parts[3]
				if (!local || !state) continue

				// Only kill the listener bound to the local port.
				if (!local.endsWith(`:${port}`)) continue
				if (state.toUpperCase() !== "LISTENING") continue

				const pidStr = parts[parts.length - 1]
				const pid = Number(pidStr)
				if (Number.isFinite(pid)) pids.add(pid)
			}
			if (pids.size === 0) {
				resolve()
				return
			}
			const killCmd = `taskkill /T /F ${Array.from(pids)
				.map((pid) => `/PID ${pid}`)
				.join(" ")}`
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
			process.on("unhandledRejection", (reason, promise) => {
				console.error(`[TEST-LIFECYCLE] ========================================`)
				console.error(`[TEST-LIFECYCLE] UNHANDLED REJECTION DETECTED!`)
				console.error(`[TEST-LIFECYCLE] Reason:`, reason)
				console.error(`[TEST-LIFECYCLE] Promise:`, promise)
				console.error(`[TEST-LIFECYCLE] Test duration: ${Date.now() - testStartTime}ms`)
				console.error(`[TEST-LIFECYCLE] ========================================`)
				unhandledRejections.push({ reason, promise })
			})

			// Track uncaught exceptions
			process.on("uncaughtException", (error) => {
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
				const correctFileExists = await fs
					.access(correctFilePath)
					.then(() => true)
					.catch(() => false)
				const wrongFileExists = await fs
					.access(wrongFilePath)
					.then(() => true)
					.catch(() => false)

				// Case-insensitive comparison on Windows2222
				const pathsMatch =
					process.platform === "win32"
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

			// Reset test repo to clean state before starting
			// This ensures we start from an unimplemented state
			console.log(`[torture-test] Resetting test repo to clean state...`)
			try {
				const repoPath = expectedWorkspace || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
				if (repoPath) {
					// Always reset to a clean upstream ref first for deterministic torture runs.
					// IMPORTANT: Do NOT try to infer cleanliness from file contents (e.g. "NotImplementedError"),
					// because the baseline file may mention that string in comments/docstrings even after implementation,
					// which can cause us to incorrectly "reset" to HEAD and keep a dirty repo.
					const storePyPath = path.join(repoPath, "app", "store.py")
					const resetTargets = ["origin/main", "origin/master", "HEAD"]
					let resetSucceeded = false
					let lastResetError: unknown = null
					for (const target of resetTargets) {
						await new Promise<void>((resolve) => {
							child_process.exec(`git reset --hard ${target}`, { cwd: repoPath }, (err) => {
								if (err) {
									lastResetError = err
									console.warn(`[torture-test] git reset failed for ${target}: ${String(err)}`)
									resolve()
									return
								}
								resetSucceeded = true
								console.log(`[torture-test] ✓ git reset --hard ${target}`)
								resolve()
							})
						})
						if (resetSucceeded) break
					}
					if (!resetSucceeded) {
						throw new Error(
							`git reset failed for all targets (${resetTargets.join(", ")}): ${String(lastResetError)}`,
						)
					}

					// Clean untracked files
					await new Promise<void>((resolve, reject) => {
						child_process.exec("git clean -fdx -e .cp", { cwd: repoPath }, (err) => {
							if (err) {
								console.warn(`[torture-test] git clean warning: ${err.message}`)
							}
							resolve()
						})
					})

					// Verify the repo is in clean state (SqliteKV should NOT be implemented)
					try {
						const storeContent = await fs.readFile(storePyPath, "utf-8")
						if (storeContent.includes("class SqliteKV") && !storeContent.includes("NotImplementedError")) {
							console.error(
								`[torture-test] ERROR: Repo still contains SqliteKV implementation after reset!`,
							)
							console.error(`[torture-test] This means the implementation was committed to the repo.`)
							console.error(`[torture-test] Please ensure the test repo starts with NotImplementedError.`)
							assert.fail("Test repo must start with unimplemented SQLite backend")
						}
					} catch (e) {
						// File doesn't exist, that's fine - it will be created
					}

					console.log(`[torture-test] ✓ Test repo reset to clean state`)
				}
			} catch (e) {
				console.error(`[torture-test] Failed to reset test repo: ${e}`)
				assert.fail(`Failed to reset test repo: ${e}`)
			}
			checkpoint("Repo reset")

			const api = globalThis.api
			let cpPortForCleanup: number | null = null
			const useStage1 = process.env.TEST_TORTURE_STAGE === "1"

			// Determine provider dynamically.
			// Can be explicitly set via TEST_API_PROVIDER env var, otherwise uses priority:
			// GEMINI_API_KEY > OPENROUTER_API_KEY > OPENAI_API_KEY > settings
			let apiProvider = "openai-native"
			let apiKey: string | undefined
			let apiModelId = "gpt-4o-mini" // Use widely-available, stable model
			const config = vscode.workspace.getConfiguration("roo-cline")
			const openRouterModel = config.get<string>("openRouterModelId") || "openai/gpt-oss-120b"

			const isTortureTest = process.env.TEST_TORTURE_REPO === "1"

			// Explicit provider override
			const explicitProvider = process.env.TEST_API_PROVIDER

			if (explicitProvider === "gemini" && process.env.GEMINI_API_KEY) {
				apiProvider = "gemini"
				apiKey = process.env.GEMINI_API_KEY
				apiModelId = "gemini-2.0-flash-exp"
			} else if (explicitProvider === "openrouter" && process.env.OPENROUTER_API_KEY) {
				apiProvider = "openrouter"
				apiKey = process.env.OPENROUTER_API_KEY
				apiModelId = openRouterModel
			} else if (explicitProvider === "openai-native" && process.env.OPENAI_API_KEY) {
				apiProvider = "openai-native"
				apiKey = process.env.OPENAI_API_KEY
				apiModelId = "gpt-4o-mini"
			} else if (!explicitProvider) {
				// Auto-detect based on priority
				// TORTURE TEST MODE: Prefer OpenAI for reliability and cost
				if (isTortureTest) {
					// Fail fast if OpenAI key is missing in torture test mode
					if (!process.env.OPENAI_API_KEY) {
						const error =
							`[torture-test] FAST-FAIL: OPENAI_API_KEY is required for torture tests. ` +
							`Set OPENAI_API_KEY in ../../.env or export it. ` +
							`To use a different provider, set TEST_API_PROVIDER=gemini or TEST_API_PROVIDER=openrouter`
						console.error(error)
						throw new Error(error)
					}
					apiProvider = "openai-native"
					apiKey = process.env.OPENAI_API_KEY
					apiModelId = "gpt-4o-mini"
					console.log(`[torture-test] Using OpenAI (preferred for torture tests)`)
				} else {
					// NON-TORTURE MODE: Keep original priority (Gemini → OpenRouter → OpenAI)
					if (process.env.GEMINI_API_KEY) {
						apiProvider = "gemini"
						apiKey = process.env.GEMINI_API_KEY
						apiModelId = "gemini-2.0-flash-exp"
					} else if (process.env.OPENROUTER_API_KEY) {
						apiProvider = "openrouter"
						apiKey = process.env.OPENROUTER_API_KEY
						apiModelId = openRouterModel
					} else if (process.env.OPENAI_API_KEY) {
						apiProvider = "openai-native"
						apiKey = process.env.OPENAI_API_KEY
						apiModelId = "gpt-4o-mini"
					}
				}
			} else {
				const provider = config.get<string>("apiProvider")
				if (provider) {
					apiProvider = provider
					if (apiProvider === "openai-native") {
						apiKey = config.get<string>("openAiNativeApiKey")
						apiModelId = config.get<string>("apiModelId") || "gpt-4o-mini"
					} else if (apiProvider === "openrouter") {
						apiKey = config.get<string>("openRouterApiKey")
						apiModelId = config.get<string>("openRouterModelId") || "openai/gpt-oss-120b"
					} else if (apiProvider === "gemini") {
						apiKey = config.get<string>("geminiApiKey")
						apiModelId = config.get<string>("geminiModelId") || "gemini-2.0-flash-exp"
					}
				}
			}

			// --------------------------------------------------------------------
			// TORTURE VCR POLICY
			// - Stage 1 runs in REPLAY by default (deterministic, no live network)
			// - CI should fail if any live OpenAI call happens (replay mode + lazy VCR wrappers enforce this)
			// - Developers can opt into ROO_VCR_MODE=record to seed/update cassettes
			// --------------------------------------------------------------------
			if (useStage1) {
				const repoRoot = path.resolve(__dirname, "../../../..")
				const defaultStage1VcrDir = path.join(repoRoot, "apps", "vscode-e2e", "vcr_torture_stage1")

				if (!process.env.ROO_VCR_MODE) {
					process.env.ROO_VCR_MODE = "replay"
				}
				if (!process.env.ROO_VCR_DIR) {
					process.env.ROO_VCR_DIR = defaultStage1VcrDir
				}

				// Force a single deterministic provider+model for VCR runs.
				// This avoids accidental drift from user settings (e.g. openrouter) and ensures replay finds the cassette.
				const vcrMode = process.env.ROO_VCR_MODE
				if (vcrMode === "record" || vcrMode === "replay") {
					apiProvider = "openai-native"
					// Use widely-available stable model for reliable tool use.
					// Replay will be deterministic and fast regardless of model choice.
					apiModelId = "gpt-4o-mini"
					// Use real key if present; replay doesn't need a real secret but provider code may require non-empty string.
					apiKey = process.env.OPENAI_API_KEY || apiKey || "vcr-replay"
				}

				console.log(`[torture-test] VCR Mode: ${process.env.ROO_VCR_MODE}`)
				console.log(`[torture-test] VCR Dir: ${process.env.ROO_VCR_DIR}`)
				console.log(`[torture-test] VCR Provider override: ${apiProvider} / ${apiModelId}`)
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
			const sanitizedKey =
				(apiKey?.length || 0) > 12
					? `${apiKey!.substring(0, 8)}...${apiKey!.substring(apiKey!.length - 4)}`
					: "***REDACTED***"
			console.log(`  API Key (sanitized): ${sanitizedKey}`)

			// Prompt selection: TEST_TORTURE_STAGE=1 → TORTURE_PROMPT (SQLite); otherwise → stage_2_prompt (named projects)
			const prompt = useStage1 ? TORTURE_PROMPT : stage_2_prompt
			console.log(`[torture-test] Prompt: ${useStage1 ? "stage 1 (SQLite)" : "stage 2 (named projects)"}`)

			// Ensure VCR dir exists (even in replay, so signature files can be read)
			const vcrDir = process.env.ROO_VCR_DIR || path.join(os.tmpdir(), `vcr-torture-${Date.now()}`)
			await fs.mkdir(vcrDir, { recursive: true })

			// Stage 1 uses VCR for determinism; prefer reliability over throttling avoidance.

			// Enable planner mode for Stage 1 and Stage 2 - spec requires task decomposition into subtasks
			// The planner breaks the main task into sub-transactions that are executed and merged
			try {
				const cfg = vscode.workspace.getConfiguration()
				await cfg.update("roo.experimental.plannerMode", true, vscode.ConfigurationTarget.Global)
				await cfg.update("roo-cline.experimental.plannerMode", true, vscode.ConfigurationTarget.Global)
				await cfg.update("roo.experimental.transactionalMode", true, vscode.ConfigurationTarget.Global)
				await cfg.update("roo-cline.experimental.transactionalMode", true, vscode.ConfigurationTarget.Global)
				console.log(
					`[torture-test] Stage ${useStage1 ? 1 : 2}: planner + transactional mode ENABLED (spec requirement)`,
				)
			} catch (e) {
				console.warn(`[torture-test] Failed to enable planner/transactional mode: ${e}`)
			}

			// Track subtask metrics for Stage 1 verification
			let subtasksCreated = 0
			let subtasksCompleted = 0
			const subtaskIds: string[] = []
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
				enableCheckpoints: true, // Enable checkpoint/rollback tools for Stage 2 rollback drill
				// Use dynamic provider
				apiProvider: apiProvider as any,
				openAiNativeApiKey: apiProvider === "openai-native" ? apiKey : undefined,
				openRouterApiKey: apiProvider === "openrouter" ? apiKey : undefined,
				geminiApiKey: apiProvider === "gemini" ? apiKey : undefined,
				apiModelId: apiProvider === "openai-native" ? apiModelId : undefined,
				openRouterModelId: apiProvider === "openrouter" ? apiModelId : undefined,
				geminiModelId: apiProvider === "gemini" ? apiModelId : undefined,
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
				// IMPORTANT: We must be able to fail even after the task has "completed".
				// Stage 1 hard-gate verification runs after TaskCompleted and must still be able to fail the test.
				if (finished) {
					assert.fail(`[torture-test] FAST-FAIL: ${reason}`)
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

				console.log(
					`[TEST-LIFECYCLE] Tool failure: ${tool} (consecutive failures: ${currentCount}/${MAX_CONSECUTIVE_TOOL_FAILURES})`,
				)
				console.log(
					`[TEST-LIFECYCLE] Error: ${errorParam.substring(0, 200)}${errorParam.length > 200 ? "..." : ""}`,
				)

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
					console.log(
						`[TEST-LIFECYCLE] Allowing retry (${currentCount}/${MAX_CONSECUTIVE_TOOL_FAILURES} failures). Error feedback will be sent to LLM.`,
					)
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
				: process.platform === "win32"
					? process.ppid
					: null // Use parent PID on Windows as fallback
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
					console.log(
						`[TEST-LIFECYCLE] TaskAborted event ignored: finished=${finished}, taskId match=${taskIdParam === taskId}`,
					)
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
					console.log(
						`[TEST-LIFECYCLE] TaskCompleted event ignored: finished=${finished}, taskId match=${taskIdParam === taskId}`,
					)
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
				if (
					message.type === "ask" &&
					(message.ask === "api_req_failed" || message.ask === "api_req_cancelled")
				) {
					const errorMsg = `${message.ask}`
					fatalFail(errorMsg)
					return
				}
				// Allow retries; log a single-line warning for visibility
				if (
					message.type === "say" &&
					(message.say === "api_req_retry_delayed" || message.say === "api_req_retried")
				) {
					const warn = `[torture-test] WARN: ${message.say}`
					consoleBuffer.push(`[WARN] ${warn}`)
					originalConsoleLogForCapture(warn)
					return
				}
				// Fail fast on terminal API failures (structured say)
				if (
					message.type === "say" &&
					(message.say === "api_req_failed" || message.say === "api_req_cancelled")
				) {
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
				const msg = args.map((a) => String(a)).join(" ")
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

					originalConsoleErrorForCapture(
						`[torture-test] API failure #${consecutiveApiFailures}/${MAX_CONSECUTIVE_API_FAILURES}`,
					)
					originalConsoleErrorForCapture(`  Provider: ${provider}`)
					originalConsoleErrorForCapture(`  Model: ${model}`)
					originalConsoleErrorForCapture(`  Error: ${error}`)

					if (consecutiveApiFailures >= MAX_CONSECUTIVE_API_FAILURES) {
						const sanitizedError = error.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-***REDACTED***")
						abortTask(
							`${MAX_CONSECUTIVE_API_FAILURES} consecutive API failures. ` +
								`Provider: ${provider}, Model: ${model}, Error: ${sanitizedError}`,
						)
					}
				} else if (msg.includes("Task#ask will block -> type:") && !msg.includes("api_req_failed")) {
					// Reset counter on non-API failures (tool calls, etc.)
					consecutiveApiFailures = 0
				}

				// Track first tool call
				if (
					msg.includes("[Task#logToolCall]") &&
					checkpoints.findIndex((cp) => cp.name === "First tool call") === -1
				) {
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
					if (
						lastExecutedTool &&
						executedTool !== lastExecutedTool &&
						toolFailureCounts.has(lastExecutedTool)
					) {
						toolFailureCounts.delete(lastExecutedTool)
						console.log(
							`[TEST-LIFECYCLE] Tool ${lastExecutedTool} succeeded (different tool ${executedTool} executed). Reset failure count.`,
						)
					}
					lastExecutedTool = executedTool
				}

				// Track subtask creation
				if (msg.includes("[createTask] child task")) {
					subtasksCreated++
					// Extract task ID if available
					const childIdMatch = msg.match(/child task ([a-f0-9-]+)/)
					if (childIdMatch) {
						subtaskIds.push(childIdMatch[1])
					}
					console.log(`[torture-test] Subtask #${subtasksCreated} created`)
					if (checkpoints.findIndex((cp) => cp.name === "First sub-tx created") === -1) {
						checkpoint("First sub-tx created")
					}
				}

				// Track subtask completion
				if (msg.includes("Successfully merged sub-transaction") || msg.includes("child task completed")) {
					subtasksCompleted++
					console.log(`[torture-test] Subtask #${subtasksCompleted} completed`)
					if (checkpoints.findIndex((cp) => cp.name === "First merge") === -1) {
						checkpoint("First merge")
					}
				}
			}

			// Also capture console.error for blocked Task#ask detection
			console.error = (...args: unknown[]) => {
				const msg = args.map((a) => String(a)).join(" ")
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
			await new Promise((resolve) => setTimeout(resolve, 1000))

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
						console.log(
							`[TEST-LIFECYCLE] Progress: ${elapsed}ms elapsed, ${remaining}ms remaining (${Math.round(remaining / 1000)}s)`,
						)
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
					waitUntilCompleted({ api, taskId, timeout: TORTURE_TIMEOUT_MS })
						.then(() => {
							clearInterval(progressInterval)
							const elapsed = Date.now() - testStartTime
							console.log(`[TEST-LIFECYCLE] waitUntilCompleted resolved after ${elapsed}ms`)
						})
						.catch((err) => {
							clearInterval(progressInterval)
							const elapsed = Date.now() - testStartTime
							console.error(`[TEST-LIFECYCLE] waitUntilCompleted rejected after ${elapsed}ms:`, err)
							throw err
						}),
					failFast.promise
						.then(() => {
							clearInterval(progressInterval)
							console.log(`[TEST-LIFECYCLE] failFast.promise resolved`)
						})
						.catch((err) => {
							clearInterval(progressInterval)
							console.error(`[TEST-LIFECYCLE] failFast.promise rejected:`, err)
							throw err
						}),
				])

				clearInterval(progressInterval)

				const elapsed = Date.now() - testStartTime
				console.log(`[TEST-LIFECYCLE] Promise.race completed after ${elapsed}ms`)
				console.log(`[TEST-LIFECYCLE] Task finished flag was set during wait: ${finished}`)

				// Task completed successfully (either via event or Promise.race)
				checkpoint("Task completed")
				console.log(`[torture-test] Task completed successfully`)
				printCheckpoints()

				// === STAGE 1 VERIFICATION (HARD GATE) ===
				// This is a HARD GATE - the test MUST fail if any of these conditions are not met.
				// Task completion does NOT mean success - all requirements must be verified.
				if (useStage1) {
					const workspaceRoot =
						process.env.TEST_TORTURE_REPO_WORKSPACE || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
					if (!workspaceRoot) {
						fatalFail("STAGE 1 HARD GATE FAILED: Cannot verify - no repo path")
						return
					}

					// If planner/Control-Plane transactional mode is in use, edits may land in a tx worktree under `.cp/worktrees/`.
					// The workspace root stays the original repo, so verification must read/run from the active tx worktree.
					let repoPath = workspaceRoot
					try {
						const txIdRaw = await vscode.commands.executeCommand<string>("roo.internal.getCurrentTxId")
						const txId = (txIdRaw || "").trim()
						if (txId) {
							const txDirName = txId.startsWith("tx_") ? txId : `tx_${txId}`
							const txWorktree = path.join(workspaceRoot, ".cp", "worktrees", txDirName)
							const exists = await fs
								.access(txWorktree)
								.then(() => true)
								.catch(() => false)
							if (exists) {
								console.log(
									`[torture-test] Detected active Control-Plane transaction: ${txId}. ` +
										`Using tx worktree for verification: ${txWorktree}`,
								)
								repoPath = txWorktree
							} else {
								console.log(
									`[torture-test] Active Control-Plane transaction detected (${txId}) but worktree not found at ` +
										`${txWorktree}. Verifying from workspace root instead.`,
								)
							}
						}
					} catch (e) {
						// Best-effort only; fall back to workspaceRoot
						console.log(`[torture-test] WARN: Failed to resolve tx worktree for verification: ${String(e)}`)
					}

					console.log(`[torture-test] ========================================`)
					console.log(`[torture-test] STAGE 1 VERIFICATION (HARD GATE)`)
					console.log(`[torture-test] ========================================`)
					console.log(`[torture-test] Repo path: ${repoPath}`)

					const failures: string[] = []

					// GATE 1: SqliteKV class must exist in app/store.py
					console.log(`[torture-test] GATE 1: Checking SqliteKV class exists in app/store.py...`)
					const storePyPath = path.join(repoPath, "app/store.py")
					let storePyContent = ""
					try {
						storePyContent = await fs.readFile(storePyPath, "utf-8")
					} catch (e) {
						failures.push(`GATE 1 FAILED: app/store.py does not exist or cannot be read`)
					}
					if (storePyContent && !storePyContent.includes("class SqliteKV")) {
						failures.push(`GATE 1 FAILED: class SqliteKV not found in app/store.py`)
					} else if (storePyContent) {
						console.log(`[torture-test] ✓ GATE 1 PASSED: class SqliteKV exists in app/store.py`)
					}

					// GATE 2: make_store(kind="sqlite") must return SqliteKV (check the function)
					console.log(`[torture-test] GATE 2: Checking make_store() returns SqliteKV for kind="sqlite"...`)
					if (storePyContent) {
						// Check that make_store handles kind="sqlite" and returns SqliteKV
						const hasSqliteCase =
							storePyContent.includes('kind == "sqlite"') ||
							storePyContent.includes("kind == 'sqlite'") ||
							storePyContent.includes('kind.lower() == "sqlite"') ||
							storePyContent.includes("kind.lower() == 'sqlite'")

						// Must have explicit "return SqliteKV" - not just SqliteKV( which could be in class definition
						const returnsSqliteKV = storePyContent.includes("return SqliteKV")

						// CRITICAL: Check that NotImplementedError is NOT still raised for sqlite case.
						// The original stub has "raise NotImplementedError" in the sqlite branch.
						// If this is still present, the implementation is incomplete even if SqliteKV class exists.
						const stillHasNotImplemented = storePyContent.includes(
							'raise NotImplementedError("SQLite backend not yet implemented")',
						)

						if (!hasSqliteCase) {
							failures.push(`GATE 2 FAILED: make_store() does not handle kind="sqlite"`)
						} else if (stillHasNotImplemented) {
							failures.push(
								`GATE 2 FAILED: make_store() still raises NotImplementedError for sqlite - the function was not updated to return SqliteKV`,
							)
						} else if (!returnsSqliteKV) {
							failures.push(
								`GATE 2 FAILED: make_store() does not have "return SqliteKV" - the function must explicitly return the SqliteKV instance`,
							)
						} else {
							console.log(
								`[torture-test] ✓ GATE 2 PASSED: make_store() returns SqliteKV for kind="sqlite"`,
							)
						}
					}

					// GATE 3: New SQLite test file must exist
					console.log(`[torture-test] GATE 3: Checking for new SQLite test file...`)
					const possibleTestFiles = [
						"tests/test_sqlite_store.py",
						"tests/test_sqlite.py",
						"tests/test_sqlite_kv.py",
						"tests/test_store_sqlite.py",
					]
					let foundSqliteTestFile: string | null = null
					for (const testFile of possibleTestFiles) {
						const testPath = path.join(repoPath, testFile)
						const exists = await fs
							.access(testPath)
							.then(() => true)
							.catch(() => false)
						if (exists) {
							foundSqliteTestFile = testFile
							break
						}
					}
					// Also check if test_basic.py has new SQLite tests
					const testBasicPath = path.join(repoPath, "tests/test_basic.py")
					let testBasicContent = ""
					try {
						testBasicContent = await fs.readFile(testBasicPath, "utf-8")
					} catch (e) {
						/* ignore */
					}
					const hasSqliteTestInBasic =
						testBasicContent.includes("test_sqlite") &&
						!testBasicContent.includes("test_sqlite_not_implemented")

					if (!foundSqliteTestFile && !hasSqliteTestInBasic) {
						failures.push(
							`GATE 3 FAILED: No new SQLite test file found (checked: ${possibleTestFiles.join(", ")}) and no new sqlite tests in test_basic.py`,
						)
					} else {
						const location = foundSqliteTestFile || "tests/test_basic.py"
						console.log(`[torture-test] ✓ GATE 3 PASSED: SQLite tests found in ${location}`)
					}

					// GATE 4: pytest must pass with SQLite persistence tests running
					console.log(`[torture-test] GATE 4: Running pytest to verify SQLite persistence tests pass...`)
					const pytestResult = await new Promise<{
						passed: boolean
						output: string
						testCount: number
						sqliteTestsRan: boolean
					}>((resolve) => {
						child_process.exec(
							"python -m pytest -v",
							{ cwd: repoPath, timeout: 120000 },
							(err, stdout, stderr) => {
								const output = stdout + stderr
								console.log(`[torture-test] pytest output:\n${output}`)

								// Parse test results
								const passedMatch = output.match(/(\d+) passed/)
								const failedMatch = output.match(/(\d+) failed/)
								const testCount = passedMatch ? parseInt(passedMatch[1], 10) : 0
								const failedCount = failedMatch ? parseInt(failedMatch[1], 10) : 0

								// Check if any SQLite-related tests ran (not just the "not_implemented" stub)
								const sqliteTestsRan =
									(output.includes("test_sqlite") &&
										!output.match(/test_sqlite.*PASSED.*\[.*100%\]/)) || // not just the single stub test
									testCount > 5 // more than the original 5 tests

								resolve({
									passed: err === null && failedCount === 0 && testCount > 0,
									output,
									testCount,
									sqliteTestsRan,
								})
							},
						)
					})

					if (!pytestResult.passed) {
						failures.push(`GATE 4 FAILED: pytest failed - ${pytestResult.output.slice(-500)}`)
					} else if (!pytestResult.sqliteTestsRan && pytestResult.testCount <= 5) {
						failures.push(
							`GATE 4 FAILED: Only ${pytestResult.testCount} tests passed - no new SQLite tests were added (original repo has 5 tests)`,
						)
					} else {
						console.log(
							`[torture-test] ✓ GATE 4 PASSED: pytest passed with ${pytestResult.testCount} tests`,
						)
					}

					// GATE 5: CLI --store sqlite must work (quick functional test)
					console.log(`[torture-test] GATE 5: Testing CLI --store sqlite...`)
					const cliResult = await new Promise<{ passed: boolean; output: string }>((resolve) => {
						// Create a temp db path and test basic CLI functionality
						const tempDbPath = path.join(repoPath, ".test_cli_sqlite.db")
						child_process.exec(
							`python -m app.cli --store sqlite add "CLI test item" && python -m app.cli --store sqlite list`,
							{
								cwd: repoPath,
								timeout: 30000,
								env: { ...process.env, TXN_TODO_DB: tempDbPath },
							},
							(err, stdout, stderr) => {
								const output = stdout + stderr
								// Clean up temp db
								fs.unlink(tempDbPath).catch(() => {})
								fs.unlink(tempDbPath + "-journal").catch(() => {})
								fs.unlink(tempDbPath + "-wal").catch(() => {})
								fs.unlink(tempDbPath + "-shm").catch(() => {})

								// Check if CLI worked (should show the added item or not error out completely)
								const passed =
									err === null ||
									output.includes("CLI test item") ||
									!output.includes("NotImplementedError")
								resolve({ passed, output })
							},
						)
					})

					if (!cliResult.passed) {
						failures.push(
							`GATE 5 FAILED: CLI --store sqlite did not work. Output (tail): ${cliResult.output.slice(-200)}`,
						)
					} else {
						console.log(`[torture-test] ✓ GATE 5 PASSED: CLI --store sqlite works`)
					}

					// FINAL VERDICT
					console.log(`[torture-test] ========================================`)
					if (failures.length > 0) {
						console.error(`[torture-test] STAGE 1 VERIFICATION FAILED`)
						console.error(`[torture-test] ${failures.length} gate(s) failed:`)
						failures.forEach((f, i) => console.error(`[torture-test]   ${i + 1}. ${f}`))
						console.error(`[torture-test] ========================================`)
						fatalFail(`STAGE 1 HARD GATE FAILED: ${failures.join("; ")}`)
						return
					}

					console.log(`[torture-test] ✓ ALL STAGE 1 GATES PASSED`)
					console.log(`[torture-test] - SqliteKV class exists`)
					console.log(`[torture-test] - make_store() returns SqliteKV for sqlite`)
					console.log(`[torture-test] - SQLite tests exist`)
					console.log(`[torture-test] - All ${pytestResult.testCount} tests pass`)
					console.log(`[torture-test] ========================================`)
					console.log(`[torture-test] STAGE 1 VERIFICATION PASSED`)
					console.log(`[torture-test] ========================================`)
				}
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
					`TIMEOUT after ${TORTURE_TIMEOUT_MS / 1000}s - task did not complete. ${lastCpInfo}. See output dump above.`,
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
					({ say, text }) =>
						(say === "completion_result" || say === "text") && text?.includes("My name is Roo"),
				),
				`Completion should include "My name is Roo"`,
			)
		}
	})
})
