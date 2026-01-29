import path from "path"
import { isBinaryFile } from "isbinaryfile"

import { Task } from "../task/Task"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { getReadablePath, resolveFilePathWithFallback } from "../../utils/path"
import { countFileLines } from "../../integrations/misc/line-counter"
import { readLines } from "../../integrations/misc/read-lines"
import { extractTextFromFile, addLineNumbers, getSupportedBinaryFormats } from "../../integrations/misc/extract-text"
import { parseSourceCodeDefinitionsForFile } from "../../services/tree-sitter"
import { parseXml } from "../../utils/xml"
import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
	ImageMemoryTracker,
} from "./helpers/imageHelpers"

export function getReadFileToolDescription(blockName: string, blockParams: any): string {
	// Handle both single path and multiple files via args
	if (blockParams.args) {
		try {
			const parsed = parseXml(blockParams.args) as any
			const files = Array.isArray(parsed.file) ? parsed.file : [parsed.file].filter(Boolean)
			const paths = files.map((f: any) => f?.path).filter(Boolean) as string[]

			if (paths.length === 0) {
				return `[${blockName} with no valid paths]`
			} else if (paths.length === 1) {
				// Modified part for single file
				return `[${blockName} for '${paths[0]}'. Reading multiple files at once is more efficient for the LLM. If other files are relevant to your current task, please read them simultaneously.]`
			} else if (paths.length <= 3) {
				const pathList = paths.map((p) => `'${p}'`).join(", ")
				return `[${blockName} for ${pathList}]`
			} else {
				return `[${blockName} for ${paths.length} files]`
			}
		} catch (error) {
			console.error("Failed to parse read_file args XML for description:", error)
			return `[${blockName} with unparsable args]`
		}
	} else if (blockParams.path) {
		// Fallback for legacy single-path usage
		// Modified part for single file (legacy)
		return `[${blockName} for '${blockParams.path}'. Reading multiple files at once is more efficient for the LLM. If other files are relevant to your current task, please read them simultaneously.]`
	} else {
		return `[${blockName} with missing path/args]`
	}
}
// Types
interface LineRange {
	start: number
	end: number
}

interface FileEntry {
	path?: string
	lineRanges?: LineRange[]
}

// New interface to track file processing state
interface FileResult {
	path: string
	status: "approved" | "denied" | "blocked" | "error" | "pending"
	content?: string
	error?: string
	notice?: string
	lineRanges?: LineRange[]
	xmlContent?: string // Final XML content for this file
	imageDataUrl?: string // Image data URL for image files
	feedbackText?: string // User feedback text from approval/denial
	feedbackImages?: any[] // User feedback images from approval/denial
}

