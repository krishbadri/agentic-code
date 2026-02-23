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

	await api.setConfiguration({
		apiProvider: "openai" as const,
		openAiApiKey: process.env.OPENAI_API_KEY!,
		openAiModelId: process.env.OPENAI_MODEL_ID || "gpt-4",
	})

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
	const testFileOverride = isTortureTest ? "task.test.js" : process.env.TEST_FILE

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
