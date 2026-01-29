import * as vscode from "vscode"

import { TodoItem } from "@roo-code/types"

import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { Task } from "../task/Task"
import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { parseMarkdownChecklist } from "./updateTodoListTool"
import { Package } from "../../shared/package"
import { extractFilePathsFromText, validateFilePaths } from "../../utils/fs"

export async function newTaskTool(
	task: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const mode: string | undefined = block.params.mode
	const message: string | undefined = block.params.message
	const todos: string | undefined = block.params.todos

	try {
		if (block.partial) {
			const partialMessage = JSON.stringify({
				tool: "newTask",
				mode: removeClosingTag("mode", mode),
				content: removeClosingTag("message", message),
				todos: removeClosingTag("todos", todos),
			})

			await task.ask("tool", partialMessage, block.partial).catch(() => {})
			return
		} else {
			// Validate required parameters.
			if (!mode) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "mode"))
				return
			}

			if (!message) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "message"))
				return
			}

			// Get the VSCode setting for requiring todos.
			const provider = task.providerRef.deref()

			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			const state = await provider.getState()

			// Use Package.name (dynamic at build time) as the VSCode configuration namespace.
			// Supports multiple extension variants (e.g., stable/nightly) without hardcoded strings.
			const requireTodos = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false)

			// Check if todos are required based on VSCode setting.
			// Note: `undefined` means not provided, empty string is valid.
			if (requireTodos && todos === undefined) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "todos"))
				return
			}

			// Parse todos if provided, otherwise use empty array
			let todoItems: TodoItem[] = []
			if (todos) {
				try {
					todoItems = parseMarkdownChecklist(todos)
				} catch (error) {
					task.consecutiveMistakeCount++
					task.recordToolError("new_task")
					pushToolResult(formatResponse.toolError("Invalid todos format: must be a markdown checklist"))
					return
				}
			}

			task.consecutiveMistakeCount = 0

			// Un-escape one level of backslashes before '@' for hierarchical subtasks
			// Un-escape one level: \\@ -> \@ (removes one backslash for hierarchical subtasks)
			const unescapedMessage = message.replace(/\\\\@/g, "\\@")

			// Validate file paths mentioned in the subtask message
			// This prevents LLM hallucinations where subtasks are told to work with non-existent files
			const extractedPaths = extractFilePathsFromText(unescapedMessage)
			if (extractedPaths.length > 0) {
				const { nonExistent } = await validateFilePaths(extractedPaths, task.cwd)
				if (nonExistent.length > 0) {
					// Log warning for debugging
					const logProvider = task.providerRef.deref()
					logProvider?.log(
						`[newTaskTool] Warning: Subtask message references non-existent files: ${nonExistent.join(", ")}`
					)
					
					// Return error to the LLM so it can correct itself
					task.consecutiveMistakeCount++
					task.recordToolError("new_task")
					pushToolResult(formatResponse.toolError(
						`Cannot create subtask: The following files do not exist in the workspace:\n` +
						nonExistent.map((f) => `  - ${f}`).join("\n") +
						`\n\nPlease verify these files exist before creating the subtask, or use search_files to find the correct paths.`
					))
					return
				}
			}

			// Verify the mode exists
			const targetMode = getModeBySlug(mode, state?.customModes)

			if (!targetMode) {
				pushToolResult(formatResponse.toolError(`Invalid mode: ${mode}`))
				return
			}

			const toolMessage = JSON.stringify({
				tool: "newTask",
				mode: targetMode.name,
				content: message,
				todos: todoItems,
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			// Provider is guaranteed to be defined here due to earlier check.

			if (task.enableCheckpoints) {
				task.checkpointSave(true)
			}

			// Preserve the current mode so we can resume with it later.
			task.pausedModeSlug = (await provider.getState()).mode ?? defaultModeSlug

			const newTask = await task.startSubtask(unescapedMessage, todoItems, mode)

			if (!newTask) {
				pushToolResult(t("tools:newTask.errors.policy_restriction"))
				return
			}

			pushToolResult(
				`Successfully created new task in ${targetMode.name} mode with message: ${unescapedMessage} and ${todoItems.length} todo items`,
			)

			return
		}
	} catch (error) {
		await handleError("creating new task", error)
		return
	}
}
