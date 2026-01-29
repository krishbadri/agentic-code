import type { Plan } from "./types"
import { PLANNER_SYSTEM_PROMPT } from "./prompts"
import type { Task } from "../task/Task"
import delay from "delay"
import {
	waitForRateLimit,
	recordRateLimitError as recordRateLimitErrorCoordinator,
	getRateLimitDelay,
	isRateLimitError,
} from "../rate-limit/RateLimitCoordinator"

const MAX_RETRIES = 2 // Reduced from 3 to fail faster
const INITIAL_RETRY_DELAY_MS = 2000
const MAX_RETRY_DELAY_MS = 60000

// Circuit breaker: track recent rate limit errors to prevent cascading failures
const RATE_LIMIT_WINDOW_MS = 60000 // 1 minute window
const MAX_RATE_LIMITS_PER_WINDOW = 3 // Max rate limit errors before circuit opens

interface RateLimitEvent {
	timestamp: number
}

// Global circuit breaker state (shared across all PlannerAgent instances)
let rateLimitHistory: RateLimitEvent[] = []

/**
 * Check if circuit breaker should prevent retries
 */
export function shouldOpenCircuitBreaker(): boolean {
	const now = Date.now()
	// Remove events outside the window
	rateLimitHistory = rateLimitHistory.filter((event) => now - event.timestamp < RATE_LIMIT_WINDOW_MS)
	
	// If we've hit too many rate limits recently, open the circuit
	return rateLimitHistory.length >= MAX_RATE_LIMITS_PER_WINDOW
}

/**
 * Record a rate limit error
 */
function recordRateLimitError(): void {
	rateLimitHistory.push({ timestamp: Date.now() })
}

export class PlannerAgent {
	constructor(private task: Task) {}

	/**
	 * Extracts retry delay from Groq rate limit error message.
	 * Groq error format: "429 Rate limit reached... Please try again in X.XXs"
	 */
	private extractRetryDelay(errorMessage: string): number | null {
		const match = errorMessage.match(/try again in ([\d.]+)s/i)
		if (match) {
			const seconds = parseFloat(match[1])
			if (!isNaN(seconds) && seconds > 0) {
				return Math.ceil(seconds * 1000) // Convert to milliseconds
			}
		}
		return null
	}

	/**
	 * Checks if an error is a rate limit error (429)
	 */
	private isRateLimitError(error: unknown): boolean {
		if (error && typeof error === "object") {
			const err = error as any
			// Check for status code 429
			if (err.status === 429) {
				return true
			}
			// Check error message for rate limit indicators
			if (err.message && typeof err.message === "string") {
				return /429|rate limit|rate limit reached/i.test(err.message)
			}
		}
		return false
	}

	/**
	 * Maps the repository structure by dynamically scanning the workspace.
	 * This ensures plans reference real file paths, not guessed ones.
	 * 
	 * IMPORTANT: This replaces the old hardcoded approach that only looked for
	 * specific files like "src/txn_demo/cli.py". Now it scans the actual workspace.
	 */
	private async mapRepositoryStructure(): Promise<string> {
		const { getRepositoryStructureSummary, listFilesRecursively } = await import("../../utils/fs")
		const workspaceRoot = this.task.cwd

		try {
			// Get a comprehensive summary of the repository structure
			const summary = await getRepositoryStructureSummary(workspaceRoot, 3)
			
			// Also list all source files for more detailed grounding
			const allFiles = await listFilesRecursively(workspaceRoot, 4)
			
			if (allFiles.length === 0) {
				return summary + "\n\n⚠️ No source files found in workspace."
			}
			
			// Build a detailed file list (limited to prevent token bloat)
			const fileListHeader = `\n\nALL SOURCE FILES IN WORKSPACE (${allFiles.length} total):`
			const maxFilesToShow = 50
			const fileList = allFiles.slice(0, maxFilesToShow).map((f) => `  ✓ ${f}`).join("\n")
			const truncationNote = allFiles.length > maxFilesToShow 
				? `\n  ... and ${allFiles.length - maxFilesToShow} more files (use search_files to find specific files)`
				: ""
			
			return summary + fileListHeader + "\n" + fileList + truncationNote
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.task.providerRef.deref()?.log(`[PlannerAgent] Failed to map repository structure: ${errorMessage}`)
			return "⚠️ Could not scan repository structure. Use search_files to find files."
		}
	}
	
