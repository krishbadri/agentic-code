import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Git } from "../git.js"

const pexec = promisify(execFile)

async function initRepo(tmp: string) {
	await fs.mkdir(tmp, { recursive: true })
	await pexec("git", ["init"], { cwd: tmp })
	await fs.writeFile(path.join(tmp, "README.md"), "hello\n")
	await pexec("git", ["add", "."], { cwd: tmp })
	await pexec("git", ["commit", "-m", "init"], { cwd: tmp })
	await pexec("git", ["branch", "-M", "main"], { cwd: tmp })
}

describe("Git adapter", () => {
	let tmp: string
	let git: Git

	beforeAll(async () => {
		// Create unique test directory
		tmp = path.join(process.cwd(), `.tmp-git-test-${Date.now()}`)
		git = new Git({ repoRoot: tmp })
		await initRepo(tmp)
	})

	afterAll(async () => {
		await fs.rm(tmp, { recursive: true, force: true })
	})

	it("beginTx, write, checkpoint, status, show", async () => {
		const tx = "11111111-1111-1111-1111-111111111111"
		const base = await git.beginTx(tx, "main")
		expect(base).toMatch(/^[0-9a-f]{40}$/)
		await git.writeFile(tx, "src/a.ts", Buffer.from("export const a=1\n"))
		const st = await git.status(tx)
		expect(st.changes.find((c: any) => c.path.endsWith("src/a.ts"))).toBeTruthy()
		const cp = await git.checkpoint(tx, "[cp] test")
		expect(cp.sha).toMatch(/^[0-9a-f]{40}$/)
		const buf = await git.showFileAt(cp.sha, "src/a.ts")
		expect(buf.toString("utf8")).toContain("a=1")
	})
})
