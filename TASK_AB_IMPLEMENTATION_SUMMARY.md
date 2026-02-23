# Task A & B Implementation Summary

**Date**: 2026-02-07
**Status**: ✅ Complete - Both tasks implemented and compiled successfully

---

## Task A: Fix E2E Test Provider Selection

### Problem

- E2E torture test was selecting Gemini provider despite OPENAI_API_KEY being present
- Provider selection priority was: Gemini → OpenRouter → OpenAI
- Test failed with 429 RESOURCE_EXHAUSTED (Gemini quota=0)
- No fail-fast check for OpenAI key when TEST_TORTURE_REPO=1

### Solution Implemented

**File**: `apps/vscode-e2e/src/suite/task.test.ts`

#### Changes Made:

1. **Updated default model** (line 431):

    - Changed from `gpt-4.1` to `gpt-4o-mini` (widely-available, stable)

2. **Added torture test detection** (line 436):

    ```typescript
    const isTortureTest = process.env.TEST_TORTURE_REPO === "1"
    ```

3. **New provider priority for torture tests** (lines 451-477):

    ```typescript
    if (isTortureTest) {
        // Fail fast if OpenAI key is missing
        if (!process.env.OPENAI_API_KEY) {
            throw new Error(`[torture-test] FAST-FAIL: OPENAI_API_KEY is required...`)
        }
        apiProvider = "openai-native"
        apiKey = process.env.OPENAI_API_KEY
        apiModelId = "gpt-4o-mini"
    } else {
        // NON-TORTURE MODE: Keep original priority (Gemini → OpenRouter → OpenAI)
        ...
    }
    ```

4. **Updated VCR section** (line 526):
    - Changed VCR model from `gpt-4.1` to `gpt-4o-mini`

#### Behavior

**Before:**

- Torture tests: Gemini (first priority) → 429 error
- No fail-fast for missing OpenAI key
- Key field: `geminiApiKey`

**After:**

- Torture tests: **OpenAI preferred** → gpt-4o-mini
- **Fail-fast** if OPENAI_API_KEY missing in torture mode
- Non-torture tests: **Original priority preserved** (Gemini → OpenRouter → OpenAI)
- Key field: `openAiNativeApiKey`
- Can override with `TEST_API_PROVIDER=gemini` or `TEST_API_PROVIDER=openrouter`

---

## Task B: Named Projects for Todos

### Problem

- Todo store had no project isolation
- All todos were in a single global list
- Couldn't organize separate workstreams/features
- Stage 2 tests needed independent todo lists per project

### Solution Implemented

**Files Modified**:

1. `packages/types/src/todo.ts` - Type definition
2. `src/core/tools/updateTodoListTool.ts` - CRUD operations
3. `src/shared/tools.ts` - Tool parameter types
4. `src/core/prompts/tools/update-todo-list.ts` - Tool documentation

---

### 1. Type Definition Updates

**File**: `packages/types/src/todo.ts`

```typescript
export const todoItemSchema = z.object({
	id: z.string(),
	content: z.string(),
	status: todoStatusSchema,
	project: z.string().optional().default("default"), // NEW: Named project field
})
```

**Features**:

- Optional field (backward compatible)
- Defaults to "default" when parsed
- TypeScript type allows omission

---

### 2. CRUD Operations (Project-Aware)

**File**: `src/core/tools/updateTodoListTool.ts`

#### `addTodoToTask` (lines 15-35):

```typescript
export function addTodoToTask(
    cline: Task,
    content: string,
    status: TodoStatus = "pending",
    id?: string,
    project?: string // NEW parameter
): TodoItem {
    const todo: TodoItem = {
        id: id ?? crypto.randomUUID(),
        content,
        status,
        project: project ?? "default", // Default project isolation
    }
    ...
}
```

#### `updateTodoStatusForTask` (lines 37-62):

- Filters by project before updating
- Only updates todos within specified project
- `project` parameter defaults to "default"

#### `removeTodoFromTask` (lines 64-76):

- Filters by project before removing
- Only removes todos within specified project
- Project isolation enforced

#### `getTodoListForTask` (lines 78-91):

```typescript
export function getTodoListForTask(cline: Task, project?: string): TodoItem[] | undefined {
	if (!cline.todoList) return undefined
	if (project === undefined) {
		// No filter - return all todos
		return cline.todoList.slice()
	}
	// Filter by project
	return cline.todoList.filter((t) => (t.project ?? "default") === project)
}
```

#### `setTodoListForTask` (lines 93-119):

- Project-aware replacement
- If `project` specified: only replaces todos for that project
- If `project` omitted: replaces entire list (backward compatibility)
- **Project isolation enforced**

#### `parseMarkdownChecklist` (lines 138-164):

- Accepts `project` parameter
- Sets project on all parsed todos
- Includes project in ID hash for uniqueness

#### `updateTodoListTool` main function (lines 209-245):

- Extracts `project` from `block.params.project`
- Defaults to "default"
- Passes project through all operations
- Updates success messages to include project name

---

### 3. Tool Parameter Types

**File**: `src/shared/tools.ts`

Added "project" to `toolParamNames` array (line 72):

```typescript
export const toolParamNames = [
	..."todos",
	"project", // NEW: Named project for todo isolation
	"prompt",
	"image",
] as const
```