	/**
	 * Validates file paths mentioned in a plan's sub-transactions.
	 * Returns warnings for any non-existent files referenced.
	 */
	private async validatePlanFilePaths(plan: Plan): Promise<string[]> {
		const { extractFilePathsFromText, validateFilePaths } = await import("../../utils/fs")
		const workspaceRoot = this.task.cwd
		const warnings: string[] = []
		
		for (const subTx of plan.subTransactions) {
			// Extract file paths from the prompt
			const promptPaths = extractFilePathsFromText(subTx.prompt || "")
			
			// Extract file paths from steps - ensure target is actually a string
			// (LLM might return arrays or other types instead)
			const stepPaths: string[] = (subTx.steps || [])
				.filter((step: any) => step.target && typeof step.target === "string")
				.map((step: any) => step.target as string)
			
			const allPaths = [...new Set([...promptPaths, ...stepPaths])]
			
			if (allPaths.length > 0) {
				const { nonExistent } = await validateFilePaths(allPaths, workspaceRoot)
				if (nonExistent.length > 0) {
					warnings.push(
						`Sub-transaction "${subTx.id}" references non-existent files: ${nonExistent.join(", ")}`
					)
				}
			}
		}
		
		return warnings
	}

	async generatePlan(userPrompt: string, retryAttempt: number = 0, forceComplex: boolean = false): Promise<Plan> {
		// Map repository structure before generating plan
		const repoStructure = await this.mapRepositoryStructure()
		
		let plannerPrompt: string
		
		if (forceComplex) {
			// STRONGER PROMPT: Used when heuristics indicate complexity but LLM returned empty plan
			plannerPrompt = `CRITICAL: This task has been flagged as COMPLEX by heuristic analysis. You MUST create a plan with sub-transactions.

Task: ${userPrompt}

This task shows multiple indicators of complexity:
- Multiple files or components mentioned
- Multi-step operations requiring coordination
- Large-scale operations (refactoring, migration, etc.)
- Multiple agent types needed (coder + tester, coder + reviewer, etc.)
- Explicit dependencies between steps

You MUST break this down into sub-transactions. Do NOT return an empty plan.

REQUIRED: Create a plan with at least 2 sub-transactions (MAXIMUM 10 total). For each sub-transaction, specify:
- Which agent type should handle it (coder, tester, reviewer, or general)
- What specific work needs to be done
- Whether it can run in parallel with others
- What it depends on (if anything)
- What safety checks should run after it completes

CRITICAL: When creating prompts for sub-transactions, ALWAYS include specific file paths. For example:
- Instead of: "Review the code and tests"
- Use: "Review src/txn_demo/cli.py, src/txn_demo/config.py, and tests/test_cli.py for correctness, clarity, and adherence to project standards"

The prompt should tell the agent EXACTLY which files to work with. Include file paths directly in the prompt text.

REPOSITORY STRUCTURE (use these actual paths):
${repoStructure}

IMPORTANT: Only reference files that exist in the repository structure above. Do not invent paths like "src/store/*" or "src/cli.py" unless they are listed above.

Output only valid JSON matching the required structure. DO NOT return {"subTransactions": []}.`
		} else {
			// NORMAL PROMPT: Standard planning decision
			plannerPrompt = `Analyze this coding task and determine if it needs multi-agent planning.

Task: ${userPrompt}

IMPORTANT: If this is a simple task (explanation, single-file edit, quick question), return {"subTransactions": []} immediately.

Simple tasks that must return empty plan:
- Explanatory queries: "explain X", "what does Y do", "describe Z"
- Single-file edits that don't require coordination
- Quick questions or informational requests
- Tasks that can be completed by one agent

Only create sub-transactions if the task is COMPLEX and requires:
- Multiple agents working in parallel
- Coordination between different components
- Clear dependencies between sub-tasks
- Multiple files/modules being modified

If simple, return: {"subTransactions": []}

If complex, break down into sub-transactions (MAXIMUM 10 sub-transactions total). For each sub-transaction, specify:
- Which agent type should handle it (coder, tester, reviewer, or general)
- What specific work needs to be done
- Whether it can run in parallel with others
- What it depends on (if anything)
- What safety checks should run after it completes

CRITICAL: When creating prompts for sub-transactions, ALWAYS include specific file paths. For example:
- Instead of: "Review the code and tests"
- Use: "Review src/txn_demo/cli.py, src/txn_demo/config.py, and tests/test_cli.py for correctness, clarity, and adherence to project standards"

The prompt should tell the agent EXACTLY which files to work with. Include file paths directly in the prompt text.

REPOSITORY STRUCTURE (use these actual paths):
${repoStructure}

IMPORTANT: Only reference files that exist in the repository structure above. Do not invent paths like "src/store/*" or "src/cli.py" unless they are listed above.

Output only valid JSON matching the required structure.`
		}

		// P1 FIX: Track LLM call timing for auditability
		const modelCallStartTime = Date.now()
		const messages = [
			{
				role: "user" as const,
				content: plannerPrompt,
			},
		]

		try {
			// Check and wait for rate limits before making the request
			const provider: string = this.task.apiConfiguration.apiProvider || "unknown"
			const modelId: string = this.task.api.getModel().id || "unknown"
			await waitForRateLimit(provider, modelId)
			
			// Use the task's API handler to call the LLM
			const stream = this.task.api.createMessage(PLANNER_SYSTEM_PROMPT, messages, {
				taskId: this.task.taskId,
			})

			// Consume the stream to get the full response
			let fullText = ""
			for await (const chunk of stream) {
				if (chunk.type === "text") {
					fullText += chunk.text
				} else if (chunk.type === "error") {
					throw new Error(`API error: ${chunk.error} - ${chunk.message}`)
				}
				// Ignore usage, reasoning, and grounding chunks
			}

			// P1 FIX: Log the planner LLM call for auditability and reproducibility
			// This ensures every planner run produces a row in model_call table
			this.task.logModelCall(this.task.api.getModel().id, PLANNER_SYSTEM_PROMPT, messages, modelCallStartTime)

			// Parse JSON - handle cases where LLM wraps it in markdown code blocks
			let jsonText = fullText.trim()
			if (jsonText.startsWith("```")) {
				// Extract JSON from markdown code block
				const match = jsonText.match(/```(?:json)?\n([\s\S]*?)\n```/)
				if (match) {
					jsonText = match[1].trim()
				}
			}

			const plan = JSON.parse(jsonText) as Plan

			// Validate plan structure
			if (!plan.subTransactions || !Array.isArray(plan.subTransactions)) {
				throw new Error("Invalid plan: missing subTransactions array")
			}

			// Validate each sub-transaction
			for (const subTx of plan.subTransactions) {
				if (!subTx.id || !subTx.agentType || !subTx.prompt) {
					throw new Error(`Invalid sub-transaction: missing required fields`)
				}
				if (!["coder", "tester", "reviewer", "general"].includes(subTx.agentType)) {
					throw new Error(`Invalid agentType: ${subTx.agentType}`)
				}
				// Validate step targets are strings (LLM might return arrays/objects)
				if (subTx.steps && Array.isArray(subTx.steps)) {
					for (const step of subTx.steps) {
						if (step.target && typeof step.target !== "string") {
							// Fix: convert array to string if possible
							if (Array.isArray(step.target)) {
								step.target = (step.target as any).join("")
							} else {
								step.target = String(step.target)
							}
						}
					}
				}
			}

			// Check for duplicate IDs
			const ids = new Set<string>()
			for (const subTx of plan.subTransactions) {
				if (ids.has(subTx.id)) {
					throw new Error(`Invalid plan: duplicate sub-transaction ID: ${subTx.id}`)
				}
				ids.add(subTx.id)
			}

			// Validate dependency references
			for (const subTx of plan.subTransactions) {
				if (subTx.dependsOn && subTx.dependsOn.length > 0) {
					for (const depId of subTx.dependsOn) {
						if (!ids.has(depId)) {
							throw new Error(
								`Invalid plan: sub-transaction ${subTx.id} references non-existent dependency: ${depId}`,
							)
						}
					}
				}
			}

			// Validate file paths referenced in the plan
			// This catches LLM hallucinations where it references files that don't exist
			if (plan.subTransactions.length > 0) {
				const fileWarnings = await this.validatePlanFilePaths(plan)
				if (fileWarnings.length > 0) {
					// Log warnings but don't fail - the LLM might still be able to work with search_files
					this.task.providerRef.deref()?.log(
						`[PlannerAgent] Warning: Plan references non-existent files:\n${fileWarnings.join("\n")}`
					)
					// Attach warnings to plan for downstream handling
					;(plan as any).fileValidationWarnings = fileWarnings
				}
			}

			return plan
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const isRateLimit = isRateLimitError(error)
			
			// Record rate limit errors for circuit breaker
			if (isRateLimit) {
				recordRateLimitError()
			}
			
			// Check circuit breaker before retrying
			if (isRateLimit && shouldOpenCircuitBreaker()) {
				this.task.providerRef.deref()?.log(
					`[PlannerAgent] Circuit breaker opened: too many rate limit errors in the last ${RATE_LIMIT_WINDOW_MS / 1000}s. Failing fast.`
				)
				throw new Error(`Failed to generate plan: Rate limit circuit breaker opened. Too many rate limit errors. Please wait before trying again.`)
			}
			
			// Check if it's a rate limit error and we can retry
			if (isRateLimit && retryAttempt < MAX_RETRIES) {
				// Record the rate limit error in the global coordinator (extracts reset time from error)
				const provider: string = this.task.apiConfiguration.apiProvider || "unknown"
				const modelId: string = this.task.api.getModel().id || "unknown"
				await recordRateLimitErrorCoordinator(provider, modelId, error)
				
				// Get the delay from coordinator - it extracts the exact reset time from the error
				const coordinatorDelayMs = await getRateLimitDelay(provider, modelId)
				
				// If coordinator found a reset time, use it exactly (no buffer needed - API told us when to retry)
				if (coordinatorDelayMs > 0) {
					const delaySeconds = Math.ceil(coordinatorDelayMs / 1000)
					this.task.providerRef.deref()?.log(
						`[PlannerAgent] Rate limit error caught (attempt ${retryAttempt + 1}/${MAX_RETRIES}). API says retry after ${delaySeconds}s. Waiting...`
					)
					// Wait for the exact time the API specified
					await waitForRateLimit(provider, modelId)
					return this.generatePlan(userPrompt, retryAttempt + 1, forceComplex)
				}
				
				// Fallback: if coordinator couldn't extract reset time, use exponential backoff
				// This should rarely happen if error messages are properly formatted
				const retryDelay = this.extractRetryDelay(errorMessage)
				let delayMs = retryDelay 
					? Math.ceil(retryDelay * 1000) // Convert seconds to ms
					: Math.min(
						INITIAL_RETRY_DELAY_MS * Math.pow(2, retryAttempt),
						MAX_RETRY_DELAY_MS
					)
				delayMs = Math.max(delayMs, 1000)
				
				this.task.providerRef.deref()?.log(
					`[PlannerAgent] Rate limit error caught (attempt ${retryAttempt + 1}/${MAX_RETRIES}). No reset time found in error, using fallback delay of ${Math.ceil(delayMs / 1000)}s...`
				)
				
				await delay(delayMs)
				return this.generatePlan(userPrompt, retryAttempt + 1, forceComplex)
			}
			
			// Not a rate limit error or max retries reached
			this.task.providerRef.deref()?.log(`[PlannerAgent] Failed to generate plan: ${errorMessage}`)
			throw new Error(`Failed to generate plan: ${errorMessage}`)
		}
	}
}
