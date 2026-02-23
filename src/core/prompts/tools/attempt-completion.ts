import { ToolArgs } from "./types"

export function getAttemptCompletionDescription(args?: ToolArgs): string {
	return `## attempt_completion
Description: Present the result of your work to the user once the task is complete. The user may respond with feedback for improvements.
IMPORTANT: Do NOT use this tool until you've confirmed all previous tool uses were successful.
Parameters:
- result: (required) The result of the task. Formulate this result in a way that is final and does not require further input from the user. Don't end your result with questions or offers for further assistance.
Usage:
<attempt_completion>
<result>
Your final result description here
</result>
</attempt_completion>

Example: Requesting to attempt completion with a result
<attempt_completion>
<result>
I've updated the CSS
</result>
</attempt_completion>`
}
