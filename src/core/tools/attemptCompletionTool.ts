import Anthropic from "@anthropic-ai/sdk"
import * as vscode from "vscode"

import { RooCodeEventName } from "@roo-code/types"
import type { ClineAskResponse } from "../../shared/WebviewMessage"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"
import {
	ToolResponse,
	ToolUse,
	AskApproval,
	HandleError,
	PushToolResult,
	RemoveClosingTag,
	ToolDescription,
	AskFinishSubTaskApproval,
} from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"

export async function attemptCompletionTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
	toolDescription: ToolDescription,
	askFinishSubTaskApproval: AskFinishSubTaskApproval,
) {
	const result: string | undefined = block.params.result
	const command: string | undefined = block.params.command

	// Get the setting for preventing completion with open todos from VSCode configuration
	const preventCompletionWithOpenTodos = vscode.workspace
		.getConfiguration(Package.name)
		.get<boolean>("preventCompletionWithOpenTodos", false)

	// Check if there are incomplete todos (only if the setting is enabled)
	const hasIncompleteTodos = cline.todoList && cline.todoList.some((todo) => todo.status !== "completed")

	if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("attempt_completion")

		pushToolResult(
			formatResponse.toolError(
				"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
			),
		)

		return
	}

	const isTortureStage1 = process.env.TEST_TORTURE_REPO === "1" && process.env.TEST_TORTURE_STAGE === "1"

	// SUBTASK FILE MUTATION ENFORCEMENT
	// Subtasks must modify at least one file before completing.
	// Returning code in the result text is NOT sufficient - the code must be written to disk.
	// This prevents subtasks from "succeeding" by just generating code without actually modifying the repo.
	//
	// Torture Stage 1 is explicitly a code-writing exercise; enforce the same rule at the top-level task
	// to prevent a "text-only completion" that then fails hard gates and wastes the full timeout.
	if ((cline.parentTask || isTortureStage1) && !cline.fileMutationOccurred) {
		cline.consecutiveMistakeCount++
		// IMPORTANT: This is an enforcement block, not an infrastructure/tool failure.
		// Do NOT emit a TaskToolFailed event here (it triggers fast-fail in e2e and can abort
		// otherwise-correct runs where the model tries to complete early once or twice).
		cline.recordToolError("attempt_completion")

		const provider = cline.providerRef.deref()
		const scopeLabel = cline.parentTask ? "Subtask" : "Task"
		provider?.log(
			`[attemptCompletionTool] BLOCKED: ${scopeLabel} ${cline.taskId} attempted to complete without modifying any files. ` +
				`File-mutating tools (write_to_file, apply_diff, insert_content) must be used before completion.`,
		)

		// Inject a hard constraint on the NEXT turn to prevent the model from repeatedly
		// attempting text-only completion. This reuses the existing "tool validation" constraint
		// injection mechanism to keep the behavior deterministic in e2e torture runs.
		cline.pendingValidationError = {
			tool: "attempt_completion",
			code: cline.parentTask ? "SUBTASK_NO_FILE_MUTATION" : "TASK_NO_FILE_MUTATION",
			message:
				`You attempted to complete a ${cline.parentTask ? "subtask" : "task"} without modifying any files. REQUIRED NEXT STEP: ` +
				"Use a file-mutating tool (write_to_file or insert_content) to write the implementation/tests to disk. " +
				`Do NOT call <attempt_completion> again until you have successfully modified at least one file in this ${cline.parentTask ? "subtask" : "task"}.`,
		}
		cline.forceConstraintNextTurn = true

		pushToolResult(
			formatResponse.toolError(
				`Cannot complete ${cline.parentTask ? "subtask" : "task"} without modifying any files. You must use file-editing tools ` +
					"(write_to_file, apply_diff, insert_content) to actually write the code to disk before completing. " +
					"Returning code in the completion result is not sufficient - the changes must be saved to the repository.",
			),
		)

		return
	}

	try {
		const lastMessage = cline.clineMessages.at(-1)

		if (block.partial) {
			if (command) {
				// the attempt_completion text is done, now we're getting command
				// remove the previous partial attempt_completion ask, replace with say, post state to webview, then stream command

				// const secondLastMessage = cline.clineMessages.at(-2)
				if (lastMessage && lastMessage.ask === "command") {
					// update command
					await cline.ask("command", removeClosingTag("command", command), block.partial).catch(() => {})
				} else {
					// last message is completion_result
					// we have command string, which means we have the result as well, so finish it (doesnt have to exist yet)
					await cline.say("completion_result", removeClosingTag("result", result), undefined, false)

					TelemetryService.instance.captureTaskCompleted(cline.taskId)
					const tokenUsageCmpl0 = cline.getTokenUsage()
					cline.taskLogger?.logTaskEnd("success", tokenUsageCmpl0 as any, cline.toolUsage as any)
					cline.taskLogger?.close()
					cline.emit(RooCodeEventName.TaskCompleted, cline.taskId, tokenUsageCmpl0, cline.toolUsage)

					await cline.ask("command", removeClosingTag("command", command), block.partial).catch(() => {})
				}
			} else {
				// No command, still outputting partial result
				await cline.say("completion_result", removeClosingTag("result", result), undefined, block.partial)
			}
			return
		} else {
			if (!result) {
				cline.consecutiveMistakeCount++
				cline.recordToolError("attempt_completion")
				pushToolResult(await cline.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			cline.consecutiveMistakeCount = 0

			// Command execution is permanently disabled in attempt_completion
			// Users must use execute_command tool separately before attempt_completion
			await cline.say("completion_result", result, undefined, false)
			TelemetryService.instance.captureTaskCompleted(cline.taskId)
			const tokenUsageCmpl1 = cline.getTokenUsage()
			cline.taskLogger?.logTaskEnd("success", tokenUsageCmpl1 as any, cline.toolUsage as any)
			cline.taskLogger?.close()
			cline.emit(RooCodeEventName.TaskCompleted, cline.taskId, tokenUsageCmpl1, cline.toolUsage)

			if (cline.parentTask) {
				const didApprove = await askFinishSubTaskApproval()

				if (!didApprove) {
					return
				}

				// tell the provider to remove the current subtask and resume the previous task in the stack
				await cline.providerRef.deref()?.finishSubTask(result)
				return
			}

			// We already sent completion_result says, an
			// empty string asks relinquishes control over
			// button and field.
			let response: ClineAskResponse
			let text: string | undefined
			let images: string[] | undefined
			try {
				const askResult = await cline.ask("completion_result", "", false)
				response = askResult.response
				text = askResult.text
				images = askResult.images
			} catch (error) {
				// Fix #4: Catch "ask promise ignored" errors and log internally instead of leaking to LLM
				if (error instanceof Error && error.message.includes("Current ask promise was ignored")) {
					const provider = await cline.providerRef.deref()
					provider?.log(
						`[attemptCompletionTool] Ask promise was ignored (task ${cline.taskId}) - this is an internal cancellation, not a user-visible error`,
					)
					// Return early without adding error to conversation
					return
				}
				// Re-throw other errors to be handled by outer catch
				throw error
			}

			// When the user (or e2e auto-approve) clicks "yes" on completion,
			// do NOT push a tool result. Leaving userMessageContent empty
			// signals the recursive loop to exit cleanly.
			// In the normal UI, clicking "yes" triggers a new task anyway.
			// In e2e mode, pushToolResult("") was producing a confusing
			// "(tool did not return anything)" message that caused the model
			// to loop indefinitely (re-running tests, re-reading files, etc.).
			if (response === "yesButtonClicked") {
				cline.finishedSuccessfully = true
				return
			}

			await cline.say("user_feedback", text ?? "", images)
			const toolResults: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []

			toolResults.push({
				type: "text",
				text: `The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.\n<feedback>\n${text}\n</feedback>`,
			})

			toolResults.push(...formatResponse.imageBlocks(images))
			cline.userMessageContent.push({ type: "text", text: `${toolDescription()} Result:` })
			cline.userMessageContent.push(...toolResults)

			return
		}
	} catch (error) {
		await handleError("inspecting site", error)
		return
	}
}
