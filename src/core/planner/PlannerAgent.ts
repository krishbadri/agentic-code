import type { Plan } from "./types"
import { PLANNER_SYSTEM_PROMPT } from "./prompts"
import type { Task } from "../task/Task"

export class PlannerAgent {
	constructor(private task: Task) {}

	async generatePlan(userPrompt: string): Promise<Plan> {
		const plannerPrompt = `Analyze this coding task and create a structured execution plan.

Task: ${userPrompt}

Break down the task into sub-transactions. Identify what can run in parallel and what must be sequential.
For each sub-transaction, specify:
- Which agent type should handle it (coder, tester, reviewer, or general)
- What specific work needs to be done
- Whether it can run in parallel with others
- What it depends on (if anything)
- What safety checks should run after it completes

Output only valid JSON matching the required structure.`

		// P1 FIX: Track LLM call timing for auditability
		const modelCallStartTime = Date.now()
		const messages = [
			{
				role: "user" as const,
				content: plannerPrompt,
			},
		]

		try {
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

			return plan
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.task.providerRef.deref()?.log(`[PlannerAgent] Failed to generate plan: ${errorMessage}`)
			throw new Error(`Failed to generate plan: ${errorMessage}`)
		}
	}
}
