import { CodeIndexManager } from "../../../services/code-index/manager"

export function getObjectiveSection(
	codeIndexManager?: CodeIndexManager,
	experimentsConfig?: Record<string, boolean>,
): string {
	const isCodebaseSearchAvailable =
		codeIndexManager &&
		codeIndexManager.isFeatureEnabled &&
		codeIndexManager.isFeatureConfigured &&
		codeIndexManager.isInitialized

	const codebaseSearchInstruction = isCodebaseSearchAvailable
		? "First, use `codebase_search` for any new code area exploration. Then, "
		: "First, "

	return `====

OBJECTIVE

You accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.

1. Analyze the user's task and set clear, achievable goals to accomplish it. Prioritize these goals in a logical order.
2. Work through these goals sequentially, utilizing available tools one at a time as necessary. Each goal should correspond to a distinct step in your problem-solving process. You will be informed on the work completed and what's remaining as you go.
3. Before calling a tool, do some analysis. ${codebaseSearchInstruction}analyze the file structure in environment_details for context. Choose the most relevant tool and verify all required parameters are present or inferable. If a required parameter is missing, use ask_followup_question. Do not ask about optional parameters.
4. Once you've completed the user's task, you must use the attempt_completion tool to present the result of the task to the user.
5. The user may provide feedback, which you can use to make improvements and try again. But DO NOT continue in pointless back and forth conversations, i.e. don't end your responses with questions or offers for further assistance.`
}
