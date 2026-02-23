import fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import delay from "delay"

import {
	CommandExecutionStatus,
	DEFAULT_TERMINAL_OUTPUT_CHARACTER_LIMIT,
	getApiProtocol,
	getModelId,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"

import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag, ToolResponse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { ExitCodeDetails, RooTerminalCallbacks, RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { Terminal } from "../../integrations/terminal/Terminal"
import { Package } from "../../shared/package"
import { t } from "../../i18n"

class ShellIntegrationError extends Error {}

export async function executeCommandTool(
	task: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	let command: string | undefined = block.params.command
	const customCwd: string | undefined = block.params.cwd

	try {
		if (block.partial) {
			await task.ask("command", removeClosingTag("command", command), block.partial).catch(() => {})
			return
		} else {
			if (!command) {
				task.consecutiveMistakeCount++
				task.recordToolError("execute_command")
				pushToolResult(await task.sayAndCreateMissingParamError("execute_command", "command"))
				return
			}

			const ignoredFileAttemptedToAccess = task.rooIgnoreController?.validateCommand(command)

			if (ignoredFileAttemptedToAccess) {
				await task.say("rooignore_error", ignoredFileAttemptedToAccess)
				pushToolResult(formatResponse.toolError(formatResponse.rooIgnoreError(ignoredFileAttemptedToAccess)))
				return
			}

			task.consecutiveMistakeCount = 0

			command = unescapeHtmlEntities(command) // Unescape HTML entities.

			// Guard: Detect when the model tries to run XML tools as shell commands.
			// GPT-5 and similar models sometimes confuse tool calls with CLI commands.
			// Uses forceConstraintNextTurn to inject a hard directive on the next turn.
			const lowerCmdCheck = command.toLowerCase().trim()
			if (lowerCmdCheck.startsWith("rollback_to_checkpoint") || lowerCmdCheck.startsWith("save_checkpoint")) {
				task.consecutiveMistakeCount++
				task.recordToolError("execute_command", `Tried to run XML tool as shell command: ${command}`)
				const toolName = lowerCmdCheck.startsWith("rollback") ? "rollback_to_checkpoint" : "save_checkpoint"
				const paramName = toolName === "rollback_to_checkpoint" ? "checkpoint_name" : "name"
				// Extract the argument from the command (e.g. rollback_to_checkpoint "C1_tests" → C1_tests)
				const argMatch = command.match(/["']([^"']+)["']/) || command.match(/\s+(\S+)$/)
				const argValue = argMatch ? argMatch[1] : "C1_tests"

				const correctXml = `<${toolName}>\n<${paramName}>${argValue}</${paramName}>\n</${toolName}>`

				// Inject hard constraint on next turn so the model uses the correct XML format
				task.pendingValidationError = {
					tool: "execute_command",
					code: "TOOL_IS_NOT_CLI_COMMAND",
					message:
						`CRITICAL: ${toolName} is an XML tool, NOT a shell command or CLI executable. ` +
						`It does not exist in the terminal. Do NOT use execute_command, do NOT ask the user how to run it, ` +
						`do NOT look for a script or executable. ` +
						`Your ONLY correct action is to output this exact XML on your next turn:\n\n${correctXml}\n\n` +
						`This XML is interpreted by the tool system directly. Just output it as your next tool call.`,
				}
				task.forceConstraintNextTurn = true

				pushToolResult(
					formatResponse.toolError(
						`${toolName} is NOT a shell command — it is an XML tool built into this system.\n\n` +
							`Do NOT use execute_command. Do NOT ask the user. Do NOT look for a script.\n\n` +
							`Output this XML as your next tool call:\n${correctXml}`,
					),
				)
				return
			}

			// Guard: Forbid manual git rollback commands when checkpoints are enabled
			// During rollback drills (Stage 2), only the rollback_to_checkpoint tool should be used
			if (task.enableCheckpoints) {
				const lowerCmd = command.toLowerCase().trim()
				const forbiddenPatterns = [
					/git\s+reset(\s+--hard)?/,
					/git\s+restore/,
					/git\s+checkout\s+[a-f0-9]{7,40}/, // git checkout <hash>
					/git\s+revert/,
					/git\s+clean\s+-[fFdD]/,
				]

				for (const pattern of forbiddenPatterns) {
					if (pattern.test(lowerCmd)) {
						task.consecutiveMistakeCount++
						task.recordToolError("execute_command", `Forbidden git rollback command: ${command}`)
						pushToolResult(
							formatResponse.toolError(
								`FORBIDDEN: Manual git rollback commands are not allowed when checkpoints are enabled.\n\n` +
									`Command attempted: ${command}\n\n` +
									`To rollback, you MUST use the rollback_to_checkpoint tool:\n` +
									`<rollback_to_checkpoint>\n` +
									`<checkpoint_name>C1_tests</checkpoint_name>\n` +
									`</rollback_to_checkpoint>\n\n` +
									`Do NOT use git reset, git restore, git checkout <hash>, git revert, or git clean. ` +
									`These commands bypass the checkpoint mechanism and will cause verification failures.`,
							),
						)
						return
					}
				}
			}

			// Guard against runaway loops where the model repeats the same command over and over.
			// This is especially common in torture runs (and can burn the entire timeout budget).
			if (process.env.TEST_TORTURE_REPO === "1") {
				const normalized = command.trim().replace(/\s+/g, " ")
				if (task.lastExecuteCommandNormalized === normalized) {
					task.consecutiveExecuteCommandSameCount++
				} else {
					task.lastExecuteCommandNormalized = normalized
					task.consecutiveExecuteCommandSameCount = 1
				}

				// Allow a few repeats (sometimes a command is legitimately retried),
				// but stop the runaway case.
				if (task.consecutiveExecuteCommandSameCount >= 6) {
					task.consecutiveMistakeCount++
					task.recordToolError(
						"execute_command",
						`Repeated same command ${task.consecutiveExecuteCommandSameCount} times: ${normalized}`,
					)
					pushToolResult(
						formatResponse.toolError(
							`Repeated the same command ${task.consecutiveExecuteCommandSameCount} times. ` +
								`Stop repeating and proceed with code changes/tests. Command: ${normalized}`,
						),
					)
					return
				}
			}

			const didApprove = await askApproval("command", command)

			if (!didApprove) {
				return
			}

			const executionId = task.lastMessageTs?.toString() ?? Date.now().toString()
			const provider = await task.providerRef.deref()
			const providerState = await provider?.getState()

			const isStage2 = process.env.TEST_TORTURE_STAGE === "2"
			const {
				terminalOutputLineLimit: stateLineLimit = 500,
				terminalOutputCharacterLimit: stateCharLimit = DEFAULT_TERMINAL_OUTPUT_CHARACTER_LIMIT,
				terminalShellIntegrationDisabled = false,
			} = providerState ?? {}
			// Payload control: stricter limits for Stage 2 to avoid "request too large" errors
			const terminalOutputLineLimit = isStage2 ? 200 : stateLineLimit
			const terminalOutputCharacterLimit = isStage2 ? 12_000 : stateCharLimit

			// Get command execution timeout from VSCode configuration (in seconds)
			const commandExecutionTimeoutSeconds = vscode.workspace
				.getConfiguration(Package.name)
				.get<number>("commandExecutionTimeout", 0)

			// Get command timeout allowlist from VSCode configuration
			const commandTimeoutAllowlist = vscode.workspace
				.getConfiguration(Package.name)
				.get<string[]>("commandTimeoutAllowlist", [])

			// Check if command matches any prefix in the allowlist
			const isCommandAllowlisted = commandTimeoutAllowlist.some((prefix) => command!.startsWith(prefix.trim()))

			// Convert seconds to milliseconds for internal use, but skip timeout if command is allowlisted
			const commandExecutionTimeout = isCommandAllowlisted ? 0 : commandExecutionTimeoutSeconds * 1000

			const options: ExecuteCommandOptions = {
				executionId,
				command,
				customCwd,
				terminalShellIntegrationDisabled,
				terminalOutputLineLimit,
				terminalOutputCharacterLimit,
				commandExecutionTimeout,
			}

			try {
				// Transactional terminal gating: route via Control-Plane when enabled
				const cfg = vscode.workspace.getConfiguration()
				const transactional =
					cfg.get<boolean>("roo.experimental.transactionalMode") ||
					cfg.get<boolean>("roo-cline.experimental.transactionalMode")

				if (transactional && !task.skipTransactionalWrites) {
					const txId = await vscode.commands.executeCommand<string>("roo.internal.getCurrentTxId")
					const provider = task.providerRef.deref()
					const port = provider?.context?.globalState.get<number>("roo.cpPort")
					if (txId) {
						if (!port) {
							// CP not running; fall through to local execution
						} else {
							const args = ["bash", "-lc", command]
							const res = await fetch(`http://127.0.0.1:${port}/shell/exec/${txId}`, {
								method: "POST",
								headers: { "Content-Type": "application/json", "X-Actor-Id": "human" },
								body: JSON.stringify({
									cmd: args[0],
									args: args.slice(1),
									cwd_rel: "",
									timeout_ms: commandExecutionTimeout || 600000,
								}),
							})
							const body = await res.json().catch(() => ({}))
							const stdout = Buffer.from(body.stdout_base64 || "", "base64").toString("utf8")
							const stderr = Buffer.from(body.stderr_base64 || "", "base64").toString("utf8")
							const rawOutput = [stdout, stderr].filter(Boolean).join("\n")
							// Payload control: compress large outputs to avoid "request too large" errors
							let output = rawOutput
							if (rawOutput && rawOutput.length > 0) {
								const compressed = Terminal.compressTerminalOutput(
									rawOutput,
									terminalOutputLineLimit,
									terminalOutputCharacterLimit,
								)
								if (isStage2 && rawOutput.length > 12_000) {
									// Save full output to file, pass summary + path
									const outPath = path.join(task.cwd || "", ".roo-output.txt")
									try {
										await fs.writeFile(outPath, rawOutput, "utf8")
										const exitHint =
											body.exit_code !== undefined ? ` Exit code: ${body.exit_code}.` : ""
										output = `${compressed}\n\n[Full output saved to .roo-output.txt]${exitHint}`
									} catch {
										output = compressed
									}
								} else {
									output = compressed
								}
							}
							pushToolResult(output || "<no output>")
							return
						}
					}
				}

				// Logging: Track tool execution
				const provider = await task.providerRef.deref()
				if (provider && process.env.ROO_DEBUG_TOOL_EXECUTION) {
					const modelId = task.api.getModel().id
					const apiProtocol = getApiProtocol((task.apiConfiguration as any)?.apiProvider, modelId)
					provider.log(
						`[executeCommandTool] Executing command - Protocol: ${apiProtocol}, Provider: ${(task.apiConfiguration as any)?.apiProvider}, Model: ${modelId}, Command: ${command.substring(0, 100)}`,
					)
				}

				const [rejected, result] = await executeCommand(task, options)

				if (rejected) {
					task.didRejectTool = true
				}

				// Logging: Track tool execution result
				const providerForLogging = await task.providerRef.deref()
				if (providerForLogging && process.env.ROO_DEBUG_TOOL_EXECUTION) {
					const resultPreview =
						typeof result === "string" ? result.substring(0, 200) : JSON.stringify(result).substring(0, 200)
					providerForLogging.log(
						`[executeCommandTool] Command execution completed - Rejected: ${rejected}, Result preview: ${resultPreview}`,
					)
				}

				pushToolResult(result)
			} catch (error: unknown) {
				const status: CommandExecutionStatus = { executionId, status: "fallback" }
				provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
				await task.say("shell_integration_warning")

				if (error instanceof ShellIntegrationError) {
					const [rejected, result] = await executeCommand(task, {
						...options,
						terminalShellIntegrationDisabled: true,
					})

					if (rejected) {
						task.didRejectTool = true
					}

					pushToolResult(result)
				} else {
					pushToolResult(`Command failed to execute in terminal due to a shell integration error.`)
				}
			}

			return
		}
	} catch (error) {
		await handleError("executing command", error)
		return
	}
}

export type ExecuteCommandOptions = {
	executionId: string
	command: string
	customCwd?: string
	terminalShellIntegrationDisabled?: boolean
	terminalOutputLineLimit?: number
	terminalOutputCharacterLimit?: number
	commandExecutionTimeout?: number
}

export async function executeCommand(
	task: Task,
	{
		executionId,
		command,
		customCwd,
		terminalShellIntegrationDisabled = false,
		terminalOutputLineLimit = 500,
		terminalOutputCharacterLimit = DEFAULT_TERMINAL_OUTPUT_CHARACTER_LIMIT,
		commandExecutionTimeout = 0,
	}: ExecuteCommandOptions,
): Promise<[boolean, ToolResponse]> {
	// Convert milliseconds back to seconds for display purposes.
	const commandExecutionTimeoutSeconds = commandExecutionTimeout / 1000
	let workingDir: string

	if (!customCwd) {
		workingDir = task.cwd
	} else if (path.isAbsolute(customCwd)) {
		workingDir = customCwd
	} else {
		workingDir = path.resolve(task.cwd, customCwd)
	}

	try {
		await fs.access(workingDir)
	} catch (error) {
		return [false, `Working directory '${workingDir}' does not exist.`]
	}

	let message: { text?: string; images?: string[] } | undefined
	let runInBackground = false
	let completed = false
	let result: string = ""
	let exitDetails: ExitCodeDetails | undefined
	let shellIntegrationError: string | undefined

	const terminalProvider = terminalShellIntegrationDisabled ? "execa" : "vscode"
	const provider = await task.providerRef.deref()

	let accumulatedOutput = ""
	const callbacks: RooTerminalCallbacks = {
		onLine: async (lines: string, process: RooTerminalProcess) => {
			accumulatedOutput += lines
			const compressedOutput = Terminal.compressTerminalOutput(
				accumulatedOutput,
				terminalOutputLineLimit,
				terminalOutputCharacterLimit,
			)
			const status: CommandExecutionStatus = { executionId, status: "output", output: compressedOutput }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })

			if (runInBackground) {
				return
			}

			try {
				const { response, text, images } = await task.ask("command_output", "")
				runInBackground = true

				if (response === "messageResponse") {
					message = { text, images }
					process.continue()
				}
			} catch (_error) {}
		},
		onCompleted: (output: string | undefined) => {
			result = Terminal.compressTerminalOutput(
				output ?? "",
				terminalOutputLineLimit,
				terminalOutputCharacterLimit,
			)

			task.say("command_output", result)
			completed = true
		},
		onShellExecutionStarted: (pid: number | undefined) => {
			console.log(`[executeCommand] onShellExecutionStarted: ${pid}`)
			const status: CommandExecutionStatus = { executionId, status: "started", pid, command }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
		},
		onShellExecutionComplete: (details: ExitCodeDetails) => {
			const status: CommandExecutionStatus = { executionId, status: "exited", exitCode: details.exitCode }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
			exitDetails = details
		},
	}

	if (terminalProvider === "vscode") {
		callbacks.onNoShellIntegration = async (error: string) => {
			TelemetryService.instance.captureShellIntegrationError(task.taskId)
			shellIntegrationError = error
		}
	}

	const terminal = await TerminalRegistry.getOrCreateTerminal(workingDir, task.taskId, terminalProvider)

	if (terminal instanceof Terminal) {
		terminal.terminal.show(true)

		// Update the working directory in case the terminal we asked for has
		// a different working directory so that the model will know where the
		// command actually executed.
		workingDir = terminal.getCurrentWorkingDirectory()
	}

	const process = terminal.runCommand(command, callbacks)
	task.terminalProcess = process

	// Implement command execution timeout (skip if timeout is 0).
	if (commandExecutionTimeout > 0) {
		let timeoutId: NodeJS.Timeout | undefined
		let isTimedOut = false

		const timeoutPromise = new Promise<void>((_, reject) => {
			timeoutId = setTimeout(() => {
				isTimedOut = true
				task.terminalProcess?.abort()
				reject(new Error(`Command execution timed out after ${commandExecutionTimeout}ms`))
			}, commandExecutionTimeout)
		})

		try {
			await Promise.race([process, timeoutPromise])
		} catch (error) {
			if (isTimedOut) {
				const status: CommandExecutionStatus = { executionId, status: "timeout" }
				provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
				await task.say("error", t("common:errors:command_timeout", { seconds: commandExecutionTimeoutSeconds }))
				task.terminalProcess = undefined

				return [
					false,
					`The command was terminated after exceeding a user-configured ${commandExecutionTimeoutSeconds}s timeout. Do not try to re-run the command.`,
				]
			}
			throw error
		} finally {
			if (timeoutId) {
				clearTimeout(timeoutId)
			}

			task.terminalProcess = undefined
		}
	} else {
		// No timeout - just wait for the process to complete.
		try {
			await process
		} finally {
			task.terminalProcess = undefined
		}
	}

	if (shellIntegrationError) {
		throw new ShellIntegrationError(shellIntegrationError)
	}

	// Wait for a short delay to ensure all messages are sent to the webview.
	// This delay allows time for non-awaited promises to be created and
	// for their associated messages to be sent to the webview, maintaining
	// the correct order of messages (although the webview is smart about
	// grouping command_output messages despite any gaps anyways).
	await delay(50)

	if (message) {
		const { text, images } = message
		await task.say("user_feedback", text, images)

		return [
			true,
			formatResponse.toolResult(
				[
					`Command is still running in terminal from '${terminal.getCurrentWorkingDirectory().toPosix()}'.`,
					result.length > 0 ? `Here's the output so far:\n${result}\n` : "\n",
					`The user provided the following feedback:`,
					`<feedback>\n${text}\n</feedback>`,
				].join("\n"),
				images,
			),
		]
	} else if (completed || exitDetails) {
		let exitStatus: string = ""

		if (exitDetails !== undefined) {
			if (exitDetails.signalName) {
				exitStatus = `Process terminated by signal ${exitDetails.signalName}`

				if (exitDetails.coreDumpPossible) {
					exitStatus += " - core dump possible"
				}
			} else if (exitDetails.exitCode === undefined) {
				result += "<VSCE exit code is undefined: terminal output and command execution status is unknown.>"
				exitStatus = `Exit code: <undefined, notify user>`
			} else {
				if (exitDetails.exitCode !== 0) {
					// Provide more specific error guidance based on exit code
					if (exitDetails.exitCode === 1 && result.trim() === "") {
						// Common case: command not found or no matches (ripgrep returns 1 for no matches)
						exitStatus += "Command execution completed but may indicate:\n"
						exitStatus += "- Command not found (check if the command is installed and in PATH)\n"
						exitStatus +=
							"- No matches found (for search commands like grep/ripgrep, this is normal if nothing matches)\n"
						exitStatus += "- Command failed silently (check command syntax and permissions)\n"
					} else {
						exitStatus += "Command execution was not successful. "
						if (result.trim()) {
							exitStatus += "Error output:\n"
						} else {
							exitStatus +=
								"No output was produced. This may indicate the command failed or was not found.\n"
						}
					}
				}

				exitStatus += `Exit code: ${exitDetails.exitCode}`
			}
		} else {
			result += "<VSCE exitDetails == undefined: terminal output and command execution status is unknown.>"
			exitStatus = `Exit code: <undefined, notify user>`
		}

		let workingDirInfo = ` within working directory '${terminal.getCurrentWorkingDirectory().toPosix()}'`

		return [false, `Command executed in terminal ${workingDirInfo}. ${exitStatus}\nOutput:\n${result}`]
	} else {
		return [
			false,
			[
				`Command is still running in terminal ${workingDir ? ` from '${workingDir.toPosix()}'` : ""}.`,
				result.length > 0 ? `Here's the output so far:\n${result}\n` : "\n",
				"You will be updated on the terminal status and new output in the future.",
			].join("\n"),
		]
	}
}
