import path from "path"
import delay from "delay"
import * as vscode from "vscode"
import fs from "fs/promises"

import { Task } from "../task/Task"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { formatResponse } from "../prompts/responses"
import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { stripLineNumbers, everyLineHasLineNumbers } from "../../integrations/misc/extract-text"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { detectCodeOmission } from "../../integrations/editor/detect-omission"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"

function stripNoopTriggerLines(content: string): string {
	return content
		.split(/\r?\n/)
		.filter((line) => !/no-op to trigger file write/i.test(line))
		.join("\n")
		.trimEnd()
}

function isNoopTriggerOnlyChange(before: string, after: string): boolean {
	// Explicitly disallow the common "cheat" where a subtask adds a no-op marker comment just
	// to satisfy the "must edit a file" requirement without making real progress.
	if (!/no-op to trigger file write/i.test(after)) return false
	return stripNoopTriggerLines(before) === stripNoopTriggerLines(after)
}

export async function writeToFileTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const relPath: string | undefined = block.params.path
	let newContent: string | undefined = block.params.content
	const rawLineCount = (block.params as Record<string, unknown>)?.line_count
	let predictedLineCount: number | undefined =
		typeof rawLineCount === "number"
			? rawLineCount
			: typeof rawLineCount === "string"
				? Number.parseInt(rawLineCount, 10)
				: undefined
	if (predictedLineCount !== undefined && Number.isNaN(predictedLineCount)) {
		predictedLineCount = undefined
	}

	if (block.partial && (!relPath || newContent === undefined)) {
		// checking for newContent ensure relPath is complete
		// wait so we can determine if it's a new file or editing an existing file
		return
	}

	if (!relPath) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("write_to_file")
		pushToolResult(await cline.sayAndCreateMissingParamError("write_to_file", "path"))
		await cline.diffViewProvider.reset()
		return
	}

	if (newContent === undefined) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("write_to_file")
		pushToolResult(await cline.sayAndCreateMissingParamError("write_to_file", "content"))
		await cline.diffViewProvider.reset()
		return
	}

	const accessAllowed = cline.rooIgnoreController?.validateAccess(relPath)

	if (!accessAllowed) {
		await cline.say("rooignore_error", relPath)
		pushToolResult(formatResponse.toolError(formatResponse.rooIgnoreError(relPath)))
		return
	}

	// Check if file is write-protected
	const isWriteProtected = cline.rooProtectedController?.isWriteProtected(relPath) || false

	// Check if file exists using cached map or fs.access
	let fileExists: boolean

	if (cline.diffViewProvider.editType !== undefined) {
		fileExists = cline.diffViewProvider.editType === "modify"
	} else {
		const absolutePath = path.resolve(cline.cwd, relPath)
		fileExists = await fileExistsAtPath(absolutePath)
		cline.diffViewProvider.editType = fileExists ? "modify" : "create"
	}

	// pre-processing newContent for cases where weaker models might add artifacts like markdown codeblock markers (deepseek/llama) or extra escape characters (gemini)
	if (newContent.startsWith("```")) {
		// cline handles cases where it includes language specifiers like ```python ```js
		newContent = newContent.split("\n").slice(1).join("\n")
	}

	if (newContent.endsWith("```")) {
		newContent = newContent.split("\n").slice(0, -1).join("\n")
	}

	if (!cline.api.getModel().id.includes("claude")) {
		newContent = unescapeHtmlEntities(newContent)
	}

	// Some providers/models occasionally wrap code in CDATA markers. If we literally write these into source files
	// it will break syntax (e.g. Python `SyntaxError` at `<![CDATA[`).
	newContent = newContent.replace(/^\s*<!\[CDATA\[\s*\r?\n?/, "")
	newContent = newContent.replace(/\r?\n?\s*\]\]>\s*$/, "")

	// In subtasks, prevent "no-op" edits that only add a marker comment to satisfy the write requirement.
	// This avoids infinite loops where the model claims it can't patch, adds a no-op comment, and retries.
	if (!block.partial && cline.parentTask) {
		try {
			const absolutePath = path.resolve(cline.cwd, relPath)
			const before = fileExists ? await fs.readFile(absolutePath, "utf-8") : ""
			if (fileExists && isNoopTriggerOnlyChange(before, newContent)) {
				cline.consecutiveMistakeCount++
				cline.recordToolError(
					"write_to_file",
					"Subtask attempted no-op marker edit to satisfy write requirement",
				)
				pushToolResult(
					formatResponse.toolError(
						"Subtasks may not add no-op marker edits (e.g. 'no-op to trigger file write') just to satisfy the write requirement. " +
							"Either make the actual required code changes or do not write.",
					),
				)
				await cline.diffViewProvider.revertChanges().catch(() => {})
				await cline.diffViewProvider.reset()
				return
			}
		} catch {
			// If we can't read the file, don't block the write on this heuristic.
		}
	}

	// Determine if the path is outside the workspace
	const fullPath = relPath ? path.resolve(cline.cwd, removeClosingTag("path", relPath)) : ""
	const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

	const sharedMessageProps: ClineSayTool = {
		tool: fileExists ? "editedExistingFile" : "newFileCreated",
		path: getReadablePath(cline.cwd, removeClosingTag("path", relPath)),
		content: newContent,
		isOutsideWorkspace,
		isProtected: isWriteProtected,
	}

	try {
		if (block.partial) {
			// Check if preventFocusDisruption experiment is enabled
			const provider = cline.providerRef.deref()
			const state = await provider?.getState()
			const isPreventFocusDisruptionEnabled =
				process.env.TEST_TORTURE_REPO === "1" ||
				experiments.isEnabled(state?.experiments ?? {}, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)

			if (!isPreventFocusDisruptionEnabled) {
				// update gui message
				const partialMessage = JSON.stringify(sharedMessageProps)
				await cline.ask("tool", partialMessage, block.partial).catch(() => {})

				// update editor
				if (!cline.diffViewProvider.isEditing) {
					// open the editor and prepare to stream content in
					await cline.diffViewProvider.open(relPath)
				}

				// editor is open, stream content in
				await cline.diffViewProvider.update(
					everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
					false,
				)
			}

			return
		} else {
			// Torture/e2e resilience: some models omit line_count entirely. In TEST_TORTURE_REPO,
			// prefer completing the write (and letting downstream gates/tests catch issues)
			// rather than getting stuck in an endless "missing line_count" retry loop.
			if (predictedLineCount === undefined && process.env.TEST_TORTURE_REPO === "1") {
				predictedLineCount = newContent.split("\n").length
			}

			if (predictedLineCount === undefined) {
				cline.consecutiveMistakeCount++
				cline.recordToolError("write_to_file")

				// Calculate the actual number of lines in the content
				const actualLineCount = newContent.split("\n").length

				// Check if this is a new file or existing file
				const isNewFile = !fileExists

				// Check if diffStrategy is enabled
				const diffStrategyEnabled = !!cline.diffStrategy

				// Use more specific error message for line_count that provides guidance based on the situation
				await cline.say(
					"error",
					`Roo tried to use write_to_file${
						relPath ? ` for '${relPath.toPosix()}'` : ""
					} but the required parameter 'line_count' was missing or truncated after ${actualLineCount} lines of content were written. Retrying...`,
				)

				pushToolResult(
					formatResponse.toolError(
						formatResponse.lineCountTruncationError(actualLineCount, isNewFile, diffStrategyEnabled),
					),
				)
				await cline.diffViewProvider.revertChanges()
				return
			}

			cline.consecutiveMistakeCount = 0

			// Check if preventFocusDisruption experiment is enabled
			const provider = cline.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled =
				process.env.TEST_TORTURE_REPO === "1" ||
				experiments.isEnabled(state?.experiments ?? {}, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)

			if (isPreventFocusDisruptionEnabled) {
				// Direct file write without diff view
				// Check for code omissions before proceeding
				if (detectCodeOmission(cline.diffViewProvider.originalContent || "", newContent, predictedLineCount)) {
					if (cline.diffStrategy) {
						pushToolResult(
							formatResponse.toolError(
								`Content appears to be truncated (file has ${
									newContent.split("\n").length
								} lines but was predicted to have ${predictedLineCount} lines), and found comments indicating omitted code (e.g., '// rest of code unchanged', '/* previous code */'). Please provide the complete file content without any omissions if possible, or otherwise use the 'apply_diff' tool to apply the diff to the original file.`,
							),
						)
						return
					} else {
						vscode.window
							.showWarningMessage(
								"Potential code truncation detected. cline happens when the AI reaches its max output limit.",
								"Follow cline guide to fix the issue",
							)
							.then((selection) => {
								if (selection === "Follow cline guide to fix the issue") {
									vscode.env.openExternal(
										vscode.Uri.parse(
											"https://github.com/cline/cline/wiki/Troubleshooting-%E2%80%90-Cline-Deleting-Code-with-%22Rest-of-Code-Here%22-Comments",
										),
									)
								}
							})
					}
				}

				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: newContent,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					return
				}

				// Set up diffViewProvider properties needed for saveDirectly
				cline.diffViewProvider.editType = fileExists ? "modify" : "create"
				if (fileExists) {
					const absolutePath = path.resolve(cline.cwd, relPath)
					cline.diffViewProvider.originalContent = await fs.readFile(absolutePath, "utf-8")
				} else {
					cline.diffViewProvider.originalContent = ""
				}

				// Save directly without showing diff view or opening the file
				await cline.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				// Original behavior with diff view
				// if isEditingFile false, that means we have the full contents of the file already.
				// it's important to note how cline function works, you can't make the assumption that the block.partial conditional will always be called since it may immediately get complete, non-partial data. So cline part of the logic will always be called.
				// in other words, you must always repeat the block.partial logic here
				if (!cline.diffViewProvider.isEditing) {
					// show gui message before showing edit animation
					const partialMessage = JSON.stringify(sharedMessageProps)
					await cline.ask("tool", partialMessage, true).catch(() => {}) // sending true for partial even though it's not a partial, cline shows the edit row before the content is streamed into the editor
					await cline.diffViewProvider.open(relPath)
				}

				await cline.diffViewProvider.update(
					everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
					true,
				)

				await delay(300) // wait for diff view to update
				cline.diffViewProvider.scrollToFirstDiff()

				// Check for code omissions before proceeding
				if (detectCodeOmission(cline.diffViewProvider.originalContent || "", newContent, predictedLineCount)) {
					if (cline.diffStrategy) {
						await cline.diffViewProvider.revertChanges()

						pushToolResult(
							formatResponse.toolError(
								`Content appears to be truncated (file has ${
									newContent.split("\n").length
								} lines but was predicted to have ${predictedLineCount} lines), and found comments indicating omitted code (e.g., '// rest of code unchanged', '/* previous code */'). Please provide the complete file content without any omissions if possible, or otherwise use the 'apply_diff' tool to apply the diff to the original file.`,
							),
						)
						return
					} else {
						vscode.window
							.showWarningMessage(
								"Potential code truncation detected. cline happens when the AI reaches its max output limit.",
								"Follow cline guide to fix the issue",
							)
							.then((selection) => {
								if (selection === "Follow cline guide to fix the issue") {
									vscode.env.openExternal(
										vscode.Uri.parse(
											"https://github.com/cline/cline/wiki/Troubleshooting-%E2%80%90-Cline-Deleting-Code-with-%22Rest-of-Code-Here%22-Comments",
										),
									)
								}
							})
					}
				}

				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: fileExists ? undefined : newContent,
					diff: fileExists
						? formatResponse.createPrettyPatch(relPath, cline.diffViewProvider.originalContent, newContent)
						: undefined,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					await cline.diffViewProvider.revertChanges()
					return
				}

				// Call saveChanges to update the DiffViewProvider properties
				await cline.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			// Track file edit operation
			if (relPath) {
				await cline.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			cline.didEditFile = true // used to determine if we should wait for busy terminal to update before sending api request
			cline.fileMutationOccurred = true // Track that this task modified a file (for subtask completion validation)

			// Get the formatted response message
			const message = await cline.diffViewProvider.pushToolWriteResult(cline, cline.cwd, !fileExists)

			pushToolResult(message)

			await cline.diffViewProvider.reset()

			// Process any queued messages after file edit completes
			cline.processQueuedMessages()

			return
		}
	} catch (error) {
		await handleError("writing file", error)
		await cline.diffViewProvider.reset()
		return
	}
}
