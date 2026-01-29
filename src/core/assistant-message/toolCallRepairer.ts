import { type ToolName, toolNames } from "@roo-code/types"

/**
 * Tool Call Repairer - Automatically fixes common tool call mistakes
 * to ensure deterministic, error-free tool execution.
 * 
 * This is a critical component for research-grade systems that require
 * zero errors. Instead of rejecting mistakes, we repair them automatically.
 */

interface RepairResult {
	repaired: boolean
	text: string
	repairs: string[]
}

/**
 * Normalizes tool name to match valid toolNames (case-insensitive, handles variants)
 */
function normalizeToolName(input: string): ToolName | null {
	const lower = input.toLowerCase().trim()
	
	// Direct match (case-insensitive)
	for (const toolName of toolNames) {
		if (toolName.toLowerCase() === lower) {
			return toolName
		}
	}
	
	// Handle common variants
	const variants: Record<string, ToolName> = {
		"readfile": "read_file",
		"read-file": "read_file",
		"readFile": "read_file",
		"searchfiles": "search_files",
		"search-files": "search_files",
		"searchFiles": "search_files",
		"writefile": "write_to_file",
		"write-file": "write_to_file",
		"writeFile": "write_to_file",
		"writetofile": "write_to_file",
		"write-to-file": "write_to_file",
		"executecommand": "execute_command",
		"execute-command": "execute_command",
		"executeCommand": "execute_command",
		"bash": "execute_command",
		"command": "execute_command",
		"askquestion": "ask_followup_question",
		"ask-question": "ask_followup_question",
		"askQuestion": "ask_followup_question",
		"listfiles": "list_files",
		"list-files": "list_files",
		"listFiles": "list_files",
		"codebasesearch": "codebase_search",
		"codebase-search": "codebase_search",
		"codebaseSearch": "codebase_search",
	}
	
	if (variants[lower]) {
		return variants[lower]
	}
	
	return null
}

/**
 * Repairs function-call syntax to XML format
 * Handles: read_file(["path"]) → <read_file><args>...</args></read_file>
 */
