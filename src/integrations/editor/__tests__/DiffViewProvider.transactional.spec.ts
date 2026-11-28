import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { DiffViewProvider } from "../DiffViewProvider"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({ get: (k: string, d: any) => (k.includes("transactionalMode") ? true : d) })),
		applyEdit: vi.fn().mockResolvedValue(true),
		openTextDocument: vi.fn().mockResolvedValue({ uri: { fsPath: "/tmp/x" } }),
	},
	commands: {
		executeCommand: vi.fn(async () => undefined),
	},
	window: {
		visibleTextEditors: [],
		tabGroups: { all: [] },
		showTextDocument: vi.fn().mockResolvedValue({ document: { uri: { scheme: "file", fsPath: "/tmp/x" } } }),
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	Range: vi.fn(),
	Position: vi.fn(),
	TextEditorRevealType: {},
	ViewColumn: { Active: 1 },
	languages: { getDiagnostics: vi.fn(() => []) },
}))

/**
 * In transactional mode the task's cwd IS the transaction worktree, so the
 * DiffViewProvider writes straight to disk there and never talks to the
 * Control-Plane (the old /write and /apply routing was removed).
 */
describe("DiffViewProvider in transactional mode", () => {
	let dir: string

	beforeEach(async () => {
		vi.clearAllMocks()
		;(global as any).fetch = vi.fn()
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "dvp-tx-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("saveDirectly writes into cwd (the worktree) without calling the Control-Plane", async () => {
		const task = { providerRef: { deref: () => ({}) }, transactionalTxId: "tx_sub" } as any
		const dp = new DiffViewProvider(dir, task)
		const res = await dp.saveDirectly("src/a.ts", "hello\n", false, false, 0)
		expect(res.finalContent).toBe("hello\n")
		expect(await fs.readFile(path.join(dir, "src/a.ts"), "utf-8")).toBe("hello\n")
		expect((global as any).fetch).not.toHaveBeenCalled()
	})

	it("saveChanges never routes to the Control-Plane", async () => {
		const task = { providerRef: { deref: () => ({}) } } as any
		const dp = new DiffViewProvider(dir, task)
		;(dp as any).relPath = "src/a.ts"
		;(dp as any).newContent = "hello\n"
		;(dp as any).editType = "create"
		// No active diff editor → nothing to save, and no network call.
		const res = await dp.saveChanges(true, 0)
		expect(res.finalContent).toBeUndefined()
		expect((global as any).fetch).not.toHaveBeenCalled()
	})
})
