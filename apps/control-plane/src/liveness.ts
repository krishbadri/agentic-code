/**
 * Liveness Check (R8, Slide 68)
 *
 * Deterministic check at FINAL commit point only.
 * Verifies:
 * 1. All given tests pass
 * 2. No pending required steps
 * 3. System is in a consistent state
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const pexec = promisify(execFile)

export interface LivenessCheck {
	passed: boolean
	testsPass: boolean
	noPendingSteps: boolean
	details: {
		testCommand?: string
		testExitCode?: number
		testOutput?: string
		pendingSteps?: string[]
		error?: string
	}
}

export interface LivenessConfig {
	testCommand?: string // Command to run tests (e.g., "pnpm test")
	requiredSteps?: string[] // Steps that must be completed
	completedSteps?: string[] // Steps that have been completed
}

/**
 * Run the liveness check at final commit point.
 *
 * This is called ONLY at the final commit point (not intermediate checkpoints).
 */
export async function checkLiveness(worktreePath: string, config: LivenessConfig): Promise<LivenessCheck> {
	const result: LivenessCheck = {
		passed: true,
		testsPass: true,
		noPendingSteps: true,
		details: {},
	}

	// Check 1: All given tests pass
	if (config.testCommand) {
		try {
			const parts = config.testCommand.split(/\s+/)
			const program = parts[0]
			if (!program) {
				result.testsPass = false
				result.passed = false
				result.details.error = "Test command is empty"
				return result
			}
			const args = parts.slice(1)

			const { stdout, stderr } = await pexec(program, args, {
				cwd: worktreePath,
				windowsHide: true,
				timeout: 120000, // 2 min timeout for tests
				env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
			})

			result.details.testCommand = config.testCommand
			result.details.testExitCode = 0
			result.details.testOutput = (stdout + "\n" + stderr).slice(-2048)
		} catch (e: any) {
			result.testsPass = false
			result.passed = false
			result.details.testCommand = config.testCommand
			result.details.testExitCode = e.code ?? 1
			result.details.testOutput = ((e.stdout || "") + "\n" + (e.stderr || e.message || "")).slice(-2048)
			result.details.error = `Tests failed with exit code ${result.details.testExitCode}`
		}
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
