import { Task } from "../task/Task"
import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"

import cloneDeep from "clone-deep"
import crypto from "crypto"
import { TodoItem, TodoStatus, todoStatusSchema } from "@roo-code/types"
import { getLatestTodo } from "../../shared/todo"

let approvedTodoList: TodoItem[] | undefined = undefined

/**
 * Add a todo item to the task's todoList.
 * @param cline Task instance
 * @param content Todo content
 * @param status Todo status (default: "pending")
 * @param id Optional todo ID
 * @param project Optional project name (default: "default")
 */
export function addTodoToTask(
	cline: Task,
	content: string,
	status: TodoStatus = "pending",
	id?: string,
	project?: string,
): TodoItem {
	const todo: TodoItem = {
		id: id ?? crypto.randomUUID(),
		content,
		status,
		project: project ?? "default", // Default project isolation
	}
	if (!cline.todoList) cline.todoList = []
	cline.todoList.push(todo)
	return todo
}

/**
 * Update the status of a todo item by id (within a specific project).
 * @param cline Task instance
 * @param id Todo ID
 * @param nextStatus New status
 * @param project Optional project name (default: "default")
 */
export function updateTodoStatusForTask(cline: Task, id: string, nextStatus: TodoStatus, project?: string): boolean {
	if (!cline.todoList) return false
	const targetProject = project ?? "default"
	const idx = cline.todoList.findIndex((t) => t.id === id && (t.project ?? "default") === targetProject)
	if (idx === -1) return false
	const current = cline.todoList[idx]
	if (
		(current.status === "pending" && nextStatus === "in_progress") ||
		(current.status === "in_progress" && nextStatus === "completed") ||
		current.status === nextStatus
	) {
		cline.todoList[idx] = { ...current, status: nextStatus }
		return true
	}
	return false
}

/**
 * Remove a todo item by id (within a specific project).
 * @param cline Task instance
 * @param id Todo ID
 * @param project Optional project name (default: "default")
 */
export function removeTodoFromTask(cline: Task, id: string, project?: string): boolean {
	if (!cline.todoList) return false
	const targetProject = project ?? "default"
	const idx = cline.todoList.findIndex((t) => t.id === id && (t.project ?? "default") === targetProject)
	if (idx === -1) return false
	cline.todoList.splice(idx, 1)
	return true
}

/**
 * Get a copy of the todoList (filtered by project if specified).
 * @param cline Task instance
 * @param project Optional project name to filter by (default: returns all todos)
 */
export function getTodoListForTask(cline: Task, project?: string): TodoItem[] | undefined {
	if (!cline.todoList) return undefined
	if (project === undefined) {
		// No filter - return all todos
		return cline.todoList.slice()
	}
	// Filter by project
	return cline.todoList.filter((t) => (t.project ?? "default") === project)
}

/**
 * Set the todoList for the task (project-aware).
 * If project is specified, only replaces todos for that project.
 * If project is omitted, replaces the entire todo list (backward compatibility).
 * @param cline Task instance
 * @param todos New todos to set
 * @param project Optional project name for isolation
 */
export async function setTodoListForTask(cline?: Task, todos?: TodoItem[], project?: string) {
	if (cline === undefined) return

	if (!Array.isArray(todos)) {
		cline.todoList = []
		return
	}

	if (project === undefined) {
		// No project specified - replace entire list (backward compatibility)
		cline.todoList = todos
		return
	}

	// Project specified - only replace todos for that project
	if (!cline.todoList) cline.todoList = []

	// Remove existing todos for this project
	cline.todoList = cline.todoList.filter((t) => (t.project ?? "default") !== project)

	// Add new todos for this project
	cline.todoList.push(...todos)
}

/**
 * Restore the todoList from argument or from clineMessages.
 */
export function restoreTodoListForTask(cline: Task, todoList?: TodoItem[]) {
	if (todoList) {
		cline.todoList = Array.isArray(todoList) ? todoList : []
		return
	}
	cline.todoList = getLatestTodo(cline.clineMessages)
}
/**
 * Convert TodoItem[] to markdown checklist string.
 * @param todos TodoItem array
 * @returns markdown checklist string
 */
function todoListToMarkdown(todos: TodoItem[]): string {
	return todos
		.map((t) => {
			let box = "[ ]"
			if (t.status === "completed") box = "[x]"
			else if (t.status === "in_progress") box = "[-]"
			return `${box} ${t.content}`
		})
		.join("\n")
}

function normalizeStatus(status: string | undefined): TodoStatus {
	if (status === "completed") return "completed"
	if (status === "in_progress") return "in_progress"
	return "pending"
}

