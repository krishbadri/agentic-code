import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import * as fsSync from "fs"

import { runTests } from "@vscode/test-electron"

// Create a synchronous logger that writes to file immediately (no buffering)
// __dirname in compiled output is apps/vscode-e2e/out, so we go up one level to apps/vscode-e2e/
const LOG_FILE = path.join(__dirname, '../runner-lifecycle.log')
function logSync(message: string) {
	const timestamp = new Date().toISOString()
	const line = `[${timestamp}] ${message}\n`
	// Write synchronously to ensure it's flushed immediately
	fsSync.appendFileSync(LOG_FILE, line, 'utf-8')
	console.error(message) // Also log to console
}

// Global error handlers to catch unhandled rejections/exceptions in the test runner process
// These handlers run BEFORE runTests() spawns VS Code, so they catch errors in the runner itself
const unhandledRejections: Array<{ reason: unknown; promise: Promise<unknown>; timestamp: number }> = []
const uncaughtExceptions: Array<{ error: Error; timestamp: number }> = []

process.on('unhandledRejection', (reason, promise) => {
	const timestamp = Date.now()
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	logSync(`[RUN-TEST-LIFECYCLE] UNHANDLED REJECTION IN TEST RUNNER PROCESS`)
	logSync(`[RUN-TEST-LIFECYCLE] Timestamp: ${new Date(timestamp).toISOString()}`)
	logSync(`[RUN-TEST-LIFECYCLE] Reason: ${reason instanceof Error ? reason.message : String(reason)}`)
	if (reason instanceof Error && reason.stack) {
		logSync(`[RUN-TEST-LIFECYCLE] Stack: ${reason.stack}`)
	}
	logSync(`[RUN-TEST-LIFECYCLE] Process PID: ${process.pid}`)
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	unhandledRejections.push({ reason, promise, timestamp })
})

process.on('uncaughtException', (error) => {
	const timestamp = Date.now()
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	logSync(`[RUN-TEST-LIFECYCLE] UNCAUGHT EXCEPTION IN TEST RUNNER PROCESS`)
	logSync(`[RUN-TEST-LIFECYCLE] Timestamp: ${new Date(timestamp).toISOString()}`)
	logSync(`[RUN-TEST-LIFECYCLE] Error: ${error.message}`)
	logSync(`[RUN-TEST-LIFECYCLE] Stack: ${error.stack || 'NO STACK'}`)
	logSync(`[RUN-TEST-LIFECYCLE] Process PID: ${process.pid}`)
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	uncaughtExceptions.push({ error, timestamp })
	// Don't exit immediately - let the error propagate to the try-catch
})

process.on('exit', (code) => {
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	logSync(`[RUN-TEST-LIFECYCLE] PROCESS EXITING`)
	logSync(`[RUN-TEST-LIFECYCLE] Exit code: ${code}`)
	logSync(`[RUN-TEST-LIFECYCLE] Unhandled rejections: ${unhandledRejections.length}`)
	if (unhandledRejections.length > 0) {
		unhandledRejections.forEach((ur, i) => {
			logSync(`[RUN-TEST-LIFECYCLE]   Rejection ${i + 1} (${new Date(ur.timestamp).toISOString()}): ${ur.reason instanceof Error ? ur.reason.message : String(ur.reason)}`)
		})
	}
	logSync(`[RUN-TEST-LIFECYCLE] Uncaught exceptions: ${uncaughtExceptions.length}`)
	if (uncaughtExceptions.length > 0) {
		uncaughtExceptions.forEach((ue, i) => {
			logSync(`[RUN-TEST-LIFECYCLE]   Exception ${i + 1} (${new Date(ue.timestamp).toISOString()}): ${ue.error.message}`)
			logSync(`[RUN-TEST-LIFECYCLE]   Stack: ${ue.error.stack || 'NO STACK'}`)
		})
	}
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
})

process.on('SIGTERM', () => {
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	logSync(`[RUN-TEST-LIFECYCLE] SIGTERM RECEIVED - PROCESS BEING KILLED`)
	logSync(`[RUN-TEST-LIFECYCLE] Process PID: ${process.pid}`)
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	process.exit(143) // Standard exit code for SIGTERM
})

process.on('SIGINT', () => {
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	logSync(`[RUN-TEST-LIFECYCLE] SIGINT RECEIVED - CTRL+C OR KILL`)
	logSync(`[RUN-TEST-LIFECYCLE] Process PID: ${process.pid}`)
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	process.exit(130) // Standard exit code for SIGINT
})

