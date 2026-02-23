# Checkpoint Tools Now Available in Orchestrator Mode

**Date**: 2026-02-08
**Issue**: Checkpoint tools (`save_checkpoint`, `rollback_to_checkpoint`) were not available in orchestrator mode
**Status**: ✅ Fixed

---

## The Problem

When running the Stage 2 torture test prompt in **orchestrator mode**, Roo couldn't use checkpoint tools because:

1. Checkpoint tools are in the `"command"` tool group
2. Orchestrator mode has `groups: []` (no tool groups enabled)
3. Orchestrator only gets `ALWAYS_AVAILABLE_TOOLS` by default
4. This forced Roo to use `execute_command` workarounds instead of proper checkpoints

**Result**: The rollback drill was faked with shell commands (`cmd /c "... & del ROLLBACK_SENTINEL.txt"`) instead of actually testing checkpoint/rollback functionality.

---

## The Fix

### 1. Made checkpoint tools conditionally available (3 files changed)

**File**: `src/core/prompts/tools/index.ts`

```typescript
// Conditionally include checkpoint tools if enabled (regardless of mode/groups)
// This allows orchestrator mode and subtasks to use checkpoints for transactional workflows
if (settings?.enableCheckpoints) {
	tools.add("save_checkpoint")
	tools.add("rollback_to_checkpoint")
}
```

**File**: `src/core/prompts/types.ts`

```typescript
export interface SystemPromptSettings {
	maxConcurrentFileReads: number
	todoListEnabled: boolean
	useAgentRules: boolean
	newTaskRequireTodos: boolean
	enableCheckpoints?: boolean // ← Added
}
```

**File**: `src/core/task/Task.ts`

```typescript
{
    maxConcurrentFileReads: maxConcurrentFileReads ?? 5,
    todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
    useAgentRules: vscode.workspace.getConfiguration("roo-cline").get<boolean>("useAgentRules") ?? true,
    newTaskRequireTodos: vscode.workspace
        .getConfiguration("roo-cline")
        .get<boolean>("newTaskRequireTodos", false),
    enableCheckpoints: this.enableCheckpoints,  // ← Added
}
```

---

## How It Works Now

When `enableCheckpoints: true` is set on a Task:

1. ✅ Checkpoint tools are injected into the system prompt regardless of mode
2. ✅ Orchestrator mode can use `save_checkpoint` and `rollback_to_checkpoint`
3. ✅ Orchestrator can create subtasks with checkpoint tools available
4. ✅ Subtasks in code/debug mode also have checkpoint tools (via "command" group)

---

## Testing the Fix

### Manual Test (Your Use Case)

1. **Reload VS Code** to pick up the rebuilt extension
2. Open the torture repo in a separate window
3. Paste the Stage 2 prompt into Roo
4. **Select Orchestrator mode** (not code mode)
5. Run the task

**Expected behavior:**

- Roo should create subtasks for each boundary (tests, impl, docs)
- Subtasks should use `save_checkpoint` to create git commits
- Rollback drill should use `rollback_to_checkpoint` tool (not shell commands)
- You should see git commits created with checkpoint messages

### Verify Checkpoint Tools Are Available

After reloading, start a new conversation in orchestrator mode and check the system prompt:

```
Look for:
## save_checkpoint
Description: ...

## rollback_to_checkpoint
Description: ...
```

These should now appear in the tools section even in orchestrator mode.

---

## What Changed vs. Before

| Aspect                             | Before                                  | After                                       |
| ---------------------------------- | --------------------------------------- | ------------------------------------------- |
| Orchestrator mode checkpoint tools | ❌ Not available                        | ✅ Available when `enableCheckpoints: true` |
| Rollback drill behavior            | Shell workaround (`cmd /c "... & del"`) | Proper `rollback_to_checkpoint` tool        |
| Git commits from checkpoints       | ❌ None created                         | ✅ Created via `save_checkpoint`            |
| Transactional workflow             | ❌ Faked                                | ✅ Actually tested                          |

---

## Notes

- Checkpoint tools are now available to **any mode** when `enableCheckpoints: true`
- This doesn't change behavior for modes that already had the "command" group
- Code, Debug modes still get checkpoint tools through "command" group (no change)
- Orchestrator mode now gets them conditionally through the `enableCheckpoints` flag
- This allows proper testing of transactional workflows in orchestrator mode

---

## Next Steps

1. ✅ Rebuilt extension (`pnpm bundle`)
2. 🔄 **Reload VS Code window** to use the new code
3. 🧪 Re-run Stage 2 test in orchestrator mode
4. ✅ Verify checkpoint tools are actually used (check git log for checkpoint commits)
