/**
 * Smoke test: the transactional flow with a REAL model (not the scripted one).
 *
 * Runs only with TEST_CP_E2E=1 and TEST_CP_REAL=1 (`pnpm test:cp:real`), using the
 * OpenRouter key/model from the repo-root .env. It is deliberately small (two short
 * tasks on the throw-away fixture repository) and asserts outcomes, not wording:
 * a real model is free to plan or not, so both a committed result and a cleanly
 * discarded transaction are accepted — a half-applied workspace never is.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { sleep, waitFor } from "./utils"

const enabled = process.env.TEST_CP_E2E === "1" && process.env.TEST_CP_REAL === "1"

const TASK_CONFIG = {
	mode: "code",
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: true,
	alwaysAllowWrite: true,
	alwaysAllowWriteProtected: true,
	alwaysAllowExecute: true,
	alwaysAllowSubtasks: true,
	alwaysAllowModeSwitch: true,
	alwaysAllowFollowupQuestions: true,
	alwaysApproveResubmit: true,
	allowedCommands: ["*"],
	deniedCommands: [],
	enableCheckpoints: true,
	writeDelayMs: 0,
	diagnosticsEnabled: false,
	terminalShellIntegrationDisabled: true,
} as const

;(enabled ? suite : suite.skip)("Control-Plane transactions (real model smoke test)", function () {
	this.timeout(20 * 60 * 1000)

	let ws: string
	const messages: Record<string, ClineMessage[]> = {}
	const completed = new Set<string>()
	const aborted = new Set<string>()

	const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, windowsHide: true }).toString().trim()
	const read = (rel: string) => fs.readFileSync(path.join(ws, rel), "utf8").replace(/\r\n/g, "\n")
	const exists = (rel: string) => fs.existsSync(path.join(ws, rel))
	const worktrees = () => {
		const dir = path.join(ws, ".cp", "worktrees")
		return fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => d.startsWith("tx_")) : []
	}
	const said = (taskId: string) => (messages[taskId] ?? []).map((m) => m.text ?? "").join("\n")

	async function run(text: string, timeout = 8 * 60 * 1000): Promise<string> {
		const api = globalThis.api
		const taskId = await api.startNewTask({ configuration: TASK_CONFIG as any, text })
		await waitFor(() => completed.has(taskId) || aborted.has(taskId), { timeout, interval: 250 })
		assert.ok(completed.has(taskId), `task ${taskId} was aborted.\n${said(taskId).slice(-3000)}`)
		await sleep(1000)
		return taskId
	}

	suiteSetup(() => {
		ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
		const api = globalThis.api
		api.on(RooCodeEventName.Message, ({ taskId, message }) => {
			if (message.partial) return
			;(messages[taskId] ??= []).push(message)
		})
		api.on(RooCodeEventName.TaskCompleted, (id: string) => completed.add(id))
		api.on(RooCodeEventName.TaskAborted, (id: string) => aborted.add(id))
	})

	test("a real model completes a small edit through a transaction", async () => {
		const headBefore = git("rev-parse", "HEAD")
		const taskId = await run(
			"Create a new file notes/hello.txt in this project whose entire content is the single line: hello transaction",
		)
		assert.ok(exists("notes/hello.txt"), `notes/hello.txt missing after completion.\n${said(taskId).slice(-3000)}`)
		assert.match(read("notes/hello.txt"), /hello transaction/)
		assert.notStrictEqual(git("rev-parse", "HEAD"), headBefore, "the transaction was committed")
		assert.strictEqual(git("status", "--porcelain"), "", "workspace clean after commit")
		assert.deepStrictEqual(worktrees(), [], "worktree removed after commit")
		console.log(`[cp-real] single-agent task committed ${git("rev-parse", "--short", "HEAD")}`)
	})

	test("a real model changes two functions; the result is all-or-nothing and the tests still pass", async () => {
		const headBefore = git("rev-parse", "HEAD")
		const appBefore = read("src/app.js")
		const taskId = await run(
			"Implement two coordinated changes in this project. First: in src/app.js update the function alpha so it " +
				"returns 10 instead of 1. Second: in src/app.js update the function beta so it returns 20 instead of 2. " +
				"Do not touch any other file and do not create or modify test files. " +
				"Afterwards run `node run-tests.js` to confirm the tests still pass.",
		)
		const text = said(taskId)
		const app = read("src/app.js")
		const committed = git("rev-parse", "HEAD") !== headBefore
		if (committed) {
			assert.match(app, /return 10/, `alpha not updated:\n${app}`)
			assert.match(app, /return 20/, `beta not updated:\n${app}`)
		} else {
			assert.strictEqual(app, appBefore, "no commit, so the workspace must be untouched")
		}
		assert.strictEqual(git("status", "--porcelain"), "", "workspace clean")
		assert.deepStrictEqual(worktrees(), [], "no transaction worktree left behind")
		execFileSync("node", ["run-tests.js"], { cwd: ws, windowsHide: true })
		const usedPlanner = /Plan executed successfully|Plan failed/.test(text)
		console.log(
			`[cp-real] two-function task: ${committed ? "committed" : "discarded"}; planner ${usedPlanner ? "used" : "not used"}`,
		)
		assert.ok(committed, `the task finished without committing its work.\n${text.slice(-3000)}`)
	})
})