function getTortureRepoRoot(): string | undefined {
	return (
		process.env.TORTURE_REPO_ROOT ||
		process.env.REPO_ROOT ||
		process.env.TXN_AGENT_TORTURE_REPO
	)
}

async function main() {
	// Initialize log file
	try {
		fsSync.writeFileSync(LOG_FILE, `=== TEST RUNNER LIFECYCLE LOG ===\nStarted: ${new Date().toISOString()}\nPID: ${process.pid}\n\n`, 'utf-8')
	} catch (e) {
		console.error('Failed to initialize log file:', e)
	}
	
	logSync('[RUN-TEST-LIFECYCLE] main() function started')
	
	// Define these outside try block so they're accessible in catch handler
	let extensionDevelopmentPath: string = ''
	let extensionTestsPath: string = ''
	let testWorkspace: string = ''
	
	try {
		logSync('[RUN-TEST-LIFECYCLE] Entering try block')
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		extensionDevelopmentPath = path.resolve(__dirname, "../../../src")

		// The path to the extension test script
		// Passed to --extensionTestsPath
		extensionTestsPath = path.resolve(__dirname, "./suite/index")

		// Determine if we're running torture repo test
		// Set env vars programmatically to ensure they override any existing values
		const isTortureTest = process.env.TEST_TORTURE_REPO === "1" || process.argv.includes("--torture")
		
		if (isTortureTest) {
			const tortureRepoRoot = getTortureRepoRoot()
			if (!tortureRepoRoot) {
				const cwd = process.cwd()
				console.error(`[torture-test] ERROR: Missing torture repo path env var.`)
				console.error(`[torture-test] CWD: ${cwd}`)
				console.error(
					`[torture-test] Checked env keys: TORTURE_REPO_ROOT, REPO_ROOT, TXN_AGENT_TORTURE_REPO`,
				)
				process.exit(1)
			}
			// Force-set torture repo environment variables
			process.env.TEST_TORTURE_REPO = "1"
			process.env.TEST_TORTURE_REPO_WORKSPACE = tortureRepoRoot
			testWorkspace = tortureRepoRoot
			
			console.log(`[runTest] Torture repo test mode enabled`)
			console.log(`[runTest] TEST_TORTURE_REPO=${process.env.TEST_TORTURE_REPO}`)
			console.log(`[runTest] TEST_TORTURE_REPO_WORKSPACE=${process.env.TEST_TORTURE_REPO_WORKSPACE}`)
			console.log(`[runTest] OPENROUTER_API_KEY present: ${!!process.env.OPENROUTER_API_KEY}`)
			
			// Verify workspace exists
			try {
				await fs.access(testWorkspace)
				console.log(`[runTest] Workspace verified: ${testWorkspace}`)
			} catch {
				console.error(`[runTest] ERROR: Workspace does not exist: ${testWorkspace}`)
				process.exit(1)
			}
		} else {
			testWorkspace =
				process.env.TEST_TORTURE_REPO_WORKSPACE ||
				(await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-workspace-")))
		}

		// Get test filter from command line arguments or environment variable
		// Usage examples:
		// - npm run test:e2e -- --grep "write-to-file"
		// - TEST_GREP="apply-diff" npm run test:e2e
		// - TEST_FILE="task.test.js" npm run test:e2e
		const testGrep = process.argv.find((arg, i) => process.argv[i - 1] === "--grep") || process.env.TEST_GREP
		const testFile = process.argv.find((arg, i) => process.argv[i - 1] === "--file") || process.env.TEST_FILE

		// Pass ALL environment variables to the test runner, including our programmatic overrides
		const extensionTestsEnv = {
			...process.env,
			// Explicitly set these to ensure they propagate
			TEST_TORTURE_REPO: process.env.TEST_TORTURE_REPO,
			TEST_TORTURE_REPO_WORKSPACE: process.env.TEST_TORTURE_REPO_WORKSPACE,
			OPENAI_API_KEY: process.env.OPENAI_API_KEY,
			GEMINI_API_KEY: process.env.GEMINI_API_KEY,
			OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
			...(testGrep && { TEST_GREP: testGrep }),
			...(testFile && { TEST_FILE: testFile }),
		}

		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
		logSync(`[RUN-TEST-LIFECYCLE] STARTING TEST RUNNER`)
		logSync(`[RUN-TEST-LIFECYCLE] Timestamp: ${new Date().toISOString()}`)
		logSync(`[RUN-TEST-LIFECYCLE] Process PID: ${process.pid}`)
		logSync(`[RUN-TEST-LIFECYCLE] Node version: ${process.version}`)
		logSync(`[RUN-TEST-LIFECYCLE] Platform: ${process.platform}`)
		logSync(`[RUN-TEST-LIFECYCLE] Extension path: ${extensionDevelopmentPath}`)
		logSync(`[RUN-TEST-LIFECYCLE] Test path: ${extensionTestsPath}`)
		logSync(`[RUN-TEST-LIFECYCLE] Workspace: ${testWorkspace}`)
		logSync(`[RUN-TEST-LIFECYCLE] VS Code version: ${process.env.VSCODE_VERSION || "1.101.2"}`)
		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
		logSync(`[torture-test] Launching VS Code with workspace: ${testWorkspace}`)

		logSync('[RUN-TEST-LIFECYCLE] About to call runTests()')
		
		const runTestsStartTime = Date.now()
		let runTestsResolved = false
		let runTestsRejected = false
		let runTestsError: unknown = null
		let runTestsResolutionTime: number | null = null
		let runTestsRejectionTime: number | null = null

		// Create a promise that tracks runTests() lifecycle
		logSync('[RUN-TEST-LIFECYCLE] Creating runTests() promise wrapper')
		const runTestsPromise = runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [testWorkspace, "--disable-workspace-trust"],
			extensionTestsEnv,
			version: process.env.VSCODE_VERSION || "1.101.2",
		}).then(
			(value) => {
				runTestsResolved = true
				runTestsResolutionTime = Date.now()
				const duration = runTestsResolutionTime - runTestsStartTime
				logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
				logSync(`[RUN-TEST-LIFECYCLE] runTests() RESOLVED SUCCESSFULLY`)
				logSync(`[RUN-TEST-LIFECYCLE] Duration: ${duration}ms (${Math.round(duration / 1000)}s)`)
				logSync(`[RUN-TEST-LIFECYCLE] Return value: ${JSON.stringify(value)}`)
				logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
				return value
			},
			(error) => {
				runTestsRejected = true
				runTestsRejectionTime = Date.now()
				runTestsError = error
				const duration = runTestsRejectionTime - runTestsStartTime
				logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
				logSync(`[RUN-TEST-LIFECYCLE] runTests() REJECTED/THREW ERROR`)
				logSync(`[RUN-TEST-LIFECYCLE] Duration before failure: ${duration}ms (${Math.round(duration / 1000)}s)`)
				logSync(`[RUN-TEST-LIFECYCLE] Error type: ${error instanceof Error ? error.constructor.name : typeof error}`)
				if (error instanceof Error) {
					logSync(`[RUN-TEST-LIFECYCLE] Error message: ${error.message}`)
					logSync(`[RUN-TEST-LIFECYCLE] Error stack: ${error.stack || 'NO STACK'}`)
					if ('code' in error) {
						logSync(`[RUN-TEST-LIFECYCLE] Error code: ${(error as any).code}`)
					}
					if ('signal' in error) {
						logSync(`[RUN-TEST-LIFECYCLE] Error signal: ${(error as any).signal}`)
					}
					if ('exitCode' in error) {
						logSync(`[RUN-TEST-LIFECYCLE] Error exitCode: ${(error as any).exitCode}`)
					}
				} else {
					logSync(`[RUN-TEST-LIFECYCLE] Error (non-Error type): ${JSON.stringify(error)}`)
				}
				logSync(`[RUN-TEST-LIFECYCLE] Unhandled rejections at time of failure: ${unhandledRejections.length}`)
				logSync(`[RUN-TEST-LIFECYCLE] Uncaught exceptions at time of failure: ${uncaughtExceptions.length}`)
				logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
				throw error
			}
		)

		// Set up a watchdog timeout to detect if runTests() hangs
		// Use a very long timeout (30 minutes) to avoid false positives, but still detect hangs
		const WATCHDOG_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
		const watchdogTimeout = setTimeout(() => {
			if (!runTestsResolved && !runTestsRejected) {
				const elapsed = Date.now() - runTestsStartTime
				console.error(`[RUN-TEST-LIFECYCLE] ========================================`)
				console.error(`[RUN-TEST-LIFECYCLE] WATCHDOG TIMEOUT: runTests() HAS NOT RESOLVED OR REJECTED`)
				console.error(`[RUN-TEST-LIFECYCLE] Elapsed time: ${elapsed}ms (${Math.round(elapsed / 1000)}s)`)
				console.error(`[RUN-TEST-LIFECYCLE] This indicates runTests() is hanging or VS Code process is stuck`)
				console.error(`[RUN-TEST-LIFECYCLE] Unhandled rejections: ${unhandledRejections.length}`)
				console.error(`[RUN-TEST-LIFECYCLE] Uncaught exceptions: ${uncaughtExceptions.length}`)
				console.error(`[RUN-TEST-LIFECYCLE] ========================================`)
			}
		}, WATCHDOG_TIMEOUT_MS)

		// Download VS Code, unzip it and run the integration test
		logSync('[RUN-TEST-LIFECYCLE] Awaiting runTests() promise...')
		try {
			await runTestsPromise
			clearTimeout(watchdogTimeout)
			logSync('[RUN-TEST-LIFECYCLE] runTests() promise resolved without error')
		} catch (error) {
			clearTimeout(watchdogTimeout)
			logSync(`[RUN-TEST-LIFECYCLE] runTests() promise rejected, error: ${error instanceof Error ? error.message : String(error)}`)
			// Error already logged in the promise rejection handler above
			throw error
		}

		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
		logSync(`[RUN-TEST-LIFECYCLE] runTests() COMPLETED, CLEANING UP`)
		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)

		// Clean up the temporary workspace (but NOT the torture repo)
		if (!isTortureTest) {
			try {
				await fs.rm(testWorkspace, { recursive: true, force: true })
				logSync(`[RUN-TEST-LIFECYCLE] Temporary workspace cleaned up`)
			} catch (cleanupError) {
				logSync(`[RUN-TEST-LIFECYCLE] Failed to clean up workspace: ${cleanupError}`)
				// Don't throw - cleanup failure shouldn't fail the test
			}
		}

		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
		logSync(`[RUN-TEST-LIFECYCLE] TEST RUNNER COMPLETED SUCCESSFULLY`)
		logSync(`[RUN-TEST-LIFECYCLE] Total duration: ${Date.now() - runTestsStartTime}ms`)
		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	} catch (error) {
		const errorTime = Date.now()
		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
		logSync(`[RUN-TEST-LIFECYCLE] CAUGHT ERROR IN MAIN TRY-CATCH`)
		logSync(`[RUN-TEST-LIFECYCLE] Timestamp: ${new Date(errorTime).toISOString()}`)
		logSync(`[RUN-TEST-LIFECYCLE] Error type: ${error instanceof Error ? error.constructor.name : typeof error}`)
		if (error instanceof Error) {
			logSync(`[RUN-TEST-LIFECYCLE] Error message: ${error.message}`)
			logSync(`[RUN-TEST-LIFECYCLE] Error stack: ${error.stack || 'NO STACK'}`)
			if ('code' in error) {
				logSync(`[RUN-TEST-LIFECYCLE] Error code: ${(error as any).code}`)
			}
			if ('signal' in error) {
				logSync(`[RUN-TEST-LIFECYCLE] Error signal: ${(error as any).signal}`)
			}
			if ('exitCode' in error) {
				logSync(`[RUN-TEST-LIFECYCLE] Error exitCode: ${(error as any).exitCode}`)
			}
		} else {
			logSync(`[RUN-TEST-LIFECYCLE] Error (non-Error type): ${JSON.stringify(error)}`)
		}
		
		// Determine the ROOT CAUSE of the failure
		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
		logSync(`[RUN-TEST-LIFECYCLE] ROOT CAUSE ANALYSIS:`)
		
		if (uncaughtExceptions.length > 0) {
			logSync(`[RUN-TEST-LIFECYCLE] ROOT CAUSE: Uncaught exception(s) in test runner process`)
			uncaughtExceptions.forEach((ue, i) => {
				logSync(`[RUN-TEST-LIFECYCLE]   Exception ${i + 1} (${new Date(ue.timestamp).toISOString()}):`)
				logSync(`[RUN-TEST-LIFECYCLE]     Message: ${ue.error.message}`)
				logSync(`[RUN-TEST-LIFECYCLE]     Stack: ${ue.error.stack || 'NO STACK'}`)
			})
		} else if (unhandledRejections.length > 0) {
			logSync(`[RUN-TEST-LIFECYCLE] ROOT CAUSE: Unhandled promise rejection(s) in test runner process`)
			unhandledRejections.forEach((ur, i) => {
				logSync(`[RUN-TEST-LIFECYCLE]   Rejection ${i + 1} (${new Date(ur.timestamp).toISOString()}):`)
				logSync(`[RUN-TEST-LIFECYCLE]     Reason: ${ur.reason instanceof Error ? ur.reason.message : String(ur.reason)}`)
				if (ur.reason instanceof Error && ur.reason.stack) {
					logSync(`[RUN-TEST-LIFECYCLE]     Stack: ${ur.reason.stack}`)
				}
			})
		} else if (error instanceof Error) {
			if (error.message.includes('timeout') || error.message.includes('Timeout')) {
				logSync(`[RUN-TEST-LIFECYCLE] ROOT CAUSE: Timeout - runTests() or VS Code process timed out`)
				logSync(`[RUN-TEST-LIFECYCLE]   This could be:`)
				logSync(`[RUN-TEST-LIFECYCLE]   - Mocha test timeout (check suite/index.ts timeout setting)`)
				logSync(`[RUN-TEST-LIFECYCLE]   - VS Code extension host timeout`)
				logSync(`[RUN-TEST-LIFECYCLE]   - VS Code process hang/crash`)
			} else if (error.message.includes('exit') || 'exitCode' in error) {
				logSync(`[RUN-TEST-LIFECYCLE] ROOT CAUSE: VS Code process exited unexpectedly`)
				logSync(`[RUN-TEST-LIFECYCLE]   Exit code: ${(error as any).exitCode || 'unknown'}`)
				logSync(`[RUN-TEST-LIFECYCLE]   This usually indicates:`)
				logSync(`[RUN-TEST-LIFECYCLE]   - VS Code crashed`)
				logSync(`[RUN-TEST-LIFECYCLE]   - Extension host crashed`)
				logSync(`[RUN-TEST-LIFECYCLE]   - Test suite threw uncaught error`)
			} else if (error.message.includes('ENOENT') || error.message.includes('not found')) {
				logSync(`[RUN-TEST-LIFECYCLE] ROOT CAUSE: File or path not found`)
				logSync(`[RUN-TEST-LIFECYCLE]   Check that all paths exist:`)
				logSync(`[RUN-TEST-LIFECYCLE]   - Extension path: ${extensionDevelopmentPath || 'NOT SET'}`)
				logSync(`[RUN-TEST-LIFECYCLE]   - Test path: ${extensionTestsPath || 'NOT SET'}`)
				logSync(`[RUN-TEST-LIFECYCLE]   - Workspace: ${testWorkspace || 'NOT SET'}`)
			} else {
				logSync(`[RUN-TEST-LIFECYCLE] ROOT CAUSE: Error from runTests() or VS Code`)
				logSync(`[RUN-TEST-LIFECYCLE]   Error message: ${error.message}`)
			}
		} else {
			logSync(`[RUN-TEST-LIFECYCLE] ROOT CAUSE: Unknown error type`)
			logSync(`[RUN-TEST-LIFECYCLE]   Error: ${JSON.stringify(error)}`)
		}
		
		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
		logSync(`[RUN-TEST-LIFECYCLE] SUMMARY:`)
		logSync(`[RUN-TEST-LIFECYCLE]   Unhandled rejections: ${unhandledRejections.length}`)
		logSync(`[RUN-TEST-LIFECYCLE]   Uncaught exceptions: ${uncaughtExceptions.length}`)
		logSync(`[RUN-TEST-LIFECYCLE]   Error caught in try-catch: YES`)
		logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
		logSync(`FATAL ERROR - Failed to run tests: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}

main().catch((error) => {
	// This should never happen if main() has proper try-catch, but just in case
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	logSync(`[RUN-TEST-LIFECYCLE] FATAL: main() promise rejected without being caught`)
	logSync(`[RUN-TEST-LIFECYCLE] This indicates a bug in error handling`)
	logSync(`[RUN-TEST-LIFECYCLE] Error: ${error instanceof Error ? error.message : String(error)}`)
	if (error instanceof Error && error.stack) {
		logSync(`[RUN-TEST-LIFECYCLE] Stack: ${error.stack}`)
	}
	logSync(`[RUN-TEST-LIFECYCLE] ========================================`)
	process.exit(1)
})
