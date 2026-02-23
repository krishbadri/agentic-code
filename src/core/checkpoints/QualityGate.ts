import { execa } from "execa"
import { Task } from "../task/Task"
import { rollbackToCheckpointManual } from "./index"
import { getWorkspacePath } from "../../utils/path"
import * as fs from "fs"
import * as path from "path"

// ── Types ──────────────────────────────────────────────────────────────────

export interface QualityScore {
	testsPassing: number
	testsFailing: number
	testsTotal: number
	compileClean: boolean
	timestamp: number
}

interface CheckpointRecord {
	name: string
	hash: string
	score: QualityScore
}

interface QualityGateState {
	checkpoints: CheckpointRecord[]
	consecutiveRegressions: number
}

export type QualityGateVerdict =
	| { action: "save"; score: QualityScore }
	| { action: "rollback"; reason: string; targetCheckpoint: CheckpointRecord; depth: number; score: QualityScore }
	| { action: "skip"; reason: string }

// ── Project detection ──────────────────────────────────────────────────────

interface ProjectInfo {
	type: "python" | "node" | "none"
	testCommand: string | null
	compileCommand: string | null
}

function detectProject(cwd: string): ProjectInfo {
	const exists = (name: string) => fs.existsSync(path.join(cwd, name))

	// Python detection
	if (
		exists("pytest.ini") ||
		exists("pyproject.toml") ||
		exists("setup.py") ||
		exists("conftest.py") ||
		exists("tests")
	) {
		return {
			type: "python",
			testCommand: "python -m pytest -q --tb=line",
			compileCommand: null,
		}
	}

	// Node detection
	if (exists("package.json")) {
		let testCommand: string | null = null

		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"))
			const devDeps = { ...pkg.devDependencies, ...pkg.dependencies }
			if (devDeps.vitest) {
				testCommand = "npx vitest run --reporter=json"
			} else if (devDeps.jest) {
				testCommand = "npx jest --json --forceExit"
			} else if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
				testCommand = "npm test"
			}
		} catch {
			// Malformed package.json — skip test detection
		}

		const compileCommand = exists("tsconfig.json") ? "npx tsc --noEmit" : null

		if (!testCommand && !compileCommand) {
			return { type: "none", testCommand: null, compileCommand: null }
		}

		return { type: "node", testCommand, compileCommand }
	}

	return { type: "none", testCommand: null, compileCommand: null }
}

// ── Command runner ─────────────────────────────────────────────────────────

interface RunResult {
	stdout: string
	stderr: string
	exitCode: number
	timedOut: boolean
}

async function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
	try {
		const result = await execa(command, {
			cwd,
			shell: true,
			timeout: timeoutMs,
			env: { ...process.env, CI: "true", NO_COLOR: "1" },
			reject: false,
		})
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? 1,
			timedOut: false,
		}
	} catch (error: any) {
		if (error?.timedOut || error?.killed) {
			return { stdout: "", stderr: "", exitCode: 1, timedOut: true }
		}
		return {
			stdout: error?.stdout ?? "",
			stderr: error?.stderr ?? "",
			exitCode: error?.exitCode ?? 1,
			timedOut: false,
		}
	}
}

// ── Parsers ────────────────────────────────────────────────────────────────

function parseJestJson(stdout: string): { passing: number; failing: number; total: number } | null {
	try {
		// Jest --json wraps output in a JSON object
		const jsonStart = stdout.indexOf("{")
		if (jsonStart === -1) return null
		const data = JSON.parse(stdout.slice(jsonStart))
		if (typeof data.numPassedTests === "number") {
			return {
				passing: data.numPassedTests,
				failing: data.numFailedTests ?? 0,
				total: data.numTotalTests ?? data.numPassedTests + (data.numFailedTests ?? 0),
			}
		}
	} catch {
		// Not valid JSON
	}
	return null
}

