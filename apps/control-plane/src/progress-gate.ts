/**
 * Progress Gate (R33): monotonic non-decreasing passing test count.
 *
 * Runs a test command and parses its output into pass / fail / skip counts.
 * Parsers are order-independent ("2 failed, 5 passed" and "5 passed, 2 failed"
 * both work) and anchored to each framework's summary line, so e.g. Vitest's
 * "Test Files  1 passed" line is never mistaken for the test count.
 */
import { runCommand, type RunOptions } from "./exec.js"

export type TestOutputFormat = "jest" | "vitest" | "pytest" | "mocha" | "node-test" | "tap" | "go" | "unknown"

export interface ParsedCounts {
	passingCount: number
	failingCount: number
	skippedCount: number
	totalCount: number
	format: TestOutputFormat
}

export interface TestResult extends ParsedCounts {
	exitCode: number
	timedOut: boolean
	spawnError?: string
	stdout: string
	stderr: string
}

export async function runTestsAndCount(
	worktreePath: string,
	testCommand: string,
	opts: Pick<RunOptions, "timeoutMs" | "app" | "txId"> = {},
): Promise<TestResult> {
	if (!testCommand.trim()) {
		return {
			passingCount: 0,
			failingCount: 0,
			skippedCount: 0,
			totalCount: 0,
			format: "unknown",
			exitCode: 127,
			timedOut: false,
			spawnError: "Test command is empty",
			stdout: "",
			stderr: "Test command is empty",
		}
	}
	const r = await runCommand(worktreePath, testCommand, { timeoutMs: opts.timeoutMs ?? 300_000, ...opts })
	const counts = parseTestOutput(r.stdout + "\n" + r.stderr)
	return {
		...counts,
		exitCode: r.exitCode,
		timedOut: r.timedOut,
		spawnError: r.spawnError,
		stdout: r.stdout,
		stderr: r.stderr,
	}
}

function countsFrom(line: string, words: Record<string, RegExp>): Record<string, number> {
	const out: Record<string, number> = {}
	for (const [k, re] of Object.entries(words)) {
		let sum = 0
		let matched = false
		for (const m of line.matchAll(re)) {
			sum += parseInt(m[1]!, 10)
			matched = true
		}
		if (matched) out[k] = sum
	}
	return out
}

const n = (re: string) => new RegExp(`(\\d+)\\s+${re}`, "gi")

function lastMatchingLine(lines: string[], re: RegExp): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (re.test(lines[i]!)) return lines[i]
	}
	return undefined
}

/**
 * Parse test framework output. Exported for unit testing.
 */
