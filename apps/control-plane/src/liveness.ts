/**
 * Liveness Check (R8, Slide 68)
 *
 * Deterministic check at FINAL commit point only.
 * Verifies:
 * 1. All given tests pass
 * 2. No pending required steps
 * 3. System is in a consistent state
 */

import { runCommand } from "./exec.js"
import { noTestsCollected, parseTestOutput } from "./progress-gate.js"

export interface LivenessCheck {
	passed: boolean
	testsPass: boolean
	noPendingSteps: boolean
	details: {
		testCommand?: string
		testExitCode?: number
		testOutput?: string
		failingCount?: number
		format?: string
		pendingSteps?: string[]
		error?: string
		note?: string
	}
}

export interface LivenessConfig {
	testCommand?: string // Command to run tests (e.g., "pnpm test")
	requiredSteps?: string[] // Steps that must be completed
	completedSteps?: string[] // Steps that have been completed
	timeoutMs?: number
}

/**
 * Run the liveness check at final commit point.
 *
 * Tests pass iff the command exits 0, does not time out, and — when the output
 * format is recognised — reports zero failing tests (some runners exit 0 even
 * with failures, e.g. misconfigured scripts that swallow the exit code).
 */
export async function checkLiveness(worktreePath: string, config: LivenessConfig): Promise<LivenessCheck> {
	const result: LivenessCheck = {
		passed: true,
		testsPass: true,
		noPendingSteps: true,
		details: {},
	}

	// Check 1: All given tests pass
	if (config.testCommand !== undefined) {
		if (!config.testCommand.trim()) {
			result.testsPass = false
			result.passed = false
			result.details.error = "Test command is empty"
			return result
		}
		const r = await runCommand(worktreePath, config.testCommand, { timeoutMs: config.timeoutMs ?? 300_000 })
		const combined = `${r.stdout}\n${r.stderr}`
		const counts = parseTestOutput(combined)
		result.details.testCommand = config.testCommand
		result.details.testExitCode = r.exitCode
		result.details.testOutput = combined.slice(-2048)
		result.details.failingCount = counts.failingCount
		result.details.format = counts.format
		if (r.spawnError) {
			result.testsPass = false
			result.details.error = `Test command could not be started: ${r.spawnError}`
		} else if (r.timedOut) {
			result.testsPass = false
			result.details.error = `Tests timed out after ${config.timeoutMs ?? 300_000}ms`
		} else if (noTestsCollected(combined, r.exitCode)) {
			// An empty suite is vacuously green: there is no given test that fails.
			result.details.note = "No tests were collected; liveness passes vacuously"
		} else if (r.exitCode !== 0) {
			result.testsPass = false
			result.details.error = `Tests failed with exit code ${r.exitCode}`
		} else if (counts.format !== "unknown" && counts.failingCount > 0) {
			result.testsPass = false
			result.details.error = `Tests reported ${counts.failingCount} failure(s) despite exit code 0`
		}
		if (!result.testsPass) result.passed = false
	}

	// Check 2: No pending required steps
	if (config.requiredSteps && config.requiredSteps.length > 0) {
		const completed = new Set(config.completedSteps || [])
		const pending = config.requiredSteps.filter((step) => !completed.has(step))

		if (pending.length > 0) {
			result.noPendingSteps = false
			result.passed = false
			result.details.pendingSteps = pending
			result.details.error = `Pending required steps: ${pending.join(", ")}`
		}
	}

	return result
}

/**
 * Structured log event for liveness check decisions.
 */
export interface LivenessEvent {
	type: "liveness_check"
	timestamp: number
	txId: string
	isFinalCommit: boolean
	passed: boolean
	testsPass: boolean
	noPendingSteps: boolean
	testCommand?: string
	testExitCode?: number
	pendingSteps?: string[]
	error?: string
}

/**
 * Create a structured log event for a liveness check.
 */
export function createLivenessEvent(check: LivenessCheck, txId: string, isFinalCommit: boolean): LivenessEvent {
	return {
		type: "liveness_check",
		timestamp: Date.now(),
		txId,
		isFinalCommit,
		passed: check.passed,
		testsPass: check.testsPass,
		noPendingSteps: check.noPendingSteps,
		testCommand: check.details.testCommand,
		testExitCode: check.details.testExitCode,
		pendingSteps: check.details.pendingSteps,
		error: check.details.error,
	}
}