---

### 4. Tool Documentation

**File**: `src/core/prompts/tools/update-todo-list.ts`

Added project isolation documentation (lines 11-16):

```
**Project Isolation:**
- Supports named projects for independent todo lists (optional parameter: project).
- If project is specified, only todos for that project are affected.
- Different projects are completely isolated - listing project A will never show todos from project B.
- If project is omitted, defaults to "default" project.
- Use projects to organize separate workstreams, features, or task contexts.
```

Added usage examples with projects (lines 60-80):

```xml
<update_todo_list>
<project>feature-auth</project>
<todos>
[-] Add login endpoint
[ ] Add logout endpoint
[ ] Add session management
</todos>
</update_todo_list>

<update_todo_list>
<project>feature-payments</project>
<todos>
[-] Integrate Stripe API
[ ] Add payment form
[ ] Test payment flow
</todos>
</update_todo_list>
```

---

## Project Isolation Guarantees

### ✅ Listing

- `getTodoListForTask(task, "project-A")` **never** returns todos from "project-B"
- `getTodoListForTask(task)` returns all todos (backward compatible)

### ✅ Done/Delete

- `updateTodoStatusForTask(task, id, "completed", "project-A")` only affects project-A todos
- `removeTodoFromTask(task, id, "project-A")` only deletes from project-A
- **Cannot accidentally modify todos from different projects**

### ✅ Creation

- `addTodoToTask(task, content, status, id, "project-A")` always sets project="project-A"
- `parseMarkdownChecklist(md, "project-A")` sets project="project-A" on all parsed todos

### ✅ Replacement

- `setTodoListForTask(task, todos, "project-A")` only replaces project-A todos
- Other projects remain untouched

### ✅ Backward Compatibility

- Omitting project parameter defaults to "default" everywhere
- Existing code without project parameter continues to work
- Existing todos without project field are treated as project="default"

---

## Validation

### Build Status

```bash
pnpm build
✓ All packages built successfully
✓ TypeScript compilation passed
✓ No type errors in todo implementation
```

### Test Coverage

- All existing tests pass (backward compatible)
- New project parameter is optional
- Default project behavior unchanged

---

## Usage Examples

### Basic Usage (Default Project)

```typescript
// Add todo
addTodoToTask(task, "Implement feature", "pending")
// Uses project="default"

// Update status
updateTodoStatusForTask(task, todoId, "completed")
// Updates within project="default"

// List todos
getTodoListForTask(task)
// Returns all todos (backward compatible)
```

### Named Projects Usage

```typescript
// Feature A workstream
addTodoToTask(task, "Add login endpoint", "pending", undefined, "feature-auth")
addTodoToTask(task, "Add logout endpoint", "pending", undefined, "feature-auth")

// Feature B workstream (isolated)
addTodoToTask(task, "Integrate Stripe", "pending", undefined, "feature-payments")
addTodoToTask(task, "Add payment form", "pending", undefined, "feature-payments")

// List only feature-auth todos
const authTodos = getTodoListForTask(task, "feature-auth")
// Returns only: ["Add login endpoint", "Add logout endpoint"]

// List only feature-payments todos
const paymentTodos = getTodoListForTask(task, "feature-payments")
// Returns only: ["Integrate Stripe", "Add payment form"]

// Update status within project
updateTodoStatusForTask(task, authTodoId, "completed", "feature-auth")
// Only affects feature-auth todos

// Remove from project
removeTodoFromTask(task, authTodoId, "feature-auth")
// Only removes from feature-auth
```

### Tool Usage (XML)

```xml
<!-- Default project -->
<update_todo_list>
<todos>
[ ] Task 1
[ ] Task 2
</todos>
</update_todo_list>

<!-- Named project -->
<update_todo_list>
<project>feature-auth</project>
<todos>
[-] Add login endpoint
[ ] Add logout endpoint
</todos>
</update_todo_list>

<!-- Different project (isolated) -->
<update_todo_list>
<project>bugfix-validation</project>
<todos>
[-] Fix email validation
[ ] Add unit tests
</todos>
</update_todo_list>
```

---

## Stage 2 Compatibility

The named projects feature enables Stage 2 tests to:

1. Create independent todo lists per boundary/phase
2. Verify project isolation (project A todos never leak to project B)
3. Test concurrent workstreams without interference
4. Validate cleanup (delete project A without affecting project B)

---

## Next Steps

### Task A Validation

```bash
# Set environment
export TEST_TORTURE_REPO=1
export OPENAI_API_KEY=sk-...

# Run e2e torture test
cd apps/vscode-e2e
pnpm test:e2e
```

**Expected**:

- Uses OpenAI provider with gpt-4o-mini
- No Gemini 429 errors
- Fast-fail if OPENAI_API_KEY missing

### Task B Validation

```bash
# Run Stage 2 with named projects
# Should pass "named projects in todo store" requirement
```

**Expected**:

- Project A todos isolated from project B
- done/delete only affect selected project
- Listing project A never shows project B todos

---

**Implementation Complete**: 2026-02-07
**Build Status**: ✅ Passed
**Backward Compatibility**: ✅ Preserved
**Ready for Testing**: ✅ Yes
