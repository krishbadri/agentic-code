import cloneDeep from "clone-deep"
import { serializeError } from "serialize-error"

import type { ToolName, ClineAsk, ToolProgressStatus } from "@roo-code/types"
import type { ClineAskResponse } from "../../shared/WebviewMessage"
import { getApiProtocol, getModelId } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import type { ToolParamName, ToolResponse } from "../../shared/tools"

import { fetchInstructionsTool } from "../tools/fetchInstructionsTool"
import { listFilesTool } from "../tools/listFilesTool"
import { getReadFileToolDescription, readFileTool } from "../tools/readFileTool"
import { getSimpleReadFileToolDescription, simpleReadFileTool } from "../tools/simpleReadFileTool"
import { shouldUseSingleFileRead } from "@roo-code/types"
import { writeToFileTool } from "../tools/writeToFileTool"
import { applyDiffTool } from "../tools/multiApplyDiffTool"
import { insertContentTool } from "../tools/insertContentTool"
import { searchAndReplaceTool } from "../tools/searchAndReplaceTool"
import { listCodeDefinitionNamesTool } from "../tools/listCodeDefinitionNamesTool"
import { searchFilesTool } from "../tools/searchFilesTool"
import { browserActionTool } from "../tools/browserActionTool"
import { executeCommandTool } from "../tools/executeCommandTool"
import { saveCheckpointTool } from "../tools/saveCheckpointTool"
import { rollbackToCheckpointTool } from "../tools/rollbackToCheckpointTool"
import { useMcpToolTool } from "../tools/useMcpToolTool"
import { accessMcpResourceTool } from "../tools/accessMcpResourceTool"
import { askFollowupQuestionTool } from "../tools/askFollowupQuestionTool"
import { switchModeTool } from "../tools/switchModeTool"
import { attemptCompletionTool } from "../tools/attemptCompletionTool"
import { newTaskTool } from "../tools/newTaskTool"

import { updateTodoListTool } from "../tools/updateTodoListTool"
import { runSlashCommandTool } from "../tools/runSlashCommandTool"
import { generateImageTool } from "../tools/generateImageTool"

import { formatResponse } from "../prompts/responses"
import { validateToolUse } from "../tools/validateToolUse"
import { Task } from "../task/Task"
import { codebaseSearchTool } from "../tools/codebaseSearchTool"
import { experiments, EXPERIMENT_IDS } from "../../shared/experiments"
import { applyDiffToolLegacy } from "../tools/applyDiffTool"
import { evaluateQualityGate, executeQualityGateRollback, recordCheckpointSaved } from "../checkpoints/QualityGate"

/**
 * Processes and presents assistant message content to the user interface.
 *
 * This function is the core message handling system that:
 * - Sequentially processes content blocks from the assistant's response.
 * - Displays text content to the user.
 * - Executes tool use requests with appropriate user approval.
 * - Manages the flow of conversation by determining when to proceed to the next content block.
 * - Coordinates file system checkpointing for modified files.
 * - Controls the conversation state to determine when to continue to the next request.
 *
 * The function uses a locking mechanism to prevent concurrent execution and handles
 * partial content blocks during streaming. It's designed to work with the streaming
 * API response pattern, where content arrives incrementally and needs to be processed
 * as it becomes available.
 */

