// npx vitest run core/assistant-message/__tests__/unwrapArgs.spec.ts

import { unwrapArgsParam } from "../unwrapArgs"

const block = (name: string, params: Record<string, string>, partial = false) =>
	({ type: "tool_use", name, params, partial }) as any

describe("unwrapArgsParam", () => {
	it("lifts path and content out of a read_file-style wrapper (seen from a real model)", () => {
		const b = block("write_to_file", {
			args: "<file>\n    <path>src/app.js</path>\n  </file>\n  <content>\nfunction alpha() {\n\treturn 10\n}\n</content>",
		})
		expect(unwrapArgsParam(b)).toBe(true)
		expect(b.params).toEqual({ path: "src/app.js", content: "function alpha() {\n\treturn 10\n}" })
	})

	it("keeps tags inside the content as content", () => {
		const b = block("write_to_file", {
			args: "<path>a.html</path><content>\n<div><path>not a param</path></content></div>\n</content>",
		})
		unwrapArgsParam(b)
		expect(b.params.path).toBe("a.html")
		expect(b.params.content).toBe("<div><path>not a param</path></content></div>")
	})

	it("lifts a wrapped command", () => {
		const b = block("execute_command", { args: "<command>npm test</command>" })
		expect(unwrapArgsParam(b)).toBe(true)
		expect(b.params).toEqual({ command: "npm test" })
	})

	it("never overrides parameters given directly and leaves native-args tools alone", () => {
		const direct = block("write_to_file", { path: "real.txt", args: "<path>other.txt</path><content>x</content>" })
		unwrapArgsParam(direct)
		expect(direct.params.path).toBe("real.txt")
		expect(direct.params.content).toBe("x")

		const read = block("read_file", { args: "<file><path>a</path></file>" })
		expect(unwrapArgsParam(read)).toBe(false)
		expect(read.params.args).toBe("<file><path>a</path></file>")
	})

	it("does nothing for partial blocks or plain args", () => {
		expect(unwrapArgsParam(block("write_to_file", { args: "<path>a</path>" }, true))).toBe(false)
		expect(unwrapArgsParam(block("write_to_file", { args: "plain" }))).toBe(false)
		expect(unwrapArgsParam(block("write_to_file", { path: "a" }))).toBe(false)
	})
})
