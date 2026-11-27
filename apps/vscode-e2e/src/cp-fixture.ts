/**
 * TEST_CP_E2E=1: a throw-away git repository (small Node project with a TAP
 * test script) used as the workspace for the Control-Plane end-to-end suite.
 */
import { execFileSync } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const lines = (...l: string[]) => l.join("\n") + "\n"

export const CP_FIXTURE_FILES: Record<string, string> = {
	"package.json":
		JSON.stringify(
			{ name: "cp-e2e-fixture", version: "1.0.0", private: true, scripts: { test: "node run-tests.js" } },
			null,
			2,
		) + "\n",
	"src/calc.js": lines(
		"function add(a, b) {",
		"\treturn a + b",
		"}",
		"",
		"function sub(a, b) {",
		"\treturn a - b",
		"}",
		"",
		"module.exports = { add, sub }",
	),
	"src/app.js": lines(
		"function alpha() {",
		"\treturn 1",
		"}",
		"",
		"function beta() {",
		"\treturn 2",
		"}",
		"",
		"module.exports = { alpha, beta }",
	),
	"run-tests.js": lines(
		'const calc = require("./src/calc.js")',
		'const app = require("./src/app.js")',
		"const checks = [",
		'\t["add", calc.add(2, 2) === 4],',
		'\t["sub", calc.sub(5, 3) === 2],',
		'\t["app returns numbers", typeof app.alpha() === "number" && typeof app.beta() === "number"],',
		"]",
		'console.log("TAP version 13")',
		'console.log("1.." + checks.length)',
		"let failed = 0",
		"checks.forEach(([name, ok], i) => {",
		"\tif (!ok) failed++",
		'\tconsole.log((ok ? "ok" : "not ok") + " " + (i + 1) + " - " + name)',
		"})",
		"process.exit(failed ? 1 : 0)",
	),
	".gitignore": "node_modules/\n",
	".gitattributes": "* text=auto eol=lf\n",
}

export async function createCpFixtureWorkspace(): Promise<string> {
	// realpath: on Windows the temp dir can be an 8.3 short path.
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "roo-cp-e2e-")))
	for (const [rel, content] of Object.entries(CP_FIXTURE_FILES)) {
		const full = path.join(dir, rel)
		await fs.mkdir(path.dirname(full), { recursive: true })
		await fs.writeFile(full, content, "utf-8")
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true })
	git("init")
	git("config", "user.name", "cp-e2e")
	git("config", "user.email", "cp-e2e@example.invalid")
	git("config", "core.autocrlf", "false")
	git("add", "-A")
	git("commit", "-m", "fixture")
	git("branch", "-M", "main")
	return dir
}