function parseVitestJson(stdout: string): { passing: number; failing: number; total: number } | null {
	try {
		const jsonStart = stdout.indexOf("{")
		if (jsonStart === -1) return null
		const data = JSON.parse(stdout.slice(jsonStart))
		// Vitest JSON reporter: { testResults: [...], numPassedTests, numFailedTests, ... }
		if (typeof data.numPassedTests === "number") {
			return {
				passing: data.numPassedTests,
				failing: data.numFailedTests ?? 0,
				total: data.numTotalTests ?? data.numPassedTests + (data.numFailedTests ?? 0),
			}
		}
		// Alternative vitest format: { success: bool, tests: number }
		if (data.testResults && Array.isArray(data.testResults)) {
			let passing = 0
			let failing = 0
			for (const suite of data.testResults) {
				if (suite.assertionResults && Array.isArray(suite.assertionResults)) {
					for (const t of suite.assertionResults) {
						if (t.status === "passed") passing++
						else failing++
					}
				}
			}
			return { passing, failing, total: passing + failing }
		}
	} catch {
		// Not valid JSON
	}
	return null
}

function parsePytest(stdout: string, stderr: string): { passing: number; failing: number; total: number } | null {
	const combined = stdout + "\n" + stderr
	// Match patterns like "5 passed", "3 failed", "1 error"
	const passedMatch = combined.match(/(\d+)\s+passed/)
	const failedMatch = combined.match(/(\d+)\s+failed/)
	const errorMatch = combined.match(/(\d+)\s+error/)

	if (passedMatch || failedMatch || errorMatch) {
		const passing = passedMatch ? parseInt(passedMatch[1], 10) : 0
		const failing =
			(failedMatch ? parseInt(failedMatch[1], 10) : 0) + (errorMatch ? parseInt(errorMatch[1], 10) : 0)
		return { passing, failing, total: passing + failing }
	}
	return null
}

function parseExitCode(exitCode: number): { passing: number; failing: number; total: number } {
	// Fallback: exit 0 = 1 passing test, else 1 failing
	return exitCode === 0 ? { passing: 1, failing: 0, total: 1 } : { passing: 0, failing: 1, total: 1 }
}

// ── Score collection ───────────────────────────────────────────────────────

async function collectScore(project: ProjectInfo, cwd: string): Promise<QualityScore | null> {
	if (project.type === "none") return null

	let testsPassing = 0
	let testsFailing = 0
	let testsTotal = 0

	// Run tests
	if (project.testCommand) {
		const result = await runCommand(project.testCommand, cwd, 60_000)
		if (result.timedOut) return null // Timeout → skip gate

		let parsed: { passing: number; failing: number; total: number } | null = null

		if (project.testCommand.includes("jest")) {
			parsed = parseJestJson(result.stdout)
		} else if (project.testCommand.includes("vitest")) {
			parsed = parseVitestJson(result.stdout)
		} else if (project.testCommand.includes("pytest")) {
			parsed = parsePytest(result.stdout, result.stderr)
		}

		// Fallback to exit code
		if (!parsed) {
			parsed = parseExitCode(result.exitCode)
		}

		testsPassing = parsed.passing
		testsFailing = parsed.failing
		testsTotal = parsed.total
	}

	// Run compile check
	let compileClean = true
	if (project.compileCommand) {
		const result = await runCommand(project.compileCommand, cwd, 30_000)
		if (result.timedOut) {
			// Compile timeout → assume clean (don't block on slow compiles)
			compileClean = true
		} else {
			compileClean = result.exitCode === 0
		}
	}

	return {
		testsPassing,
		testsFailing,
		testsTotal,
		compileClean,
		timestamp: Date.now(),
	}
}

// ── Regression check ───────────────────────────────────────────────────────

function isRegression(newScore: QualityScore, prevScore: QualityScore): boolean {
	if (newScore.testsPassing < prevScore.testsPassing) return true
	if (!newScore.compileClean && prevScore.compileClean) return true
	return false
}

// ── State management ───────────────────────────────────────────────────────

const stateCache = new Map<string, QualityGateState>()