export function parseTestOutput(rawOutput: string): ParsedCounts {
	// Strip ANSI colour codes
	const output = rawOutput.replace(/\x1b\[[0-9;]*m/g, "")
	const lines = output.split(/\r?\n/)

	// --- Jest: "Tests:       2 failed, 1 skipped, 5 passed, 8 total"
	const jestLine = lastMatchingLine(lines, /^\s*Tests:\s+.*\d+\s+(passed|failed|total)/i)
	if (jestLine) {
		const c = countsFrom(jestLine, {
			passed: n("passed"),
			failed: n("failed"),
			skipped: n("(?:skipped|pending|todo)"),
			total: n("total"),
		})
		const passed = c.passed ?? 0
		const failed = c.failed ?? 0
		const skipped = c.skipped ?? 0
		return {
			passingCount: passed,
			failingCount: failed,
			skippedCount: skipped,
			totalCount: c.total ?? passed + failed + skipped,
			format: "jest",
		}
	}

	// --- Vitest: "      Tests  2 failed | 5 passed | 1 skipped (8)"  (NOT the "Test Files" line)
	const vitestLine = lastMatchingLine(lines, /^\s*Tests\s{2,}.*\d+\s+(passed|failed)/i)
	if (vitestLine && !/^\s*Test Files/i.test(vitestLine)) {
		const c = countsFrom(vitestLine, {
			passed: n("passed"),
			failed: n("failed"),
			skipped: n("(?:skipped|todo)"),
		})
		const totalM = vitestLine.match(/\((\d+)\)\s*$/)
		const passed = c.passed ?? 0
		const failed = c.failed ?? 0
		const skipped = c.skipped ?? 0
		return {
			passingCount: passed,
			failingCount: failed,
			skippedCount: skipped,
			totalCount: totalM ? parseInt(totalM[1]!, 10) : passed + failed + skipped,
			format: "vitest",
		}
	}

	// --- pytest: "==== 2 failed, 5 passed, 1 skipped in 0.12s ====" (also "5 passed in 0.1s")
	const pytestLine = lastMatchingLine(lines, /\d+\s+(passed|failed|errors?)\b.*\bin\s+[\d.]+\s*s/i)
	if (pytestLine) {
		const c = countsFrom(pytestLine, {
			passed: n("passed"),
			failed: n("failed"),
			errors: n("errors?"),
			skipped: n("(?:skipped|xfailed|deselected)"),
			xpassed: n("xpassed"),
		})
		const passed = (c.passed ?? 0) + (c.xpassed ?? 0)
		const failed = (c.failed ?? 0) + (c.errors ?? 0)
		const skipped = c.skipped ?? 0
		return {
			passingCount: passed,
			failingCount: failed,
			skippedCount: skipped,
			totalCount: passed + failed + skipped,
			format: "pytest",
		}
	}

	// --- Mocha: "  5 passing (20ms)" / "  2 failing" / "  1 pending"
	const mochaPass = output.match(/^\s*(\d+)\s+passing\b/im)
	if (mochaPass) {
		const failing = output.match(/^\s*(\d+)\s+failing\b/im)
		const pending = output.match(/^\s*(\d+)\s+pending\b/im)
		const passed = parseInt(mochaPass[1]!, 10)
		const failed = failing ? parseInt(failing[1]!, 10) : 0
		const skipped = pending ? parseInt(pending[1]!, 10) : 0
		return {
			passingCount: passed,
			failingCount: failed,
			skippedCount: skipped,
			totalCount: passed + failed + skipped,
			format: "mocha",
		}
	}

	// --- node:test: "# pass 3" / "# fail 1" (TAP reporter) or "ℹ pass 3" (spec reporter)
	const nodePass = output.match(/^[#ℹ]\s*pass\s+(\d+)/im)
	const nodeFail = output.match(/^[#ℹ]\s*fail\s+(\d+)/im)
	if (nodePass || nodeFail) {
		const skippedM = output.match(/^[#ℹ]\s*skipped\s+(\d+)/im)
		const passed = nodePass ? parseInt(nodePass[1]!, 10) : 0
		const failed = nodeFail ? parseInt(nodeFail[1]!, 10) : 0
		const skipped = skippedM ? parseInt(skippedM[1]!, 10) : 0
		return {
			passingCount: passed,
			failingCount: failed,
			skippedCount: skipped,
			totalCount: passed + failed + skipped,
			format: "node-test",
		}
	}

	// --- TAP: "ok 1 - ..." / "not ok 2 - ..."
	const okCount = (output.match(/^ok\s+\d+/gm) || []).length
	const notOkCount = (output.match(/^not ok\s+\d+/gm) || []).length
	if (okCount > 0 || notOkCount > 0) {
		return {
			passingCount: okCount,
			failingCount: notOkCount,
			skippedCount: 0,
			totalCount: okCount + notOkCount,
			format: "tap",
		}
	}

	// --- go test -v: "--- PASS: TestX" / "--- FAIL: TestY"
	const goPass = (output.match(/^\s*--- PASS:/gm) || []).length
	const goFail = (output.match(/^\s*--- FAIL:/gm) || []).length
	if (goPass > 0 || goFail > 0) {
		const goSkip = (output.match(/^\s*--- SKIP:/gm) || []).length
		return {
			passingCount: goPass,
			failingCount: goFail,
			skippedCount: goSkip,
			totalCount: goPass + goFail + goSkip,
			format: "go",
		}
	}

	return { passingCount: 0, failingCount: 0, skippedCount: 0, totalCount: 0, format: "unknown" }
}

/**
 * True when the runner started fine but found nothing to run: an empty suite, not a
 * failing one. Runners report this with a non-zero exit code (pytest: 5, jest/vitest: 1),
 * which would otherwise block every commit in a repository that has no tests yet.
 */
export function noTestsCollected(rawOutput: string, exitCode: number | null | undefined): boolean {
	const out = rawOutput.replace(/\x1b\[[0-9;]*m/g, "")
	// pytest: exit 5 == "no tests collected"
	if (exitCode === 5 && /\bno tests ran\b|\bcollected 0 items\b/i.test(out)) return true
	// jest: "No tests found, exiting with code 1"; vitest: "No test files found, exiting with code 1"
	if (exitCode === 1 && /\bNo tests found, exiting with code 1\b|\bNo test files found\b/i.test(out)) return true
	return false
}

/**
 * The passing count the gate compares. For unrecognised output we cannot count
 * tests, so we fall back to the exit code (exit 0 ⇒ 1 "pass", else 0) — but
 * only when the baseline was also unrecognised; if the baseline was parseable
 * and the current output is not, that is treated as 0 passing (the suite broke).
 */
export function effectivePassing(
	result: { passingCount: number; format: TestOutputFormat; exitCode: number },
	baselineFormat?: TestOutputFormat,
): number {
	if (result.format !== "unknown") return result.passingCount
	if (baselineFormat && baselineFormat !== "unknown") return 0
	return result.exitCode === 0 ? 1 : 0
}

/**
 * Check if progress is valid (monotonic non-decreasing).
 */
export function isProgressValid(baseline: number, current: number): boolean {
	return current >= baseline
}
