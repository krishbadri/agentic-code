import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { DiffViewProvider } from "../DiffViewProvider"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({ get: (k: string, d: any) => (k.includes("transactionalMode") ? true : d) })),
		applyEdit: vi.fn().mockResolvedValue(true),
	},
	commands: {
		executeCommand: vi.fn(async (id: string) => (id === "roo.internal.getCurrentTxId" ? "tx-test" : undefined)),
	},
	window: {
		visibleTextEditors: [],
		tabGroups: { all: [] },
		showTextDocument: vi.fn().mockResolvedValue({ document: { uri: { scheme: "file", fsPath: "/tmp/x" } } }),
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	Range: vi.fn(),
	Position: vi.fn(),
	TextEditorRevealType: {},
	languages: { getDiagnostics: vi.fn(() => []) },
}))

describe("DiffViewProvider transactional routing", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		;(global as any).fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ ok: true }) }))
	})

	it("routes saveChanges to control-plane", async () => {
		const task = { providerRef: { deref: () => ({}) } } as any
		const dp = new DiffViewProvider(process.cwd(), task)
		;(dp as any).relPath = "src/a.ts"
		;(dp as any).newContent = "hello\n"
		;(dp as any).editType = "create"
		const res = await dp.saveChanges(true, 0)
		expect(res.userEdits).toBeUndefined()
		expect((global as any).fetch).toHaveBeenCalled()
	})
})