export async function presentAssistantMessage(cline: Task) {
	if (cline.abort) {
		throw new Error(`[Task#presentAssistantMessage] task ${cline.taskId}.${cline.instanceId} aborted`)
	}

	if (cline.presentAssistantMessageLocked) {
		cline.presentAssistantMessageHasPendingUpdates = true
		return
	}

	cline.presentAssistantMessageLocked = true
	cline.presentAssistantMessageHasPendingUpdates = false

	if (cline.currentStreamingContentIndex >= cline.assistantMessageContent.length) {
		// This may happen if the last content block was completed before
		// streaming could finish. If streaming is finished, and we're out of
		// bounds then this means we already  presented/executed the last
		// content block and are ready to continue to next request.
		if (cline.didCompleteReadingStream) {
			cline.userMessageContentReady = true
		}

		cline.presentAssistantMessageLocked = false
		return
	}

	const block = cloneDeep(cline.assistantMessageContent[cline.currentStreamingContentIndex]) // need to create copy bc while stream is updating the array, it could be updating the reference block properties too

	switch (block.type) {
		case "text": {
			if (cline.didRejectTool || cline.didAlreadyUseTool) {
				break
			}

			let content = block.content

			if (content) {
				// Have to do this for partial and complete since sending
				// content in thinking tags to markdown renderer will
				// automatically be removed.
				// Remove end substrings of <thinking or </thinking (below xml
				// parsing is only for opening tags).
				// Tthis is done with the xml parsing below now, but keeping
				// here for reference.
				// content = content.replace(/<\/?t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?$/, "")
				//
				// Remove all instances of <thinking> (with optional line break
				// after) and </thinking> (with optional line break before).
				// - Needs to be separate since we dont want to remove the line
				//   break before the first tag.
				// - Needs to happen before the xml parsing below.
				content = content.replace(/<thinking>\s?/g, "")
				content = content.replace(/\s?<\/thinking>/g, "")

				// Remove partial XML tag at the very end of the content (for
				// tool use and thinking tags), Prevents scrollview from
				// jumping when tags are automatically removed.
				const lastOpenBracketIndex = content.lastIndexOf("<")

				if (lastOpenBracketIndex !== -1) {
					const possibleTag = content.slice(lastOpenBracketIndex)

					// Check if there's a '>' after the last '<' (i.e., if the
					// tag is complete) (complete thinking and tool tags will
					// have been removed by now.)
					const hasCloseBracket = possibleTag.includes(">")

					if (!hasCloseBracket) {
						// Extract the potential tag name.
						let tagContent: string

						if (possibleTag.startsWith("</")) {
							tagContent = possibleTag.slice(2).trim()
						} else {
							tagContent = possibleTag.slice(1).trim()
						}

						// Check if tagContent is likely an incomplete tag name
						// (letters and underscores only).
						const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)

						// Preemptively remove < or </ to keep from these
						// artifacts showing up in chat (also handles closing
						// thinking tags).
						const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"

						// If the tag is incomplete and at the end, remove it
						// from the content.
						if (isOpeningOrClosing || isLikelyTagName) {
							content = content.slice(0, lastOpenBracketIndex).trim()
						}
					}
				}
			}

			await cline.say("text", content, undefined, block.partial)
			break
		}
		case "tool_use": {
			const vcrModeForLogging = (process.env.ROO_VCR_MODE || "off").toLowerCase()
			const isTortureVcrForLogging =
				process.env.TEST_TORTURE_REPO === "1" &&
				(vcrModeForLogging === "record" || vcrModeForLogging === "replay")

			// Logging: Track tool execution dispatch
			const modelId = cline.api.getModel().id
			const apiProtocol = getApiProtocol((cline.apiConfiguration as any)?.apiProvider, modelId)
			const provider = await cline.providerRef.deref()
			// In torture VCR runs, tool_use blocks often stream for hundreds of chunks; logging each partial
			// detection makes the run dramatically slower/noisier. Only log detection for complete tool calls.
			if (provider && process.env.ROO_DEBUG_TOOL_EXECUTION && (!block.partial || !isTortureVcrForLogging)) {
				provider.log(
					`[presentAssistantMessage] Tool call detected - Name: ${block.name}, Protocol: ${apiProtocol}, Provider: ${(cline.apiConfiguration as any)?.apiProvider}, Model: ${modelId}, Params: ${JSON.stringify(block.params).substring(0, 200)}`,
				)
			}

			const toolDescription = (): string => {
				switch (block.name) {
					case "execute_command":
						return `[${block.name} for '${block.params.command}']`
					case "save_checkpoint":
						return `[${block.name} named '${block.params.name ?? "checkpoint"}']`
					case "rollback_to_checkpoint":
						return `[${block.name} to '${block.params.checkpoint_name ?? block.params.commit_hash ?? "checkpoint"}']`
					case "read_file":
						// Check if this model should use the simplified description
						const modelId = cline.api.getModel().id
						if (shouldUseSingleFileRead(modelId)) {
							return getSimpleReadFileToolDescription(block.name, block.params)
						} else {
							return getReadFileToolDescription(block.name, block.params)
						}
					case "fetch_instructions":
						return `[${block.name} for '${block.params.task}']`
					case "write_to_file":
						return `[${block.name} for '${block.params.path}']`
					case "apply_diff":
						// Handle both legacy format and new multi-file format
						if (block.params.path) {
							return `[${block.name} for '${block.params.path}']`
						} else if (block.params.args) {
							// Try to extract first file path from args for display
							const match = block.params.args.match(/<file>.*?<path>([^<]+)<\/path>/s)
							if (match) {
								const firstPath = match[1]
								// Check if there are multiple files
								const fileCount = (block.params.args.match(/<file>/g) || []).length
								if (fileCount > 1) {
									return `[${block.name} for '${firstPath}' and ${fileCount - 1} more file${fileCount > 2 ? "s" : ""}]`
								} else {
									return `[${block.name} for '${firstPath}']`
								}
							}
						}
						return `[${block.name}]`
					case "search_files":
						return `[${block.name} for '${block.params.regex}'${
							block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
						}]`
					case "insert_content":
						return `[${block.name} for '${block.params.path}']`
					case "search_and_replace":
						return `[${block.name} for '${block.params.path}']`
					case "list_files":
						return `[${block.name} for '${block.params.path}']`
					case "list_code_definition_names":
						return `[${block.name} for '${block.params.path}']`
					case "browser_action":
						return `[${block.name} for '${block.params.action}']`
					case "use_mcp_tool":
						return `[${block.name} for '${block.params.server_name}']`
					case "access_mcp_resource":
						return `[${block.name} for '${block.params.server_name}']`
					case "ask_followup_question":
						return `[${block.name} for '${block.params.question}']`
					case "attempt_completion":
						return `[${block.name}]`
					case "switch_mode":
						return `[${block.name} to '${block.params.mode_slug}'${block.params.reason ? ` because: ${block.params.reason}` : ""}]`
					case "codebase_search": // Add case for the new tool
						return `[${block.name} for '${block.params.query}']`
					case "update_todo_list":
						return `[${block.name}]`
					case "new_task": {
						const mode = block.params.mode ?? defaultModeSlug
						const message = block.params.message ?? "(no message)"
						const modeName = getModeBySlug(mode, customModes)?.name ?? mode
						return `[${block.name} in ${modeName} mode: '${message}']`
					}
					case "run_slash_command":
						return `[${block.name} for '${block.params.command}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
					case "generate_image":
						return `[${block.name} for '${block.params.path}']`
				}
			}

			if (cline.didRejectTool) {
				// Ignore any tool content after user has rejected tool once.
				if (!block.partial) {
					cline.userMessageContent.push({
						type: "text",
						text: `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`,
					})
				} else {
					// Partial tool after user rejected a previous tool.
					cline.userMessageContent.push({
						type: "text",
						text: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`,
					})
				}

				break
			}

			if (cline.didAlreadyUseTool) {
				// Ignore any content after a tool has already been used.
				cline.userMessageContent.push({
					type: "text",
					text: `Tool [${block.name}] was not executed because a tool has already been used in this message. Only one tool may be used per message. You must assess the first tool's result before proceeding to use the next tool.`,
				})

				break
			}

			const pushToolResult = (content: ToolResponse) => {
				cline.userMessageContent.push({ type: "text", text: `${toolDescription()} Result:` })

				if (typeof content === "string") {
					cline.userMessageContent.push({ type: "text", text: content || "(tool did not return anything)" })
				} else {
					cline.userMessageContent.push(...content)
				}

				// Once a tool result has been collected, ignore all other tool
				// uses since we should only ever present one tool result per
				// message.
				cline.didAlreadyUseTool = true
			}

			const askApproval = async (
				type: ClineAsk,
				partialMessage?: string,
				progressStatus?: ToolProgressStatus,
				isProtected?: boolean,
			) => {
				let response: ClineAskResponse
				let text: string | undefined
				let images: string[] | undefined
				try {
					const askResult = await cline.ask(type, partialMessage, false, progressStatus, isProtected || false)
					response = askResult.response
					text = askResult.text
					images = askResult.images
				} catch (error) {
					// Fix #4: Catch "ask promise ignored" errors and log internally instead of leaking to LLM
					if (error instanceof Error && error.message.includes("Current ask promise was ignored")) {
						const provider = await cline.providerRef.deref()
						provider?.log(
							`[presentAssistantMessage] Ask promise was ignored (task ${cline.taskId}, ask type: ${type}) - this is an internal cancellation, not a user-visible error`,
						)
						// Return false to indicate approval was not granted (but don't add error to conversation)
						return false
					}
					// Re-throw other errors to be handled by outer catch
					throw error
				}

				if (response !== "yesButtonClicked") {
					// Handle both messageResponse and noButtonClicked with text.
					if (text) {
						await cline.say("user_feedback", text, images)
						pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
					} else {
						pushToolResult(formatResponse.toolDenied())
					}
					cline.didRejectTool = true
					return false
				}

				// Handle yesButtonClicked with text.
				if (text) {
					await cline.say("user_feedback", text, images)
					pushToolResult(formatResponse.toolResult(formatResponse.toolApprovedWithFeedback(text), images))
				}

				return true
			}

			const askFinishSubTaskApproval = async () => {
				// Ask the user to approve this task has completed, and he has
				// reviewed it, and we can declare task is finished and return
				// control to the parent task to continue running the rest of
				// the sub-tasks.
				const toolMessage = JSON.stringify({ tool: "finishTask" })
				return await askApproval("tool", toolMessage)
			}

			const handleError = async (action: string, error: Error) => {
				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`

				await cline.say(
					"error",
					`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`,
				)

				pushToolResult(formatResponse.toolError(errorString))
			}

			// If block is partial, remove partial closing tag so its not
			// presented to user.
			const removeClosingTag = (tag: ToolParamName, text?: string): string => {
				if (!block.partial) {
					return text || ""
				}

				if (!text) {
					return ""
				}

				// This regex dynamically constructs a pattern to match the
				// closing tag:
				// - Optionally matches whitespace before the tag.
				// - Matches '<' or '</' optionally followed by any subset of
				//   characters from the tag name.
				const tagRegex = new RegExp(
					`\\s?<\/?${tag
						.split("")
						.map((char) => `(?:${char})?`)
						.join("")}$`,
					"g",
				)

				return text.replace(tagRegex, "")
			}

			if (block.name !== "browser_action") {
				await cline.browserSession.closeBrowser()
			}

			// IMPORTANT:
			// We emit partial ToolUse blocks while streaming assistant output. Only a small subset of tools
			// support safe incremental (partial) execution (e.g. streaming large file writes).
			// Executing other tools while their XML args are still streaming can cause invalid tool calls like
			// read_file({}) to be executed, which can cascade into e2e-mode blocked asks and infinite retries.
			// Tools that are safe to run incrementally while their XML is still streaming.
			// read_file (and most discovery tools) are NOT safe and can trigger invalid calls like read_file({}).
			const vcrMode = (process.env.ROO_VCR_MODE || "off").toLowerCase()
			const isTortureVcr = process.env.TEST_TORTURE_REPO === "1" && (vcrMode === "record" || vcrMode === "replay")

			const hasRequiredParamsForPartialExecution = (name: ToolName, params: unknown): boolean => {
				const p = params as Record<string, unknown> | undefined
				if (!p) return false
				switch (name) {
					case "write_to_file":
						// Only execute partial writes once we have at least path + content.
						return typeof p.path === "string" && p.path.length > 0 && typeof p.content === "string"
					case "apply_diff":
						return (
							typeof p.path === "string" &&
							p.path.length > 0 &&
							typeof p.diff === "string" &&
							p.diff.length > 0
						)
					case "insert_content":
						return (
							typeof p.path === "string" &&
							p.path.length > 0 &&
							typeof p.content === "string" &&
							p.content.length > 0
						)
					default:
						return false
				}
			}

			// In torture VCR runs we want maximum determinism, but we also need to support streaming tool calls.
			// Allow partial execution ONLY for safe tools *and only once required params are present*.
			// In practice, partial execution of write_to_file can be extremely noisy and slow in e2e torture runs
			// (it may trigger hundreds of partial tool executions). Prefer waiting for the complete tool call.
			const partialExecutionAllowlist = isTortureVcr
				? new Set<ToolName>([])
				: new Set<ToolName>(["write_to_file", "apply_diff", "insert_content"])
			if (
				block.partial &&
				(!partialExecutionAllowlist.has(block.name as ToolName) ||
					!hasRequiredParamsForPartialExecution(block.name as ToolName, block.params as unknown))
			) {
				// Avoid logging every partial skip in torture VCR runs (very noisy).
				if (provider && process.env.ROO_DEBUG_TOOL_EXECUTION && !isTortureVcr) {
					provider.log(`[presentAssistantMessage] Skipping partial execution for tool: ${block.name}`)
				}
				break
			}

			if (!block.partial) {
				cline.recordToolUsage(block.name)
				TelemetryService.instance.captureToolUsage(cline.taskId, block.name)
				cline.taskLogger?.logToolCall(block.name, true, block.params as Record<string, unknown>)

				// P3 Replay: Log full tool call with input for reproducibility
				cline.logToolCall(block.name, block.params as Record<string, unknown>)

				// Fix #4: Audit logging - Executed tool calls
				const provider = cline.providerRef.deref()
				if (provider && process.env.ROO_DEBUG_TOOL_EXECUTION) {
					provider.log(
						`[Task#${cline.taskId}] [AUDIT:EXECUTED] Executing tool: ${block.name} with params: ${JSON.stringify(block.params)}`,
					)
				}
			}

			// Validate tool use before execution.
			// Use the task's own mode (set per-task for planner children) rather than
			// the global provider mode.  The global mode may be "orchestrator" (no tools)
			// while the child task was explicitly assigned "code" mode by the planner.
			const { customModes } = (await cline.providerRef.deref()?.getState()) ?? {}
			const mode = await cline.getTaskMode()

			try {
				// Block delegation tools for child tasks (they are leaf workers)
				if (cline.parentTask && (block.name === "new_task" || block.name === "switch_mode")) {
					throw new Error(`Tool "${block.name}" is not available for subtasks. Complete the work directly.`)
				}
				validateToolUse(
					block.name as ToolName,
					mode ?? defaultModeSlug,
					customModes ?? [],
					{ apply_diff: cline.diffEnabled },
					block.params,
				)
			} catch (error) {
				cline.consecutiveMistakeCount++
				pushToolResult(formatResponse.toolError(error.message))
				break
			}

			// Check for identical consecutive tool calls.
			if (!block.partial) {
				// Use the detector to check for repetition, passing the ToolUse
				// block directly.
				const repetitionCheck = cline.toolRepetitionDetector.check(block)

				// If execution is not allowed, notify user and break.
				if (!repetitionCheck.allowExecution && repetitionCheck.askUser) {
					// Handle repetition similar to mistake_limit_reached pattern.
					let response: ClineAskResponse
					let text: string | undefined
					let images: string[] | undefined
					try {
						const askResult = await cline.ask(
							repetitionCheck.askUser.messageKey as ClineAsk,
							repetitionCheck.askUser.messageDetail.replace("{toolName}", block.name),
						)
						response = askResult.response
						text = askResult.text
						images = askResult.images
					} catch (error) {
						// Fix #4: Catch "ask promise ignored" errors and log internally instead of leaking to LLM
						if (error instanceof Error && error.message.includes("Current ask promise was ignored")) {
							const provider = await cline.providerRef.deref()
							provider?.log(
								`[presentAssistantMessage] Ask promise was ignored during repetition check (task ${cline.taskId}) - this is an internal cancellation, not a user-visible error`,
							)
							// Return tool result about repetition without adding error to conversation
							pushToolResult(
								formatResponse.toolError(
									`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
								),
							)
							break
						}
						// Re-throw other errors to be handled by outer catch
						throw error
					}

					if (response === "messageResponse") {
						// Add user feedback to userContent.
						cline.userMessageContent.push(
							{
								type: "text" as const,
								text: `Tool repetition limit reached. User feedback: ${text}`,
							},
							...formatResponse.imageBlocks(images),
						)

						// Add user feedback to chat.
						await cline.say("user_feedback", text, images)

						// Track tool repetition in telemetry.
						TelemetryService.instance.captureConsecutiveMistakeError(cline.taskId)
					}

					// Return tool result message about the repetition
					pushToolResult(
						formatResponse.toolError(
							`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
						),
					)
					break
				}
			}

			// Logging: Track tool execution
			if (provider && process.env.ROO_DEBUG_TOOL_EXECUTION) {
				provider.log(`[presentAssistantMessage] Executing tool: ${block.name}, Partial: ${block.partial}`)
			}

			switch (block.name) {
				case "write_to_file":
					await checkpointSaveAndMark(cline)
					await writeToFileTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					if (!block.partial) await runPostEditQualityGate(cline)
					break
				case "update_todo_list":
					await updateTodoListTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "apply_diff": {
					// Get the provider and state to check experiment settings
					const provider = cline.providerRef.deref()
					let isMultiFileApplyDiffEnabled = false

					if (provider) {
						const state = await provider.getState()
						isMultiFileApplyDiffEnabled = experiments.isEnabled(
							state.experiments ?? {},
							EXPERIMENT_IDS.MULTI_FILE_APPLY_DIFF,
						)
					}

					if (isMultiFileApplyDiffEnabled) {
						await checkpointSaveAndMark(cline)
						await applyDiffTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						if (!block.partial) await runPostEditQualityGate(cline)
					} else {
						await checkpointSaveAndMark(cline)
						await applyDiffToolLegacy(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						if (!block.partial) await runPostEditQualityGate(cline)
					}
					break
				}
				case "insert_content":
					await checkpointSaveAndMark(cline)
					await insertContentTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					if (!block.partial) await runPostEditQualityGate(cline)
					break
				case "search_and_replace":
					await checkpointSaveAndMark(cline)
					await searchAndReplaceTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					if (!block.partial) await runPostEditQualityGate(cline)
					break
				case "read_file":
					// Check if this model should use the simplified single-file read tool
					const modelId = cline.api.getModel().id
					if (shouldUseSingleFileRead(modelId)) {
						await simpleReadFileTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
					} else {
						await readFileTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					}
					break
				case "fetch_instructions":
					await fetchInstructionsTool(cline, block, askApproval, handleError, pushToolResult)
					break
				case "list_files":
					await listFilesTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "codebase_search":
					await codebaseSearchTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "list_code_definition_names":
					await listCodeDefinitionNamesTool(
						cline,
						block,
						askApproval,
						handleError,
						pushToolResult,
						removeClosingTag,
					)
					break
				case "search_files":
					await searchFilesTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "browser_action":
					await browserActionTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "execute_command":
					await executeCommandTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "use_mcp_tool":
					await useMcpToolTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "access_mcp_resource":
					await accessMcpResourceTool(
						cline,
						block,
						askApproval,
						handleError,
						pushToolResult,
						removeClosingTag,
					)
					break
				case "ask_followup_question":
					await askFollowupQuestionTool(
						cline,
						block,
						askApproval,
						handleError,
						pushToolResult,
						removeClosingTag,
					)
					break
				case "switch_mode":
					await switchModeTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "new_task":
					await newTaskTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "attempt_completion":
					await attemptCompletionTool(
						cline,
						block,
						askApproval,
						handleError,
						pushToolResult,
						removeClosingTag,
						toolDescription,
						askFinishSubTaskApproval,
					)
					break
				case "run_slash_command":
					await runSlashCommandTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "generate_image":
					await generateImageTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "save_checkpoint":
					await saveCheckpointTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
					break
				case "rollback_to_checkpoint":
					await rollbackToCheckpointTool(
						cline,
						block,
						askApproval,
						handleError,
						pushToolResult,
						removeClosingTag,
					)
					break
				default:
					// Unhandled tool - fail loudly instead of silently ignoring
					pushToolResult(
						formatResponse.toolError(
							`Tool '${block.name}' is not implemented or not available in this context. ` +
								`Available tools are defined in the system prompt. If you believe this tool should exist, ` +
								`there may be a wiring issue in the tool execution handler.`,
						),
					)
					cline.consecutiveMistakeCount++
					break
			}

			break
		}
	}

	// Seeing out of bounds is fine, it means that the next too call is being
	// built up and ready to add to assistantMessageContent to present.
	// When you see the UI inactive during this, it means that a tool is
	// breaking without presenting any UI. For example the write_to_file tool
	// was breaking when relpath was undefined, and for invalid relpath it never
	// presented UI.
	// This needs to be placed here, if not then calling
	// cline.presentAssistantMessage below would fail (sometimes) since it's
	// locked.
	cline.presentAssistantMessageLocked = false

	// NOTE: When tool is rejected, iterator stream is interrupted and it waits
	// for `userMessageContentReady` to be true. Future calls to present will
	// skip execution since `didRejectTool` and iterate until `contentIndex` is
	// set to message length and it sets userMessageContentReady to true itself
	// (instead of preemptively doing it in iterator).
	if (!block.partial || cline.didRejectTool || cline.didAlreadyUseTool) {
		// Block is finished streaming and executing.
		if (cline.currentStreamingContentIndex === cline.assistantMessageContent.length - 1) {
			// It's okay that we increment if !didCompleteReadingStream, it'll
			// just return because out of bounds and as streaming continues it
			// will call `presentAssitantMessage` if a new block is ready. If
			// streaming is finished then we set `userMessageContentReady` to
			// true when out of bounds. This gracefully allows the stream to
			// continue on and all potential content blocks be presented.
			// Last block is complete and it is finished executing
			cline.userMessageContentReady = true // Will allow `pWaitFor` to continue.
		}

		// Call next block if it exists (if not then read stream will call it
		// when it's ready).
		// Need to increment regardless, so when read stream calls this function
		// again it will be streaming the next block.
		cline.currentStreamingContentIndex++

		if (cline.currentStreamingContentIndex < cline.assistantMessageContent.length) {
			// There are already more content blocks to stream, so we'll call
			// this function ourselves.
			presentAssistantMessage(cline)
			return
		}
	}

	// Block is partial, but the read stream may have finished.
	if (cline.presentAssistantMessageHasPendingUpdates) {
		presentAssistantMessage(cline)
	}
}

