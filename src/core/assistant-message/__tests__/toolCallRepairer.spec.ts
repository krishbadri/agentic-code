// npx vitest run core/assistant-message/__tests__/toolCallRepairer.spec.ts

import { createStreamingToolCallRepairer, repairToolCalls } from "../toolCallRepairer"

/** Feed text through a fresh streaming repairer in chunks of `size` characters. */
function stream(text: string, size: number): string {
	const repair = createStreamingToolCallRepairer()
	let out = ""
	for (let i = 0; i < text.length; i += size) out += repair(text.slice(i, i + size)).text
	return out
}

const CHUNK_SIZES = [1, 3, 7, 16, 40, 1000]

describe("repairToolCalls (whole message)", () => {
	it("leaves the <command> parameter of execute_command alone", () => {
		const text = "<execute_command>\n<command>npm test</command>\n</execute_command>"
		expect(repairToolCalls(text)).toMatchObject({ repaired: false, text })
	})

	it("repairs an alias tool tag without touching its <command> parameter", () => {
		const r = repairToolCalls("<bash>\n<command>ls -la</command>\n</bash>")
		expect(r.text).toBe("<execute_command>\n<command>ls -la</command>\n</execute_command>")
	})

	it("still treats a bare <command> as execute_command", () => {
		expect(repairToolCalls("<command>ls</command>").text).toBe("<execute_command>ls</execute_command>")
	})

	it("fixes wrong-case tool tags and function-call syntax", () => {
		expect(repairToolCalls("<Write_To_File><path>a</path></Write_To_File>").text).toBe(
			"<write_to_file><path>a</path></write_to_file>",
		)
		expect(repairToolCalls('read_file("src/a.ts")').text).toContain("<read_file>")
	})
})

describe("createStreamingToolCallRepairer", () => {
	it.each(CHUNK_SIZES)("passes a valid execute_command through verbatim (chunk size %i)", (size) => {
		const text = '<execute_command>\n<command>node -e "console.log(6*7)"</command>\n</execute_command>'
		expect(stream(text, size)).toBe(text)
	})

	it.each(CHUNK_SIZES)("never rewrites file content inside write_to_file (chunk size %i)", (size) => {
		// Content full of things the repairer would otherwise "fix": tool-like function
		// calls, alias tags (JSX components), parameter-variant tags.
		const content = [
			"def run_tests():",
			'    shell("pytest -q")',
			'    read_file("notes.txt")',
			"export const A = () => <Command><Terminal lines={3} /></Command>",
			"<lines>3</lines><patch>x</patch><position>1</position><file_path>a</file_path>",
			"bash(['-c', 'echo hi'])",
		].join("\n")
		const text = `I'll write the file.\n<write_to_file>\n<path>src/a.py</path>\n<content>\n${content}\n</content>\n</write_to_file>`
		expect(stream(text, size)).toBe(text)
	})

	it.each(CHUNK_SIZES)("does not close a streamed read_file early (chunk size %i)", (size) => {
		const text = "<read_file>\n<args>\n  <file>\n    <path>src/a.ts</path>\n  </file>\n</args>\n</read_file>"
		expect(stream(text, size)).toBe(text)
	})

	it("still repairs a mistyped tool call that arrives in one chunk, including its closing tag later", () => {
		const repair = createStreamingToolCallRepairer()
		const out = repair("<bash>\n").text + repair("<command>ls -la</command>\n").text + repair("</bash>").text
		expect(out).toBe("<execute_command>\n<command>ls -la</command>\n</execute_command>")
	})

	it("repairs text before a valid tool call but not the call itself", () => {
		const repair = createStreamingToolCallRepairer()
		const out = repair("<execute_command>\n<command>git status</command>\n</execute_command>").text
		expect(out).toBe("<execute_command>\n<command>git status</command>\n</execute_command>")
	})

	it("is per message: a new repairer starts outside any tool call", () => {
		const first = createStreamingToolCallRepairer()
		first("<write_to_file><path>a</path>")
		expect(first("<Terminal/>").text).toBe("<Terminal/>")
		const second = createStreamingToolCallRepairer()
		expect(second("<ReadFile>").text).toBe("<read_file>")
	})
})
