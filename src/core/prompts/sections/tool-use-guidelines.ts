import { CodeIndexManager } from "../../../services/code-index/manager"

export function getToolUseGuidelinesSection(codeIndexManager?: CodeIndexManager): string {
	const isCodebaseSearchAvailable =
		codeIndexManager &&
		codeIndexManager.isFeatureEnabled &&
		codeIndexManager.isFeatureConfigured &&
		codeIndexManager.isInitialized

	// Build guidelines array with automatic numbering
	let itemNumber = 1
	const guidelinesList: string[] = []

	// First guideline is always the same
	guidelinesList.push(
		`${itemNumber++}. Assess what information you already have and what information you need to proceed with the task.`,
	)

	// Conditional codebase search guideline
	if (isCodebaseSearchAvailable) {
		guidelinesList.push(
			`${itemNumber++}. **CRITICAL: Always use \`codebase_search\` FIRST before other search/exploration tools when examining new code areas.** It uses semantic search based on meaning, not just keywords.`,
		)
		guidelinesList.push(
			`${itemNumber++}. Choose the most appropriate tool for each step. After codebase_search, use search_files (regex), list_files, or read_file for details. Prefer built-in tools over CLI equivalents (e.g., list_files over \`ls\`).`,
		)
	} else {
		guidelinesList.push(
			`${itemNumber++}. Choose the most appropriate tool for each step. Prefer built-in tools over CLI equivalents (e.g., list_files over \`ls\`).`,
		)
	}

	// Remaining guidelines
	guidelinesList.push(
		`${itemNumber++}. If multiple actions are needed, use one tool at a time per message to accomplish the task iteratively, with each tool use being informed by the result of the previous tool use. Do not assume the outcome of any tool use. Each step must be informed by the previous step's result.`,
	)
	guidelinesList.push(`${itemNumber++}. Formulate your tool use using the XML format specified for each tool.`)
	guidelinesList.push(
		`${itemNumber++}. After each tool use, the user will respond with the result (success/failure, linter errors, terminal output, or other feedback). Use this to inform your next step.`,
	)
	guidelinesList.push(
		`${itemNumber++}. ALWAYS wait for user confirmation after each tool use before proceeding. Never assume the success of a tool use without explicit confirmation of the result from the user.`,
	)

	return `# Tool Use Guidelines

${guidelinesList.join("\n")}`
}
