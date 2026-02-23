import { ToolArgs } from "./types"

const BASE_PROMPT = `## new_task
Description: Creates a new sub-task for multi-step work that benefits from isolation and checkpointing.

**IMPORTANT: Subtasks need tools to execute work. If you request a mode with no tool groups (like "orchestrator"), the subtask will automatically use "code" mode instead. Modes with tools (like "architect", "debug") will be honored.**

When to use new_task:
- Implementing a complete feature spanning multiple files with its own tests
- Work that should be checkpointed and potentially rolled back independently
- Multi-step implementation work requiring multiple file operations
- Tasks requiring a different mode (e.g., switching to "architect" for planning)

When NOT to use (do the work directly instead):
- Single file operations, running commands/tests, reading/searching files
- Anything accomplishable with 1-3 tool calls
- "Demonstration" or "example" requests

If unsure, do NOT create a subtask - complete the work directly.

Parameters:
- mode: (required) The slug of the mode to start the new task in (e.g., "code", "architect", "debug").
- message: (required) The initial user message or instructions for this new task.`

const TODOS_PARAM = `- todos: (required) The initial todo list in markdown checklist format for the new task.`

const USAGE_WITHOUT_TODOS = `
Usage:
<new_task>
<mode>your-mode-slug-here</mode>
<message>Your initial instructions here</message>
</new_task>

Example:
<new_task>
<mode>code</mode>
<message>Implement the SQLite persistence layer with KVStore interface, CLI integration, and unit tests</message>
</new_task>
`

const USAGE_WITH_TODOS = `
Usage:
<new_task>
<mode>your-mode-slug-here</mode>
<message>Your initial instructions here</message>
<todos>
[ ] First task to complete
[ ] Second task to complete
</todos>
</new_task>

Example:
<new_task>
<mode>code</mode>
<message>Implement user authentication with session management</message>
<todos>
[ ] Set up auth middleware in src/middleware/auth.py
[ ] Create login/logout endpoints in src/routes/auth.py
[ ] Add session management with secure tokens
[ ] Write integration tests in tests/test_auth.py
</todos>
</new_task>
`

export function getNewTaskDescription(args: ToolArgs): string {
	const todosRequired = args.settings?.newTaskRequireTodos === true

	if (todosRequired) {
		return BASE_PROMPT + "\n" + TODOS_PARAM + USAGE_WITH_TODOS
	}
	return BASE_PROMPT + USAGE_WITHOUT_TODOS
}