/**
 * save checkpoint and mark done in the current streaming task.
 * @param task The Task instance to checkpoint save and mark.
 * @returns
 */
async function checkpointSaveAndMark(task: Task) {
	if (task.currentStreamingDidCheckpoint) {
		return
	}
	try {
		await task.checkpointSave(true)
		task.currentStreamingDidCheckpoint = true
	} catch (error) {
		console.error(`[Task#presentAssistantMessage] Error saving checkpoint: ${error.message}`, error)
	}
}

/**
 * After a file-mutating tool completes, run quality gate.
 * If tests pass: record as verified safe checkpoint.
 * If tests regress: rollback to last safe checkpoint and inform LLM.
 */
async function runPostEditQualityGate(task: Task): Promise<void> {
	if (!task.enableCheckpoints) return

	try {
		const verdict = await evaluateQualityGate(task, "auto")

		if (verdict.action === "rollback") {
			task.taskLogger?.logQualityGate(
				"rollback",
				verdict.score.testsPassing,
				verdict.score.testsTotal,
				verdict.score.compileClean,
				verdict.reason,
			)
			const message = await executeQualityGateRollback(task, verdict)
			// Reset checkpoint flag — state was rolled back, next edit needs a fresh snapshot
			task.currentStreamingDidCheckpoint = false
			// Append rollback notice to user message so LLM sees it
			task.userMessageContent.push({
				type: "text",
				text: `\n\n⚠️ POST-EDIT QUALITY GATE FAILED — AUTOMATIC ROLLBACK\n${message}`,
			})
		} else if (verdict.action === "save") {
			task.taskLogger?.logQualityGate(
				"save",
				verdict.score.testsPassing,
				verdict.score.testsTotal,
				verdict.score.compileClean,
			)
			// Get the shadow checkpoint hash from the last checkpoint_saved message.
			// ShadowCheckpointService.saveCheckpoint emits the "checkpoint" event synchronously
			// before the saveCheckpoint promise resolves, and the event handler pushes to
			// task.clineMessages synchronously (before its first await in addToClineMessages).
			// So by the time checkpointSaveAndMark returns, the shadow hash is already in
			// clineMessages — no race condition.
			const shadowHashMsg = task.clineMessages.filter((m) => m.say === "checkpoint_saved").at(-1)
			if (shadowHashMsg?.text) {
				recordCheckpointSaved(task, `auto-${Date.now()}`, shadowHashMsg.text, verdict.score)
			}
		} else {
			// "skip": no test framework detectable — cannot validate, do nothing
			task.taskLogger?.logQualityGate("skip", 0, 0, true, verdict.reason)
		}
	} catch (error: unknown) {
		// Non-fatal: quality gate errors must never break tool execution
		console.error("[PostEditQualityGate] Error (non-fatal):", error)
	}
}