export function parseMarkdownChecklist(md: string, project?: string): TodoItem[] {
	if (typeof md !== "string") return []
	const lines = md
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
	const todos: TodoItem[] = []
	const targetProject = project ?? "default"
	for (const line of lines) {
		// Support both "[ ] Task" and "- [ ] Task" formats
		const match = line.match(/^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/)
		if (!match) continue
		let status: TodoStatus = "pending"
		if (match[1] === "x" || match[1] === "X") status = "completed"
		else if (match[1] === "-" || match[1] === "~") status = "in_progress"
		const id = crypto
			.createHash("md5")
			.update(match[2] + status + targetProject) // Include project in hash for uniqueness
			.digest("hex")
		todos.push({
			id,
			content: match[2],
			status,
			project: targetProject,
		})
	}
	return todos
}

export function setPendingTodoList(todos: TodoItem[]) {
	approvedTodoList = todos
}

function validateTodos(todos: any[]): { valid: boolean; error?: string } {
	if (!Array.isArray(todos)) return { valid: false, error: "todos must be an array" }
	for (const [i, t] of todos.entries()) {
		if (!t || typeof t !== "object") return { valid: false, error: `Item ${i + 1} is not an object` }
		if (!t.id || typeof t.id !== "string") return { valid: false, error: `Item ${i + 1} is missing id` }
		if (!t.content || typeof t.content !== "string")
			return { valid: false, error: `Item ${i + 1} is missing content` }
		if (t.status && !todoStatusSchema.options.includes(t.status as TodoStatus))
			return { valid: false, error: `Item ${i + 1} has invalid status` }
		if (t.project && typeof t.project !== "string")
			return { valid: false, error: `Item ${i + 1} has invalid project (must be string)` }
	}
	return { valid: true }
}

/**
 * Update the todo list for a task.
 * @param cline Task instance
 * @param block ToolUse block
 * @param askApproval AskApproval function
 * @param handleError HandleError function
 * @param pushToolResult PushToolResult function
 * @param removeClosingTag RemoveClosingTag function
 * @param userEdited If true, only show "User Edit Succeeded" and do nothing else
 */
export async function updateTodoListTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
	userEdited?: boolean,
) {
	// If userEdited is true, only show "User Edit Succeeded" and do nothing else
	if (userEdited === true) {
		pushToolResult("User Edit Succeeded")
		return
	}
	try {
		const todosRaw = block.params.todos
		const project = block.params.project ?? "default" // Default project for isolation

		let todos: TodoItem[]
		try {
			todos = parseMarkdownChecklist(todosRaw || "", project)
		} catch {
			cline.consecutiveMistakeCount++
			cline.recordToolError("update_todo_list")
			pushToolResult(formatResponse.toolError("The todos parameter is not valid markdown checklist or JSON"))
			return
		}

		const { valid, error } = validateTodos(todos)
		if (!valid && !block.partial) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("update_todo_list")
			pushToolResult(formatResponse.toolError(error || "todos parameter validation failed"))
			return
		}

		let normalizedTodos: TodoItem[] = todos.map((t) => ({
			id: t.id,
			content: t.content,
			status: normalizeStatus(t.status),
			project: t.project ?? project, // Ensure project is set
		}))

		const approvalMsg = JSON.stringify({
			tool: "updateTodoList",
			todos: normalizedTodos,
		})
		if (block.partial) {
			await cline.ask("tool", approvalMsg, block.partial).catch(() => {})
			return
		}
		approvedTodoList = cloneDeep(normalizedTodos)
		const didApprove = await askApproval("tool", approvalMsg)
		if (!didApprove) {
			pushToolResult("User declined to update the todoList.")
			return
		}
		const isTodoListChanged =
			approvedTodoList !== undefined && JSON.stringify(normalizedTodos) !== JSON.stringify(approvedTodoList)
		if (isTodoListChanged) {
			normalizedTodos = approvedTodoList ?? []
			cline.say(
				"user_edit_todos",
				JSON.stringify({
					tool: "updateTodoList",
					todos: normalizedTodos,
				}),
			)
		}

		await setTodoListForTask(cline, normalizedTodos, project)

		// If todo list changed, output new todo list in markdown format
		if (isTodoListChanged) {
			const md = todoListToMarkdown(normalizedTodos)
			pushToolResult(formatResponse.toolResult(`User edits todo (project: ${project}):\n\n` + md))
		} else {
			pushToolResult(formatResponse.toolResult(`Todo list updated successfully (project: ${project}).`))
		}
	} catch (error) {
		await handleError("update todo list", error)
	}
}