function repairFunctionCallSyntax(text: string): RepairResult {
	const repairs: string[] = []
	let repaired = false
	let result = text
	
	// Pattern: tool_name([...]) or tool_name("...") or tool_name({...})
	const functionCallPattern = /(\w+)\s*\((\[[^\]]*\]|"[^"]*"|\{[^}]*\}|[^)]*)\)/g
	
	result = result.replace(functionCallPattern, (match, toolName, args) => {
		const normalized = normalizeToolName(toolName)
		if (!normalized) {
			return match // Not a tool, leave as-is
		}
		
		repaired = true
		repairs.push(`Converted function-call syntax: ${toolName}(...) → <${normalized}>`)
		
		// Parse arguments based on format
		let xmlArgs = ""
		
		// Array format: ["path"] or ["path1", "path2"]
		if (args.trim().startsWith("[")) {
			try {
				const parsed = JSON.parse(args)
				if (Array.isArray(parsed)) {
					if (normalized === "read_file") {
						// read_file(["path"]) → <read_file><args><file><path>path</path></file></args></read_file>
						const fileElements = parsed.map((path: string) => 
							`  <file>\n    <path>${path}</path>\n  </file>`
						).join("\n")
						xmlArgs = `<args>\n${fileElements}\n</args>`
					} else if (normalized === "search_files") {
						// search_files([".", ".*"]) → <search_files><path>.</path><regex>.*</regex></search_files>
						if (parsed.length >= 1) {
							xmlArgs = `<path>${parsed[0]}</path>`
							if (parsed.length >= 2) {
								xmlArgs += `\n<regex>${parsed[1]}</regex>`
							}
							if (parsed.length >= 3) {
								xmlArgs += `\n<file_pattern>${parsed[2]}</file_pattern>`
							}
						}
					} else {
						// Generic array → wrap in args
						const paramElements = parsed.map((val: string, idx: number) => 
							`  <param${idx}>${val}</param${idx}>`
						).join("\n")
						xmlArgs = `<args>\n${paramElements}\n</args>`
					}
				}
			} catch {
				// If JSON parse fails, try to extract strings
				const stringMatches = args.match(/"([^"]+)"/g)
				if (stringMatches && normalized === "read_file") {
					const paths = stringMatches.map((m: string) => m.slice(1, -1))
					const fileElements = paths.map((path: string) => 
						`  <file>\n    <path>${path}</path>\n  </file>`
					).join("\n")
					xmlArgs = `<args>\n${fileElements}\n</args>`
				}
			}
		}
		// String format: "path"
		else if (args.trim().startsWith('"') || args.trim().startsWith("'")) {
			const path = args.trim().slice(1, -1)
			if (normalized === "read_file") {
				xmlArgs = `<args>\n  <file>\n    <path>${path}</path>\n  </file>\n</args>`
			} else if (normalized === "search_files") {
				xmlArgs = `<path>${path}</path>`
			} else {
				xmlArgs = `<args>${path}</args>`
			}
		}
		// Object format: {path: ".", regex: ".*"}
		else if (args.trim().startsWith("{")) {
			try {
				const parsed = JSON.parse(args)
				if (normalized === "search_files") {
					xmlArgs = ""
					if (parsed.path) xmlArgs += `<path>${parsed.path}</path>\n`
					if (parsed.regex) xmlArgs += `<regex>${parsed.regex}</regex>\n`
					if (parsed.file_pattern) xmlArgs += `<file_pattern>${parsed.file_pattern}</file_pattern>`
					xmlArgs = xmlArgs.trim()
				} else if (normalized === "read_file" && parsed.path) {
					xmlArgs = `<args>\n  <file>\n    <path>${parsed.path}</path>\n  </file>\n</args>`
				} else {
					// Generic object → convert to XML params
					const paramElements = Object.entries(parsed).map(([key, val]) => 
						`  <${key}>${val}</${key}>`
					).join("\n")
					xmlArgs = `<args>\n${paramElements}\n</args>`
				}
			} catch {
				// If JSON parse fails, try regex extraction
				const pathMatch = args.match(/path["\s:]+([^,}]+)/)
				if (pathMatch && normalized === "read_file") {
					const path = pathMatch[1].trim().replace(/["']/g, "")
					xmlArgs = `<args>\n  <file>\n    <path>${path}</path>\n  </file>\n</args>`
				}
			}
		}
		
		// Default: wrap in args if no specific format detected
		if (!xmlArgs && args.trim()) {
			xmlArgs = `<args>${args.trim()}</args>`
		}
		
		return `<${normalized}>\n${xmlArgs}\n</${normalized}>`
	})
	
	return { repaired, text: result, repairs }
}

/**
 * Repairs XML tool calls with common mistakes:
 * - Wrong case: <ReadFile> → <read_file>
 * - Missing closing tags: <read_file><path>...</path> → adds </read_file>
 * - Missing args wrapper: <read_file><path>...</path> → <read_file><args><file><path>...</path></file></args></read_file>
 * - Malformed structure
 */
function repairXmlToolCalls(text: string): RepairResult {
	const repairs: string[] = []
	let repaired = false
	let result = text
	
	// Pattern to find XML tool tags (case-insensitive)
	const xmlTagPattern = /<(\w+)(?:\s[^>]*)?>/gi
	
	result = result.replace(xmlTagPattern, (match, tagName) => {
		const normalized = normalizeToolName(tagName)
		if (!normalized) {
			return match // Not a tool tag
		}
		
		if (tagName !== normalized) {
			repaired = true
			repairs.push(`Fixed case: <${tagName}> → <${normalized}>`)
			return `<${normalized}>`
		}
		
		return match
	})
	
	// Fix missing </read_file> closing tags
	// Pattern: <read_file>...<path>...</path> (no closing tag)
	const readFilePattern = /<read_file>([\s\S]*?)(?=<\/read_file>|$)/gi
	result = result.replace(readFilePattern, (match, content) => {
		if (!match.includes("</read_file>")) {
			// Check if it has proper structure
			if (content.includes("<path>") && !content.includes("<args>")) {
				// Missing args wrapper - add it
				const pathMatch = content.match(/<path>([^<]+)<\/path>/)
				if (pathMatch) {
					repaired = true
					repairs.push("Added missing <args> wrapper for read_file")
					return `<read_file><args>\n  <file>\n    <path>${pathMatch[1]}</path>\n  </file>\n</args></read_file>`
				}
			}
			
			// Add closing tag if missing
			if (!match.endsWith("</read_file>")) {
				repaired = true
				repairs.push("Added missing </read_file> closing tag")
				return match + "</read_file>"
			}
		}
		return match
	})
	
	// Fix missing </search_files> closing tags
	const searchFilesPattern = /<search_files>([\s\S]*?)(?=<\/search_files>|$)/gi
	result = result.replace(searchFilesPattern, (match, content) => {
		if (!match.includes("</search_files>")) {
			// Check if path is missing
			if (!content.includes("<path>")) {
				// Try to infer path from context or use "."
				repaired = true
				repairs.push("Added missing <path> parameter to search_files (defaulting to '.')")
				const regexMatch = content.match(/<regex>([^<]+)<\/regex>/)
				const filePatternMatch = content.match(/<file_pattern>([^<]+)<\/file_pattern>/)
				
				let fixed = "<search_files>\n<path>.</path>\n"
				if (regexMatch) {
					fixed += `<regex>${regexMatch[1]}</regex>\n`
				} else {
					fixed += "<regex>.*</regex>\n"
				}
				if (filePatternMatch) {
					fixed += `<file_pattern>${filePatternMatch[1]}</file_pattern>\n`
				}
				fixed += "</search_files>"
				return fixed
			}
			
			// Add closing tag if missing
			if (!match.endsWith("</search_files>")) {
				repaired = true
				repairs.push("Added missing </search_files> closing tag")
				return match + "</search_files>"
			}
		}
		return match
	})
	
	// Fix read_file missing args structure: <read_file><path>...</path></read_file>
	// Should be: <read_file><args><file><path>...</path></file></args></read_file>
	const readFileMissingArgsPattern = /<read_file>\s*<path>([^<]+)<\/path>\s*<\/read_file>/gi
	result = result.replace(readFileMissingArgsPattern, (match, path) => {
		repaired = true
		repairs.push("Fixed read_file structure: added <args> and <file> wrappers")
		return `<read_file>\n<args>\n  <file>\n    <path>${path.trim()}</path>\n  </file>\n</args>\n</read_file>`
	})
	
	return { repaired, text: result, repairs }
}

/**
 * Detects and repairs tool calls embedded in text (when model outputs tool calls as text)
 * This handles cases where the model mentions using a tool but doesn't actually call it
 */
function repairEmbeddedToolCalls(text: string): RepairResult {
	const repairs: string[] = []
	let repaired = false
	let result = text
	
	// This function is kept for future enhancements but currently doesn't need to do anything
	// because the main repair functions (function-call syntax and XML repair) handle the actual repairs.
	// If we need to detect "I will use read_file" patterns and convert them, we can add that here.
	
	return { repaired, text: result, repairs }
}

/**
 * Main repair function - applies all repair strategies
 */
export function repairToolCalls(text: string): RepairResult {
	let current = text
	const allRepairs: string[] = []
	let anyRepaired = false
	
	// Strategy 1: Repair function-call syntax
	const funcResult = repairFunctionCallSyntax(current)
	if (funcResult.repaired) {
		current = funcResult.text
		allRepairs.push(...funcResult.repairs)
		anyRepaired = true
	}
	
	// Strategy 2: Repair XML tool calls
	const xmlResult = repairXmlToolCalls(current)
	if (xmlResult.repaired) {
		current = xmlResult.text
		allRepairs.push(...xmlResult.repairs)
		anyRepaired = true
	}
	
	// Strategy 3: Repair embedded tool calls
	const embeddedResult = repairEmbeddedToolCalls(current)
	if (embeddedResult.repaired) {
		current = embeddedResult.text
		allRepairs.push(...embeddedResult.repairs)
		anyRepaired = true
	}
	
	return {
		repaired: anyRepaired,
		text: current,
		repairs: allRepairs,
	}
}

/**
 * Validates that a repaired tool call can be parsed
 * Returns true if the text contains valid tool calls
 */
export function validateRepairedToolCalls(text: string): boolean {
	// Check if text contains at least one valid tool call pattern
	for (const toolName of toolNames) {
		const pattern = new RegExp(`<${toolName}>[\\s\\S]*?</${toolName}>`, "i")
		if (pattern.test(text)) {
			return true
		}
	}
	return false
}