function getCacheKey(task: Task): string {
	return task.rootTaskId || (task as any).rootTask?.taskId || task.taskId
}

function getState(task: Task): QualityGateState {
	const key = getCacheKey(task)
	let state = stateCache.get(key)
	if (!state) {
		state = { checkpoints: [], consecutiveRegressions: 0 }
		stateCache.set(key, state)
	}
	return state
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function evaluateQualityGate(task: Task, checkpointName: string): Promise<QualityGateVerdict> {
	const cwd = task.cwd || getWorkspacePath()
	if (!cwd) return { action: "skip", reason: "No workspace directory" }

	const project = detectProject(cwd)
	if (project.type === "none") {
		return { action: "skip", reason: "No tests or compile checks detected" }
	}

	const provider = task.providerRef.deref()
	provider?.log?.(`[QualityGate] Running quality checks (${project.type} project)...`)

	const score = await collectScore(project, cwd)
	if (!score) {
		return { action: "skip", reason: "Could not collect quality score (timeout or no test output)" }
	}

	provider?.log?.(
		`[QualityGate] Score: ${score.testsPassing}/${score.testsTotal} tests passing, compile ${score.compileClean ? "clean" : "BROKEN"}`,
	)

	const state = getState(task)

	// First checkpoint ever → baseline, always save
	if (state.checkpoints.length === 0) {
		provider?.log?.(`[QualityGate] First checkpoint — saving as baseline`)
		return { action: "save", score }
	}

	const lastCheckpoint = state.checkpoints[state.checkpoints.length - 1]
	const prevScore = lastCheckpoint.score

	if (!isRegression(score, prevScore)) {
		provider?.log?.(`[QualityGate] No regression — save allowed`)
		return { action: "save", score }
	}

	// Regression detected — compute backtrack depth
	const depth = state.consecutiveRegressions + 1
	const targetIdx = Math.max(0, state.checkpoints.length - depth)
	const targetCheckpoint = state.checkpoints[targetIdx]

	const reason =
		`Quality regression detected: ${score.testsPassing}/${score.testsTotal} passing ` +
		`(was ${prevScore.testsPassing}/${prevScore.testsTotal})` +
		(!score.compileClean && prevScore.compileClean ? ", compile broken" : "") +
		`. Rolling back to "${targetCheckpoint.name}" (depth=${depth}).`

	provider?.log?.(`[QualityGate] ${reason}`)

	return { action: "rollback", reason, targetCheckpoint, depth, score }
}

// ── Post-save recording ────────────────────────────────────────────────────

export function recordCheckpointSaved(task: Task, name: string, hash: string, score: QualityScore): void {
	const state = getState(task)
	state.checkpoints.push({ name, hash, score })
	state.consecutiveRegressions = 0
}

// ── Rollback execution ─────────────────────────────────────────────────────

export async function executeQualityGateRollback(
	task: Task,
	verdict: Extract<QualityGateVerdict, { action: "rollback" }>,
): Promise<string> {
	const state = getState(task)

	// Perform the rollback
	await rollbackToCheckpointManual(task, verdict.targetCheckpoint.hash)

	// Truncate checkpoint list to target
	const targetIdx = state.checkpoints.findIndex((c) => c.hash === verdict.targetCheckpoint.hash)
	if (targetIdx >= 0) {
		state.checkpoints = state.checkpoints.slice(0, targetIdx + 1)
	}

	// Increment consecutive regressions
	state.consecutiveRegressions = verdict.depth

	return (
		`QUALITY GATE BLOCKED SAVE — auto-rollback performed.\n\n` +
		`Reason: ${verdict.reason}\n\n` +
		`Rolled back to checkpoint "${verdict.targetCheckpoint.name}" (${verdict.targetCheckpoint.hash.substring(0, 7)}).\n` +
		`Backtrack depth: ${verdict.depth} (escalates on repeated regressions).\n\n` +
		`Fix the failing tests before attempting another save_checkpoint. ` +
		`Run the test suite to see current failures.`
	)
}
