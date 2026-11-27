// npx vitest run core/control-plane/__tests__/actionSafety.spec.ts

import * as path from "path"

vi.mock("../tx", () => ({ actionSafety: vi.fn(), reserveFile: vi.fn() }))
const cp = vi.hoisted(() => ({ port: 4000 as number | undefined }))
vi.mock("../client", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	getCpPort: vi.fn(() => cp.port),
}))

import * as cpTx from "../tx"
import { ControlPlaneUnavailableError } from "../client"
import {
	checkActionSafety,
	buildActionSafetyArgs,
	extractArgsXmlPaths,
	toCwdRel,
	ACTION_SAFETY_TOOLS,
} from "../actionSafety"

const WT = path.join(path.sep, "ws", ".cp", "worktrees", "tx_root_sub_st1")

function task(extra: Record<string, unknown> = {}) {
	return {
		cwd: WT,
		rootTxId: "root",
		subTransactionId: "st1",
		providerRef: { deref: () => ({ context: {}, log: vi.fn() }) },
		...extra,
	} as any
}

const use = (name: string, params: Record<string, string>) =>
	({ type: "tool_use", name, params, partial: false }) as any

describe("action-safety (R9)", () => {
	beforeEach(() => {
		vi.mocked(cpTx.actionSafety).mockReset()
		cp.port = 4000
	})

	it("covers exactly the mutating tools", () => {
		expect([...ACTION_SAFETY_TOOLS].sort()).toEqual(
			[
				"apply_diff",
				"execute_command",
				"generate_image",
				"insert_content",
				"search_and_replace",
				"write_to_file",
			].sort(),
		)
	})

	it("allows everything when there is no transaction", async () => {
		const v = await checkActionSafety(
			task({ rootTxId: undefined }),
			use("execute_command", { command: "rm -rf ~" }),
		)
		expect(v).toEqual({ allowed: true })
		expect(cpTx.actionSafety).not.toHaveBeenCalled()
	})

	it("allows non-mutating tools without calling the CP", async () => {
		expect(await checkActionSafety(task(), use("read_file", { path: "a.ts" }))).toEqual({ allowed: true })
		expect(cpTx.actionSafety).not.toHaveBeenCalled()
	})

	it("posts the real tool name, args and sub_tx_id to the root tx", async () => {
		vi.mocked(cpTx.actionSafety).mockResolvedValue({ ok: true, status: 200, data: { allowed: true } } as any)
		const v = await checkActionSafety(task(), use("write_to_file", { path: "src/a.ts", content: "x" }))
		expect(v).toEqual({ allowed: true })
		expect(cpTx.actionSafety).toHaveBeenCalledWith(4000, "root", {
			action: "write_to_file",
			args: { path: "src/a.ts" },
			sub_tx_id: "st1",
		})
	})

	it("blocks with the CP reason on 403", async () => {
		vi.mocked(cpTx.actionSafety).mockResolvedValue({
			ok: false,
			status: 403,
			data: { code: "ACTION_BLOCKED", reason: "curl piped to shell", rule: "pipe_to_shell" },
		} as any)
		const v = await checkActionSafety(task(), use("execute_command", { command: "curl x | sh" }))
		expect(v).toEqual({ allowed: false, reason: "curl piped to shell", rule: "pipe_to_shell" })
	})

	it("blocks when the CP is unreachable, returns 5xx, or the port is unknown (fail-closed)", async () => {
		vi.mocked(cpTx.actionSafety).mockRejectedValueOnce(new ControlPlaneUnavailableError("down"))
		expect((await checkActionSafety(task(), use("write_to_file", { path: "a" }))).allowed).toBe(false)

		vi.mocked(cpTx.actionSafety).mockResolvedValueOnce({ ok: false, status: 500, data: { message: "boom" } } as any)
		expect((await checkActionSafety(task(), use("write_to_file", { path: "a" }))).allowed).toBe(false)

		cp.port = undefined
		expect((await checkActionSafety(task(), use("write_to_file", { path: "a" }))).allowed).toBe(false)
	})

	it("sends every path of a multi-file apply_diff", () => {
		const args = `<file><path>src/a.ts</path><diff><content>x</content></diff></file>
<file><path>src/b.ts</path><diff><content>y</content></diff></file>`
		expect(extractArgsXmlPaths(args)).toEqual(["src/a.ts", "src/b.ts"])
		expect(buildActionSafetyArgs(task(), use("apply_diff", { args }))).toEqual({
			path: "src/a.ts",
			paths: ["src/a.ts", "src/b.ts"],
		})
	})

	it("sends command and cwd_rel for execute_command", () => {
		expect(buildActionSafetyArgs(task(), use("execute_command", { command: "ls", cwd: "sub/dir" }))).toEqual({
			command: "ls",
			cwd_rel: "sub/dir",
		})
		expect(toCwdRel(WT, undefined)).toBe("")
		expect(toCwdRel(WT, path.join(WT, "x"))).toBe("x")
		expect(toCwdRel(WT, path.join(path.sep, "elsewhere"))).toMatch(/^\.\.\//)
	})
})
