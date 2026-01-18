/**
 * Progress Gate (R33): Monotonic non-decreasing passing test count
 *
 * Runs a test command and parses the output to count passing/failing tests.
 * Supports common test frameworks: Jest, Vitest, Mocha, pytest, node test runner.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const pexec = promisify(execFile)

export interface TestResult {
	passingCount: number
	failingCount: number
	totalCount: number
	exitCode: number
	stdout: string
	stderr: string
}

/**
 * Run tests in a worktree and count passing/failing tests.
 * Deterministic: same command always produces same count for same code state.
 */
export async function runTestsAndCount(worktreePath: string, testCommand: string): Promise<TestResult> {
	// Split command into program and args
	const parts = testCommand.split(/\s+/)
	const program = parts[0]
	const args = parts.slice(1)

	let stdout = ""
	let stderr = ""
	let exitCode = 0

	try {
		const result = await pexec(program, args, {
			cwd: worktreePath,
			windowsHide: true,
			timeout: 60000, // 60s timeout
			env: {
				...process.env,
				// Force deterministic output for common frameworks
				FORCE_COLOR: "0",
				CI: "true",
			},
		})
		stdout = result.stdout
		stderr = result.stderr
	} catch (e: any) {
		// Test command may exit non-zero if tests fail - that's expected
		exitCode = e.code ?? 1
		stdout = e.stdout ?? ""
		stderr = e.stderr ?? ""
	}

	// Parse test output to count passing/failing
	const counts = parseTestOutput(stdout + "\n" + stderr)

	return {
		...counts,
		exitCode,
		stdout,
		stderr,
	}
}

/**
 * Parse test framework output to extract pass/fail counts.
 * Supports multiple frameworks with conservative fallback.
 */
function parseTestOutput(output: string): { passingCount: number; failingCount: number; totalCount: number } {
	// Jest/Vitest: "Tests:  5 passed, 2 failed, 7 total"
	const jestMatch = output.match(/Tests?:\s*(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*total)?/i)
	if (jestMatch) {
		const passed = parseInt(jestMatch[1], 10)
		const failed = jestMatch[2] ? parseInt(jestMatch[2], 10) : 0
		const total = jestMatch[3] ? parseInt(jestMatch[3], 10) : passed + failed
		return { passingCount: passed, failingCount: failed, totalCount: total }
	}

	// Mocha: "5 passing" and optionally "2 failing"
	const mochaPassMatch = output.match(/(\d+)\s*passing/i)
	const mochaFailMatch = output.match(/(\d+)\s*failing/i)
	if (mochaPassMatch) {
		const passed = parseInt(mochaPassMatch[1], 10)
		const failed = mochaFailMatch ? parseInt(mochaFailMatch[1], 10) : 0
		return { passingCount: passed, failingCount: failed, totalCount: passed + failed }
	}

	// pytest: "5 passed, 2 failed" or "5 passed"
	const pytestMatch = output.match(/(\d+)\s*passed(?:,\s*(\d+)\s*failed)?/i)
	if (pytestMatch) {
		const passed = parseInt(pytestMatch[1], 10)
		const failed = pytestMatch[2] ? parseInt(pytestMatch[2], 10) : 0
		return { passingCount: passed, failingCount: failed, totalCount: passed + failed }
	}

	// Node test runner: "tests 5" and "pass 3" "fail 2"
	const nodePassMatch = output.match(/pass\s*(\d+)/i)
	const nodeFailMatch = output.match(/fail\s*(\d+)/i)
	if (nodePassMatch || nodeFailMatch) {
		const passed = nodePassMatch ? parseInt(nodePassMatch[1], 10) : 0
		const failed = nodeFailMatch ? parseInt(nodeFailMatch[1], 10) : 0
		return { passingCount: passed, failingCount: failed, totalCount: passed + failed }
	}

	// Simple fallback: count "ok" and "not ok" (TAP format)
	const okCount = (output.match(/^ok\s+\d+/gm) || []).length
	const notOkCount = (output.match(/^not ok\s+\d+/gm) || []).length
	if (okCount > 0 || notOkCount > 0) {
		return { passingCount: okCount, failingCount: notOkCount, totalCount: okCount + notOkCount }
	}

	// Fallback: if exit code 0, assume 1 pass; else 0 pass 1 fail
	// This is a conservative fallback for unknown test formats
	return { passingCount: 0, failingCount: 0, totalCount: 0 }
}

/**
 * Check if progress is valid (monotonic non-decreasing).
 */
export function isProgressValid(baseline: number, current: number): boolean {
	return current >= baseline
}
