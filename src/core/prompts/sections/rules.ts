import { DiffStrategy } from "../../../shared/tools"
import { CodeIndexManager } from "../../../services/code-index/manager"

function getEditingInstructions(diffStrategy?: DiffStrategy): string {
	const instructions: string[] = []
	const availableTools: string[] = []

	if (diffStrategy) {
		availableTools.push("apply_diff (surgical edits)", "write_to_file (new files or complete rewrites)")
	} else {
		availableTools.push("write_to_file (new files or complete rewrites)")
	}

	availableTools.push("insert_content (adding lines at a specific position)")
	availableTools.push("search_and_replace (find/replace text or regex, supports multiple operations)")

	if (availableTools.length > 1) {
		instructions.push(`- For editing files, you have access to these tools: ${availableTools.join(", ")}.`)
	}

	instructions.push(
		"- insert_content: adds lines at a line number. Use 0 to append at end, or a positive number to insert before that line.",
	)

	instructions.push(
		"- search_and_replace: finds and replaces text or regex. Supports multiple operations at once. Verify you are replacing the correct text.",
	)

	if (availableTools.length > 1) {
		instructions.push(
			"- Prefer other editing tools over write_to_file for existing files since write_to_file is slower and cannot handle large files.",
		)
	}

	instructions.push(
		"- When using write_to_file, ALWAYS provide the COMPLETE file content. Partial updates or placeholders like '// rest of code unchanged' are STRICTLY FORBIDDEN.",
	)

	return instructions.join("\n")
}

export function getRulesSection(
	cwd: string,
	supportsComputerUse: boolean,
	diffStrategy?: DiffStrategy,
	codeIndexManager?: CodeIndexManager,
): string {
	const isCodebaseSearchAvailable =
		codeIndexManager &&
		codeIndexManager.isFeatureEnabled &&
		codeIndexManager.isFeatureConfigured &&
		codeIndexManager.isInitialized

	const codebaseSearchRule = isCodebaseSearchAvailable
		? "- **CRITICAL: Always use `codebase_search` FIRST before search_files or other exploration tools when examining new code areas.**\n"
		: ""

	return `====

RULES

- The project base directory is: ${cwd.toPosix()}
- All file paths must be relative to this directory. However, commands may change directories in terminals, so respect working directory specified by the response to <execute_command>.
- You cannot \`cd\` into a different directory to complete a task. You are stuck operating from '${cwd.toPosix()}', so pass the correct 'path' parameter when using tools. Do not use ~ or $HOME for the home directory.
- For execute_command: consider the user's OS/shell from SYSTEM INFORMATION. To run commands outside '${cwd.toPosix()}', prepend \`cd (path) && (command)\` as a single command.
${codebaseSearchRule}- When using search_files${isCodebaseSearchAvailable ? " (after codebase_search)" : ""}, craft regex patterns carefully. Use results with read_file to examine context before making changes with ${diffStrategy ? "apply_diff or write_to_file" : "write_to_file"}.
- When creating a new project, organize files within a dedicated project directory. Structure logically following best practices. Unless specified, prefer easily runnable setups (e.g., HTML/CSS/JS).
${getEditingInstructions(diffStrategy)}
- Some modes have restrictions on which files they can edit. If you attempt to edit a restricted file, the operation will be rejected with a FileRestrictionError that will specify which file patterns are allowed for the current mode.
- Be sure to consider the type of project (e.g. Python, JavaScript, web application) when determining the appropriate structure and files to include. Also consider what files may be most relevant to accomplishing the task, for example looking at a project's manifest file would help you understand the project's dependencies, which you could incorporate into any code you write.
  * For example, in architect mode trying to edit app.js would be rejected because architect mode can only edit files matching "\\.md$"
- When making changes to code, always consider the context in which the code is being used. Ensure that your changes are compatible with the existing codebase and that they follow the project's coding standards and best practices.
- **Before implementing any interface, protocol, or abstract class:** read_file the existing definitions first, study existing implementations, and match exact signatures. Run tests after implementation.
- Use the tools provided to accomplish tasks efficiently. When done, use attempt_completion. The user may provide feedback for improvements.
- Only ask the user questions via ask_followup_question when you need additional details. Provide 2-4 suggested answers. Prefer using tools to find information yourself rather than asking the user.
- When executing commands, if you don't see expected output, assume success and proceed. If you need terminal output, use ask_followup_question.
- The user may provide a file's contents directly in their message, in which case you shouldn't use the read_file tool to get the file contents again since you already have it.
- Your goal is to try to accomplish the user's task, NOT engage in a back and forth conversation.${
		supportsComputerUse
			? '\n- The user may ask generic non-development tasks, such as "what\'s the latest news" or "look up the weather in San Diego", in which case you might use the browser_action tool to complete the task if it makes sense to do so, rather than trying to create a website or using curl to answer the question. However, if an available MCP server tool or resource can be used instead, you should prefer to use it over browser_action.'
			: ""
	}
- NEVER end attempt_completion result with a question or request to engage in further conversation! Formulate the end of your result in a way that is final and does not require further input from the user.
- You are STRICTLY FORBIDDEN from starting your messages with "Great", "Certainly", "Okay", "Sure". You should NOT be conversational in your responses, but rather direct and to the point. For example you should NOT say "Great, I've updated the CSS" but instead something like "I've updated the CSS". It is important you be clear and technical in your messages.
- When presented with images, utilize your vision capabilities to thoroughly examine them and extract meaningful information. Incorporate these insights into your thought process as you accomplish the user's task.
- environment_details at the end of each message is auto-generated context about the project, not part of the user's request. Use it to inform decisions but don't assume the user is referring to it.
- Check "Actively Running Terminals" in environment_details before executing commands to avoid duplicating running processes.
- MCP operations should be used one at a time. Wait for confirmation before proceeding.
- Wait for the user's response after each tool use to confirm success before proceeding.${
		supportsComputerUse
			? " When using browser_action, wait for screenshot confirmation after each action before proceeding."
			: ""
	}`
}
