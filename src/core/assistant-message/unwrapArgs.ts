import type { ToolUse } from "../../shared/tools"

/**
 * Some models wrap every tool's parameters the way read_file documents them:
 *
 *   <write_to_file><args><file><path>a.js</path></file><content>…</content></args></write_to_file>
 *
 * The parser then sees a single `args` parameter and the tool fails with a
 * missing path. For tools that do not take `args` themselves, lift the known
 * parameters out of the wrapper. Parameters given directly always win.
 */
const TOOLS_WITH_NATIVE_ARGS = new Set(["read_file", "apply_diff", "run_slash_command"])

/** Parameters whose value is free text and may itself contain XML-like tags. */
const GREEDY_PARAMS = ["content", "diff"] as const
const SIMPLE_PARAMS = ["path", "line_count", "command", "cwd", "line", "regex", "file_pattern", "recursive", "result"]

export function unwrapArgsParam(block: ToolUse): boolean {
	const params = block.params as Record<string, string | undefined>
	const args = params.args
	if (block.partial || typeof args !== "string" || !args.includes("<")) return false
	if (TOOLS_WITH_NATIVE_ARGS.has(block.name)) return false

	let rest = args
	let lifted = false

	// Free-text parameters first: take everything up to their LAST closing tag, then
	// remove them so tags inside the text cannot be mistaken for parameters.
	for (const name of GREEDY_PARAMS) {
		const open = rest.indexOf(`<${name}>`)
		const close = rest.lastIndexOf(`</${name}>`)
		if (open === -1 || close <= open) continue
		let value = rest.slice(open + name.length + 2, close)
		if (value.startsWith("\n")) value = value.slice(1)
		if (value.endsWith("\n")) value = value.slice(0, -1)
		if (params[name] === undefined) {
			params[name] = value
			lifted = true
		}
		rest = rest.slice(0, open) + rest.slice(close + name.length + 3)
	}

	for (const name of SIMPLE_PARAMS) {
		if (params[name] !== undefined) continue
		const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(rest)
		if (m) {
			params[name] = m[1]!.trim()
			lifted = true
		}
	}

	if (lifted) delete params.args
	return lifted
}
