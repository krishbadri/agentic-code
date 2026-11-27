import * as path from "path"
import Mocha from "mocha"
import { glob } from "glob"
import * as vscode from "vscode"

import type { RooCodeAPI } from "@roo-code/types"

import { waitFor } from "./utils"

export async function run() {
	const extension = vscode.extensions.getExtension<RooCodeAPI>("RooVeterinaryInc.roo-cline")

	if (!extension) {
		throw new Error("Extension not found")
	}

	const api = extension.isActive ? extension.exports : await extension.activate()

	// TEST_CP_E2E=1: run the Control-Plane suite against a scripted, in-process model
	// (no API key, deterministic). See suite/cp/mock-llm.ts.
	const isCpE2E = process.env.TEST_CP_E2E === "1"
	// TEST_CP_REAL=1 (with TEST_CP_E2E=1): same fixture workspace, but a real model.
	const isCpReal = isCpE2E && process.env.TEST_CP_REAL === "1"

	if (isCpE2E) {
		// The dev-host extension loads src/.env, which may carry torture-test switches that
		// redirect every task to another repository. The tests share the extension host
		// process, so clearing them here takes effect for the extension too.
		for (const key of ["TEST_TORTURE_REPO", "TEST_TORTURE_REPO_WORKSPACE", "TORTURE_REPO_ROOT"]) {
			delete process.env[key]
		}
		if (isCpReal) {
			// Real-model smoke test: OpenRouter key/model from the repo-root .env.
			if (!process.env.OPENROUTER_API_KEY) throw new Error("TEST_CP_REAL=1 needs OPENROUTER_API_KEY")
			await api.setConfiguration({
				apiProvider: "openrouter" as const,
				openRouterApiKey: process.env.OPENROUTER_API_KEY,
				openRouterModelId: process.env.OPENROUTER_MODEL_ID || "openai/gpt-4.1-mini",
			})
			console.log(`[cp-real] model: ${process.env.OPENROUTER_MODEL_ID || "openai/gpt-4.1-mini"}`)
		} else {
			const { startMockLlm } = await import("./cp/mock-llm")
			const mock = await startMockLlm()
			;(globalThis as any).cpMock = mock
			await api.setConfiguration({
				apiProvider: "openai" as const,
				openAiBaseUrl: mock.url,
				openAiApiKey: "mock-key",
				openAiModelId: "mock-model",
				openAiStreamingEnabled: true,
			})
		}
	} else {
		await api.setConfiguration({
			apiProvider: "openai" as const,
			openAiApiKey: process.env.OPENAI_API_KEY!,
			openAiModelId: process.env.OPENAI_MODEL_ID || "gpt-4",
		})
	}

	await vscode.commands.executeCommand("roo-cline.SidebarProvider.focus")
	await waitFor(() => api.isReady())

	globalThis.api = api

	const mochaOptions: Mocha.MochaOptions = {
		ui: "tdd",
		timeout: 20 * 60 * 1_000, // 20m
	}

	if (process.env.TEST_GREP) {
		mochaOptions.grep = process.env.TEST_GREP
		console.log(`Running tests matching pattern: ${process.env.TEST_GREP}`)
	}

	const mocha = new Mocha(mochaOptions)
	const cwd = path.resolve(__dirname, "..")

	let testFiles: string[]

	// When running torture test, only run task.test.ts (skip other unrelated tests)
	const isTortureTest = process.env.TEST_TORTURE_REPO === "1"
	const testFileOverride = isCpReal
		? "cp-real-model.test.js"
		: isCpE2E
			? "cp-transactions.test.js"
			: isTortureTest
				? "task.test.js"
				: process.env.TEST_FILE

	if (testFileOverride) {
		const specificFile = testFileOverride.endsWith(".js") ? testFileOverride : `${testFileOverride}.js`

		testFiles = await glob(`**/${specificFile}`, { cwd })
		console.log(`Running specific test file: ${specificFile}${isTortureTest ? " (torture test mode)" : ""}`)
	} else {
		testFiles = await glob("**/**.test.js", { cwd })
	}

	if (testFiles.length === 0) {
		throw new Error(`No test files found matching criteria: ${process.env.TEST_FILE || "all tests"}`)
	}

	testFiles.forEach((testFile) => mocha.addFile(path.resolve(cwd, testFile)))

	return new Promise<void>((resolve, reject) =>
		mocha.run((failures) => (failures === 0 ? resolve() : reject(new Error(`${failures} tests failed.`)))),
	)
}