export async function readFileTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	_removeClosingTag: RemoveClosingTag,
) {
	const argsXmlTag: string | undefined = block.params.args
	const legacyPath: string | undefined = block.params.path
	const legacyStartLineStr: string | undefined = block.params.start_line
	const legacyEndLineStr: string | undefined = block.params.end_line

	// Check if the current model supports images at the beginning
	const modelInfo = cline.api.getModel().info
	const supportsImages = modelInfo.supportsImages ?? false

	// Handle partial message first
	if (block.partial) {
		let filePath = ""
		// Prioritize args for partial, then legacy path
		if (argsXmlTag) {
			const match = argsXmlTag.match(/<file>.*?<path>([^<]+)<\/path>/s)
			if (match) filePath = match[1]
		}
		if (!filePath && legacyPath) {
			// If args didn't yield a path, try legacy
			filePath = legacyPath
		}

		const fullPath = filePath ? path.resolve(cline.cwd, filePath) : ""
		const sharedMessageProps: ClineSayTool = {
			tool: "readFile",
			path: getReadablePath(cline.cwd, filePath),
			isOutsideWorkspace: filePath ? isPathOutsideWorkspace(fullPath) : false,
		}
		const partialMessage = JSON.stringify({
			...sharedMessageProps,
			content: undefined,
		} satisfies ClineSayTool)
		// In E2E mode, skip partial asks to avoid race conditions with full tool calls
		const isE2EMode = !!(process.env.TEST_TORTURE_REPO || process.env.TEST_TORTURE_REPO_WORKSPACE)
		if (!isE2EMode) {
			await cline.ask("tool", partialMessage, block.partial).catch(() => {})
		}
		return
	}

	const fileEntries: FileEntry[] = []

	if (argsXmlTag) {
		// Parse file entries from XML (new multi-file format)
		try {
			const parsed = parseXml(argsXmlTag) as any
			const files = Array.isArray(parsed.file) ? parsed.file : [parsed.file].filter(Boolean)

			for (const file of files) {
				if (!file.path) continue // Skip if no path in a file entry

				const fileEntry: FileEntry = {
					path: file.path,
					lineRanges: [],
				}

				if (file.line_range) {
					const ranges = Array.isArray(file.line_range) ? file.line_range : [file.line_range]
					for (const range of ranges) {
						const match = String(range).match(/(\d+)-(\d+)/) // Ensure range is treated as string
						if (match) {
							const [, start, end] = match.map(Number)
							if (!isNaN(start) && !isNaN(end)) {
								fileEntry.lineRanges?.push({ start, end })
							}
						}
					}
				}
				fileEntries.push(fileEntry)
			}
		} catch (error) {
			const errorMessage = `Failed to parse read_file XML args: ${error instanceof Error ? error.message : String(error)}`
			await handleError("parsing read_file args", new Error(errorMessage))
			// Provide specific fix guidance when XML parsing fails
			const fixGuidance = `\n\n⚠️ XML PARSING FAILED - FIX YOUR FORMAT:\n\n✅ CORRECT FORMAT:\n<read_file>\n<args>\n  <file>\n    <path>README.md</path>\n  </file>\n</args>\n</read_file>\n\n❌ COMMON MISTAKES:\n- Missing <args> wrapper\n- Missing <file> wrapper\n- Using <path> directly instead of <file><path>...</path></file>\n- Malformed XML tags`
			pushToolResult(`<files><error>${errorMessage}${fixGuidance}</error></files>`)
			return
		}
	} else if (legacyPath) {
		// Handle legacy single file path as a fallback
		console.warn("[readFileTool] Received legacy 'path' parameter. Consider updating to use 'args' structure.")

		const fileEntry: FileEntry = {
			path: legacyPath,
			lineRanges: [],
		}

		if (legacyStartLineStr && legacyEndLineStr) {
			const start = parseInt(legacyStartLineStr, 10)
			const end = parseInt(legacyEndLineStr, 10)
			if (!isNaN(start) && !isNaN(end) && start > 0 && end > 0) {
				fileEntry.lineRanges?.push({ start, end })
			} else {
				console.warn(
					`[readFileTool] Invalid legacy line range for ${legacyPath}: start='${legacyStartLineStr}', end='${legacyEndLineStr}'`,
				)
			}
		}
		fileEntries.push(fileEntry)
	}

	// If, after trying both new and legacy, no valid file entries are found.
	if (fileEntries.length === 0) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("read_file")
		
		// Fix #3: Track consecutive read_file validation errors
		cline.consecutiveReadFileValidationErrors = (cline.consecutiveReadFileValidationErrors || 0) + 1
		
		// Fix #1: Return structured XML validation error (machine-grabbable)
		const structuredError = `<tool_result tool="read_file" status="error" code="VALIDATION_ERROR" retryable="true">
  <message>Missing required attribute: path</message>
  <expected_call><![CDATA[<read_file>
<args>
  <file>
    <path>src/index.ts</path>
  </file>
</args>
</read_file>]]></expected_call>
  <recovery><![CDATA[If you don't know the path, call <list_files><path>.</path></list_files> or <search_files><path>.</path><regex>.*</regex></search_files> first.]]></recovery>
</tool_result>`
		
		// Fix #2: Trigger hard constraint injection for next turn
		cline.forceConstraintNextTurn = true
		cline.pendingValidationError = {
			tool: "read_file",
			code: "VALIDATION_ERROR",
			message: "Missing required attribute: path",
		}
		
		pushToolResult(structuredError)
		return
	}
	
	// Fix #3: Reset consecutive read_file validation errors on successful read
	cline.consecutiveReadFileValidationErrors = 0

	// Create an array to track the state of each file
	const fileResults: FileResult[] = fileEntries.map((entry) => ({
		path: entry.path || "",
		status: "pending",
		lineRanges: entry.lineRanges,
	}))

	// Function to update file result status
	const updateFileResult = (path: string, updates: Partial<FileResult>) => {
		const index = fileResults.findIndex((result) => result.path === path)
		if (index !== -1) {
			fileResults[index] = { ...fileResults[index], ...updates }
		}
	}

	try {
		// First validate all files and prepare for batch approval
		const filesToApprove: FileResult[] = []

		for (let i = 0; i < fileResults.length; i++) {
			const fileResult = fileResults[i]
			const relPath = fileResult.path
			const fullPath = path.resolve(cline.cwd, relPath)

			// Validate line ranges first
			if (fileResult.lineRanges) {
				let hasRangeError = false
				for (const range of fileResult.lineRanges) {
					if (range.start > range.end) {
						const errorMsg = "Invalid line range: end line cannot be less than start line"
						updateFileResult(relPath, {
							status: "blocked",
							error: errorMsg,
							xmlContent: `<file><path>${relPath}</path><error>Error reading file: ${errorMsg}</error></file>`,
						})
						await handleError(`reading file ${relPath}`, new Error(errorMsg))
						hasRangeError = true
						break
					}
					if (isNaN(range.start) || isNaN(range.end)) {
						const errorMsg = "Invalid line range values"
						updateFileResult(relPath, {
							status: "blocked",
							error: errorMsg,
							xmlContent: `<file><path>${relPath}</path><error>Error reading file: ${errorMsg}</error></file>`,
						})
						await handleError(`reading file ${relPath}`, new Error(errorMsg))
						hasRangeError = true
						break
					}
				}
				if (hasRangeError) continue
			}

			// Then check RooIgnore validation
			if (fileResult.status === "pending") {
				const accessAllowed = cline.rooIgnoreController?.validateAccess(relPath)
				if (!accessAllowed) {
					await cline.say("rooignore_error", relPath)
					const errorMsg = formatResponse.rooIgnoreError(relPath)
					updateFileResult(relPath, {
						status: "blocked",
						error: errorMsg,
						xmlContent: `<file><path>${relPath}</path><error>${errorMsg}</error></file>`,
					})
					continue
				}

				// Add to files that need approval
				filesToApprove.push(fileResult)
			}
		}

		// Handle batch approval if there are multiple files to approve
		if (filesToApprove.length > 1) {
			const { maxReadFileLine = -1 } = (await cline.providerRef.deref()?.getState()) ?? {}

			// Prepare batch file data
			const batchFiles = filesToApprove.map((fileResult) => {
				const relPath = fileResult.path
				const fullPath = path.resolve(cline.cwd, relPath)
				const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

				// Create line snippet for this file
				let lineSnippet = ""
				if (fileResult.lineRanges && fileResult.lineRanges.length > 0) {
					const ranges = fileResult.lineRanges.map((range) =>
						t("tools:readFile.linesRange", { start: range.start, end: range.end }),
					)
					lineSnippet = ranges.join(", ")
				} else if (maxReadFileLine === 0) {
					lineSnippet = t("tools:readFile.definitionsOnly")
				} else if (maxReadFileLine > 0) {
					lineSnippet = t("tools:readFile.maxLines", { max: maxReadFileLine })
				}

				const readablePath = getReadablePath(cline.cwd, relPath)
				const key = `${readablePath}${lineSnippet ? ` (${lineSnippet})` : ""}`

				return {
					path: readablePath,
					lineSnippet,
					isOutsideWorkspace,
					key,
					content: fullPath, // Include full path for content
				}
			})

			const completeMessage = JSON.stringify({
				tool: "readFile",
				batchFiles,
			} satisfies ClineSayTool)

			const { response, text, images } = await cline.ask("tool", completeMessage, false)

			// Process batch response
			if (response === "yesButtonClicked") {
				// Approve all files
				if (text) {
					await cline.say("user_feedback", text, images)
				}
				filesToApprove.forEach((fileResult) => {
					updateFileResult(fileResult.path, {
						status: "approved",
						feedbackText: text,
						feedbackImages: images,
					})
				})
			} else if (response === "noButtonClicked") {
				// Deny all files
				if (text) {
					await cline.say("user_feedback", text, images)
				}
				cline.didRejectTool = true
				filesToApprove.forEach((fileResult) => {
					updateFileResult(fileResult.path, {
						status: "denied",
						xmlContent: `<file><path>${fileResult.path}</path><status>Denied by user</status></file>`,
						feedbackText: text,
						feedbackImages: images,
					})
				})
			} else {
				// Handle individual permissions from objectResponse
				// if (text) {
				// 	await cline.say("user_feedback", text, images)
				// }

				try {
					const individualPermissions = JSON.parse(text || "{}")
					let hasAnyDenial = false

					batchFiles.forEach((batchFile, index) => {
						const fileResult = filesToApprove[index]
						const approved = individualPermissions[batchFile.key] === true

						if (approved) {
							updateFileResult(fileResult.path, {
								status: "approved",
							})
						} else {
							hasAnyDenial = true
							updateFileResult(fileResult.path, {
								status: "denied",
								xmlContent: `<file><path>${fileResult.path}</path><status>Denied by user</status></file>`,
							})
						}
					})

					if (hasAnyDenial) {
						cline.didRejectTool = true
					}
				} catch (error) {
					// Fallback: if JSON parsing fails, deny all files
					console.error("Failed to parse individual permissions:", error)
					cline.didRejectTool = true
					filesToApprove.forEach((fileResult) => {
						updateFileResult(fileResult.path, {
							status: "denied",
							xmlContent: `<file><path>${fileResult.path}</path><status>Denied by user</status></file>`,
						})
					})
				}
			}
		} else if (filesToApprove.length === 1) {
			// Handle single file approval (existing logic)
			const fileResult = filesToApprove[0]
			const relPath = fileResult.path
			const fullPath = path.resolve(cline.cwd, relPath)
			const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)
			const { maxReadFileLine = -1 } = (await cline.providerRef.deref()?.getState()) ?? {}

			// Create line snippet for approval message
			let lineSnippet = ""
			if (fileResult.lineRanges && fileResult.lineRanges.length > 0) {
				const ranges = fileResult.lineRanges.map((range) =>
					t("tools:readFile.linesRange", { start: range.start, end: range.end }),
				)
				lineSnippet = ranges.join(", ")
			} else if (maxReadFileLine === 0) {
				lineSnippet = t("tools:readFile.definitionsOnly")
			} else if (maxReadFileLine > 0) {
				lineSnippet = t("tools:readFile.maxLines", { max: maxReadFileLine })
			}

			const completeMessage = JSON.stringify({
				tool: "readFile",
				path: getReadablePath(cline.cwd, relPath),
				isOutsideWorkspace,
				content: fullPath,
				reason: lineSnippet,
			} satisfies ClineSayTool)

			const { response, text, images } = await cline.ask("tool", completeMessage, false)

			if (response !== "yesButtonClicked") {
				// Handle both messageResponse and noButtonClicked with text
				if (text) {
					await cline.say("user_feedback", text, images)
				}
				cline.didRejectTool = true

				updateFileResult(relPath, {
					status: "denied",
					xmlContent: `<file><path>${relPath}</path><status>Denied by user</status></file>`,
					feedbackText: text,
					feedbackImages: images,
				})
			} else {
				// Handle yesButtonClicked with text
				if (text) {
					await cline.say("user_feedback", text, images)
				}

				updateFileResult(relPath, {
					status: "approved",
					feedbackText: text,
					feedbackImages: images,
				})
			}
		}

		// Track total image memory usage across all files
		const imageMemoryTracker = new ImageMemoryTracker()
		const state = await cline.providerRef.deref()?.getState()
		const {
			maxReadFileLine = -1,
			maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
			maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
		} = state ?? {}

		// Then process only approved files
		for (const fileResult of fileResults) {
			// Skip files that weren't approved
			if (fileResult.status !== "approved") {
				continue
			}

			const relPath = fileResult.path
			
			// Resolve path with fallback to nested project directory
			let fullPath: string
			try {
				const resolvedPath = await resolveFilePathWithFallback(cline.cwd, relPath)
				fullPath = resolvedPath || path.resolve(cline.cwd, relPath)
			} catch {
				// If resolveFilePathWithFallback fails, fall back to simple resolve
				fullPath = path.resolve(cline.cwd, relPath)
			}
			
			// Verify file exists and provide helpful error if not
			const fs = await import("fs/promises")
			try {
				await fs.access(fullPath)
			} catch (error) {
				// File doesn't exist - try to find similar files
				const errorCode = (error as NodeJS.ErrnoException)?.code
				if (errorCode === "ENOENT") {
					// Search for similar file names in the workspace
					const workspaceRoot = cline.cwd
					const fileName = path.basename(relPath)
					const dirName = path.dirname(relPath)
					
					let suggestions: string[] = []
					try {
						// Try to list files in the directory
						const searchDir = path.resolve(workspaceRoot, dirName)
						const entries = await fs.readdir(searchDir, { withFileTypes: true })
						const files = entries
							.filter((e) => e.isFile())
							.map((e) => e.name)
							.filter((name) => name.toLowerCase().includes(fileName.toLowerCase().slice(0, 3)))
						suggestions = files.slice(0, 3).map((f) => path.join(dirName, f))
					} catch {
						// Can't search for suggestions
					}
					
					const suggestionText = suggestions.length > 0 
						? ` Did you mean: ${suggestions.map(s => `"${s}"`).join(", ")}?`
						: ""
					
					const errorMsg = `File not found: "${relPath}" (resolved to: ${fullPath}). Workspace root: ${workspaceRoot}.${suggestionText}`
					throw new Error(errorMsg)
				}
				throw error
			}

			// Process approved files with retry logic for ENOENT errors
			let retries = 3
			let lastError: Error | null = null
			
			while (retries > 0) {
				try {
					const [totalLines, isBinary] = await Promise.all([countFileLines(fullPath), isBinaryFile(fullPath)])

				// Handle binary files (but allow specific file types that extractTextFromFile can handle)
				if (isBinary) {
					const fileExtension = path.extname(relPath).toLowerCase()
					const supportedBinaryFormats = getSupportedBinaryFormats()

					// Check if it's a supported image format
					if (isSupportedImageFormat(fileExtension)) {
						try {
							// Validate image for processing
							const validationResult = await validateImageForProcessing(
								fullPath,
								supportsImages,
								maxImageFileSize,
								maxTotalImageSize,
								imageMemoryTracker.getTotalMemoryUsed(),
							)

							if (!validationResult.isValid) {
								// Track file read
								await cline.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

								updateFileResult(relPath, {
									xmlContent: `<file><path>${relPath}</path>\n<notice>${validationResult.notice}</notice>\n</file>`,
								})
								continue
							}

							// Process the image
							const imageResult = await processImageFile(fullPath)

							// Track memory usage for this image
							imageMemoryTracker.addMemoryUsage(imageResult.sizeInMB)

							// Track file read
							await cline.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

							// Store image data URL separately - NOT in XML
							updateFileResult(relPath, {
								xmlContent: `<file><path>${relPath}</path>\n<notice>${imageResult.notice}</notice>\n</file>`,
								imageDataUrl: imageResult.dataUrl,
							})
							continue
						} catch (error) {
							const errorMsg = error instanceof Error ? error.message : String(error)
							updateFileResult(relPath, {
								status: "error",
								error: `Error reading image file: ${errorMsg}`,
								xmlContent: `<file><path>${relPath}</path><error>Error reading image file: ${errorMsg}</error></file>`,
							})
							await handleError(
								`reading image file ${relPath}`,
								error instanceof Error ? error : new Error(errorMsg),
							)
							continue
						}
					}

					// Check if it's a supported binary format that can be processed
					if (supportedBinaryFormats && supportedBinaryFormats.includes(fileExtension)) {
						// For supported binary formats (.pdf, .docx, .ipynb), continue to extractTextFromFile
						// Fall through to the normal extractTextFromFile processing below
					} else {
						// Handle unknown binary format
						const fileFormat = fileExtension.slice(1) || "bin" // Remove the dot, fallback to "bin"
						updateFileResult(relPath, {
							notice: `Binary file format: ${fileFormat}`,
							xmlContent: `<file><path>${relPath}</path>\n<binary_file format="${fileFormat}">Binary file - content not displayed</binary_file>\n</file>`,
						})
						continue
					}
				}

				// Handle range reads (bypass maxReadFileLine)
				if (fileResult.lineRanges && fileResult.lineRanges.length > 0) {
					const rangeResults: string[] = []
					for (const range of fileResult.lineRanges) {
						const content = addLineNumbers(
							await readLines(fullPath, range.end - 1, range.start - 1),
							range.start,
						)
						const lineRangeAttr = ` lines="${range.start}-${range.end}"`
						rangeResults.push(`<content${lineRangeAttr}>\n${content}</content>`)
					}
					updateFileResult(relPath, {
						xmlContent: `<file><path>${relPath}</path>\n${rangeResults.join("\n")}\n</file>`,
					})
					continue
				}

				// Handle definitions-only mode
				if (maxReadFileLine === 0) {
					try {
						const defResult = await parseSourceCodeDefinitionsForFile(fullPath, cline.rooIgnoreController)
						if (defResult) {
							let xmlInfo = `<notice>Showing only ${maxReadFileLine} of ${totalLines} total lines. Use line_range if you need to read more lines</notice>\n`
							updateFileResult(relPath, {
								xmlContent: `<file><path>${relPath}</path>\n<list_code_definition_names>${defResult}</list_code_definition_names>\n${xmlInfo}</file>`,
							})
						}
					} catch (error) {
						if (error instanceof Error && error.message.startsWith("Unsupported language:")) {
							console.warn(`[read_file] Warning: ${error.message}`)
						} else {
							console.error(
								`[read_file] Unhandled error: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
					}
					continue
				}

				// Handle files exceeding line threshold
				if (maxReadFileLine > 0 && totalLines > maxReadFileLine) {
					const content = addLineNumbers(await readLines(fullPath, maxReadFileLine - 1, 0))
					const lineRangeAttr = ` lines="1-${maxReadFileLine}"`
					let xmlInfo = `<content${lineRangeAttr}>\n${content}</content>\n`

					try {
						const defResult = await parseSourceCodeDefinitionsForFile(fullPath, cline.rooIgnoreController)
						if (defResult) {
							xmlInfo += `<list_code_definition_names>${defResult}</list_code_definition_names>\n`
						}
						xmlInfo += `<notice>Showing only ${maxReadFileLine} of ${totalLines} total lines. Use line_range if you need to read more lines</notice>\n`
						updateFileResult(relPath, {
							xmlContent: `<file><path>${relPath}</path>\n${xmlInfo}</file>`,
						})
					} catch (error) {
						if (error instanceof Error && error.message.startsWith("Unsupported language:")) {
							console.warn(`[read_file] Warning: ${error.message}`)
						} else {
							console.error(
								`[read_file] Unhandled error: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
					}
					continue
				}

				// Handle normal file read with character limit to avoid 429 TPM errors
				const MAX_FILE_CHARS = 50000 // Hard cap: 50k chars per file to reduce request size
				let content = await extractTextFromFile(fullPath)
				
				// Truncate if exceeds limit (deterministic: always truncate at same point)
				if (content.length > MAX_FILE_CHARS) {
					content = content.substring(0, MAX_FILE_CHARS) + `\n\n[File truncated: showing first ${MAX_FILE_CHARS} of ${content.length} characters. Use line_range to read specific sections.]`
					console.log(`[readFileTool] Truncated ${relPath}: ${content.length} -> ${MAX_FILE_CHARS} chars`)
				}
				
				const lineRangeAttr = ` lines="1-${totalLines}"`
				let xmlInfo = totalLines > 0 ? `<content${lineRangeAttr}>\n${content}</content>\n` : `<content/>`

				if (totalLines === 0) {
					xmlInfo += `<notice>File is empty</notice>\n`
				}

				// Track file read
				await cline.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

				// Reset the consecutive diff failure counter for this file
				// This allows apply_diff to be attempted again after reading the file
				if (cline.consecutiveMistakeCountForApplyDiff.has(relPath)) {
					cline.consecutiveMistakeCountForApplyDiff.delete(relPath)
				}

				updateFileResult(relPath, {
					xmlContent: `<file><path>${relPath}</path>\n${xmlInfo}</file>`,
				})
				// Success - break out of retry loop
				break
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error))
					const errorCode = (error as NodeJS.ErrnoException)?.code
					
					// Retry on ENOENT (file not found) if we have retries left
					if (errorCode === "ENOENT" && retries > 1) {
						retries--
						// Short delay before retry (200ms)
						await new Promise((resolve) => setTimeout(resolve, 200))
						
						// Try resolving path again in case workspace wasn't ready
						try {
							const resolvedPath = await resolveFilePathWithFallback(cline.cwd, relPath)
							if (resolvedPath && resolvedPath !== fullPath) {
								fullPath = resolvedPath
								console.log(`[readFileTool] Retry: resolved ${relPath} to ${fullPath}`)
							}
						} catch {
							// Path resolution failed, continue with original path
						}
						continue
					}
					
					// No more retries or non-ENOENT error - report error
					const errorMsg = lastError.message
					updateFileResult(relPath, {
						status: "error",
						error: `Error reading file: ${errorMsg}`,
						xmlContent: `<file><path>${relPath}</path><error>Error reading file: ${errorMsg}</error></file>`,
					})
					await handleError(`reading file ${relPath}`, lastError)
					break
				}
			}
		}

		// Generate final XML result from all file results
		const xmlResults = fileResults.filter((result) => result.xmlContent).map((result) => result.xmlContent)
		const filesXml = `<files>\n${xmlResults.join("\n")}\n</files>`

		// Collect all image data URLs from file results
		const fileImageUrls = fileResults
			.filter((result) => result.imageDataUrl)
			.map((result) => result.imageDataUrl as string)

		// Process all feedback in a unified way without branching
		let statusMessage = ""
		let feedbackImages: any[] = []

		// Handle denial with feedback (highest priority)
		const deniedWithFeedback = fileResults.find((result) => result.status === "denied" && result.feedbackText)

		if (deniedWithFeedback && deniedWithFeedback.feedbackText) {
			statusMessage = formatResponse.toolDeniedWithFeedback(deniedWithFeedback.feedbackText)
			feedbackImages = deniedWithFeedback.feedbackImages || []
		}
		// Handle generic denial
		else if (cline.didRejectTool) {
			statusMessage = formatResponse.toolDenied()
		}
		// Handle approval with feedback
		else {
			const approvedWithFeedback = fileResults.find(
				(result) => result.status === "approved" && result.feedbackText,
			)

			if (approvedWithFeedback && approvedWithFeedback.feedbackText) {
				statusMessage = formatResponse.toolApprovedWithFeedback(approvedWithFeedback.feedbackText)
				feedbackImages = approvedWithFeedback.feedbackImages || []
			}
		}

		// Combine all images: feedback images first, then file images
		const allImages = [...feedbackImages, ...fileImageUrls]

		// Re-check if the model supports images before including them, in case it changed during execution.
		const finalModelSupportsImages = cline.api.getModel().info.supportsImages ?? false
		const imagesToInclude = finalModelSupportsImages ? allImages : []

		// Push the result with appropriate formatting
		if (statusMessage || imagesToInclude.length > 0) {
			// Always use formatResponse.toolResult when we have a status message or images
			const result = formatResponse.toolResult(
				statusMessage || filesXml,
				imagesToInclude.length > 0 ? imagesToInclude : undefined,
			)

			// Handle different return types from toolResult
			if (typeof result === "string") {
				if (statusMessage) {
					pushToolResult(`${result}\n${filesXml}`)
				} else {
					pushToolResult(result)
				}
			} else {
				// For block-based results, append the files XML as a text block if not already included
				if (statusMessage) {
					const textBlock = { type: "text" as const, text: filesXml }
					pushToolResult([...result, textBlock])
				} else {
					pushToolResult(result)
				}
			}
		} else {
			// No images or status message, just push the files XML
			pushToolResult(filesXml)
		}
	} catch (error) {
		// Handle all errors using per-file format for consistency
		const relPath = fileEntries[0]?.path || "unknown"
		const errorMsg = error instanceof Error ? error.message : String(error)

		// If we have file results, update the first one with the error
		if (fileResults.length > 0) {
			updateFileResult(relPath, {
				status: "error",
				error: `Error reading file: ${errorMsg}`,
				xmlContent: `<file><path>${relPath}</path><error>Error reading file: ${errorMsg}</error></file>`,
			})
		}

		await handleError(`reading file ${relPath}`, error instanceof Error ? error : new Error(errorMsg))

		// Generate final XML result from all file results
		const xmlResults = fileResults.filter((result) => result.xmlContent).map((result) => result.xmlContent)

		pushToolResult(`<files>\n${xmlResults.join("\n")}\n</files>`)
	}
}
