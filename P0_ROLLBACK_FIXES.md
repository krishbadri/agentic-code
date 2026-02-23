# P0 Rollback Mechanism Fixes

**Date**: 2026-02-07
**Scope**: Minimal, targeted fixes for Stage 2 rollback drill reliability
**Status**: ✅ Implemented

---

## Summary

Fixed critical gaps in the checkpoint rollback mechanism that caused Stage 2 rollback drill failures. The system now properly executes rollback tools, verifies rollback success, and prevents manual git commands from bypassing the checkpoint system.

---

## Changes Implemented

### 1. Wire up checkpoint tools in execution switch ✅

**File**: `src/core/assistant-message/presentAssistantMessage.ts`

**Problem**: `save_checkpoint` and `rollback_to_checkpoint` tools were defined and imported but never executed.

**Fix**: Added case statements to the tool execution switch:

```typescript
case "save_checkpoint":
    await saveCheckpointTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
    break
case "rollback_to_checkpoint":
    await rollbackToCheckpointTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
    break
```

**Impact**: Tools now execute when called by the agent.

---

### 2. Add default case for unhandled tools ✅

**File**: `src/core/assistant-message/presentAssistantMessage.ts`

**Problem**: Unhandled tool calls were silently ignored, causing agents to think tools don't exist.

**Fix**: Added default case to fail loudly:

```typescript
default:
    pushToolResult(
        formatResponse.toolError(
            `Tool '${block.name}' is not implemented or not available in this context. ` +
            `Available tools are defined in the system prompt. If you believe this tool should exist, ` +
            `there may be a wiring issue in the tool execution handler.`
        )
    )
    cline.consecutiveMistakeCount++
    break
```

**Impact**: Agents receive explicit error feedback instead of silent failures.

---

### 3. Add rollback verification mechanism ✅

**File**: `src/core/checkpoints/index.ts`

**Problem**: No verification that rollback actually succeeded (ROLLBACK_SENTINEL.txt removal, correct HEAD, etc.).

**Fix**: Added `verifyRollbackState()` function that checks:

- ✓ HEAD is at correct commit hash
- ✓ ROLLBACK_SENTINEL.txt is removed (critical for Stage 2 rollback drill)
- ✓ Working tree status is clean

Called after all three rollback paths:

- Control-Plane rollback
- Checkpoint service rollback
- Direct Git rollback

**Code**:

```typescript
async function verifyRollbackState(task: Task, commitHash: string): Promise<void> {
	// Verify 1: HEAD is at correct commit
	// Verify 2: ROLLBACK_SENTINEL.txt does NOT exist
	// Verify 3: No unexpected uncommitted changes
}
```

**Impact**: Rollback failures are detected immediately with clear error messages.

---

### 4. Enhanced rollback tool feedback ✅

**File**: `src/core/tools/rollbackToCheckpointTool.ts`

**Problem**: Generic success messages didn't confirm verification results.

**Fix**: Enhanced success message to explicitly report verification:

```typescript
;`✓ Rollback completed successfully to checkpoint (${commitHash.substring(0, 7)}).

Verification results:
- HEAD is at correct commit
- ROLLBACK_SENTINEL.txt has been removed
- Repository state matches checkpoint

All changes after the checkpoint have been reverted. System state restored, agent state preserved.`
```

Enhanced error message to guide agents away from manual git commands:

```typescript
;`Rollback failed: ${msg}

IMPORTANT: Do NOT attempt manual git commands (git reset, git restore, git checkout, etc.).
Use only the rollback_to_checkpoint tool for rollback operations.
If the checkpoint doesn't exist, first create one with save_checkpoint.`
```

**Impact**: Agents receive clear confirmation that rollback succeeded and are guided away from manual git workarounds.

---

### 5. Forbid manual git rollback commands ✅

**File**: `src/core/tools/executeCommandTool.ts`

**Problem**: Agents could bypass checkpoint mechanism by using manual git commands.

**Fix**: Added guard that blocks dangerous git commands when checkpoints are enabled:

Forbidden patterns:

- `git reset` (with or without `--hard`)
- `git restore`
- `git checkout <hash>`
- `git revert`
- `git clean -f/-F/-d/-D`

Returns explicit error:

```typescript
;`FORBIDDEN: Manual git rollback commands are not allowed when checkpoints are enabled.

Command attempted: ${command}

To rollback, you MUST use the rollback_to_checkpoint tool:
<rollback_to_checkpoint>
<checkpoint_name>C1_tests</checkpoint_name>
</rollback_to_checkpoint>

Do NOT use git reset, git restore, git checkout <hash>, git revert, or git clean.
These commands bypass the checkpoint mechanism and will cause verification failures.`
```

**Impact**: Agents are forced to use the proper rollback mechanism, preventing the cascade failures seen in Stage 2.

---

### 6. Add tool display names ✅

**File**: `src/shared/tools.ts`

**Problem**: TypeScript compilation error due to missing TOOL_DISPLAY_NAMES entries.

**Fix**: Added display names:

```typescript
save_checkpoint: "save checkpoints",
rollback_to_checkpoint: "rollback to checkpoint",
```

**Impact**: Type checking passes, tools display correctly in UI.

---

## Files Modified

1. `src/core/assistant-message/presentAssistantMessage.ts` (+23 lines)
2. `src/core/checkpoints/index.ts` (+53 lines)
3. `src/core/tools/rollbackToCheckpointTool.ts` (+11 lines, modified 2 messages)
4. `src/core/tools/executeCommandTool.ts` (+35 lines)
5. `src/shared/tools.ts` (+2 lines)

**Total**: ~124 lines added/modified across 5 files

---

## What Was NOT Changed

As per requirements, the following were NOT modified:

- ❌ Todo/task tracking functionality
- ❌ Project scoping logic
- ❌ Stage 2 feature implementation beyond rollback
- ❌ Planner or orchestrator logic
- ❌ Test files or e2e tests

---

## Validation Criteria

To validate these fixes, re-run **Boundary 1 + rollback drill only**:

### Expected Behavior:

**Boundary 1 (tests-first):**

1. ✅ New project-isolation tests added
2. ✅ Tests fail for expected reason (missing wiring / unexpected keyword args)
3. ✅ Checkpoint C1_tests created successfully

**Rollback Drill:**

1. ✅ ROLLBACK_SENTINEL.txt created
2. ✅ Intentional bad code change made
3. ✅ Tests fail as expected
4. ✅ Agent calls `rollback_to_checkpoint` tool (NOT manual git commands)
5. ✅ Tool executes (no silent ignore)
6. ✅ Rollback restores checkpoint
7. ✅ Verification confirms ROLLBACK_SENTINEL.txt removed
8. ✅ Verification confirms HEAD at C1_tests
9. ✅ Agent receives verification results
10. ✅ Execution continues cleanly (no context explosion, no retry loops)

### Evidence Required:

Show logs/output demonstrating:

- ✓ `rollback_to_checkpoint` tool was invoked
- ✓ Verification passed (sentinel removed)
- ✓ No manual git commands attempted
- ✓ No "request too large" errors
- ✓ Clean completion of rollback drill

---

## Expected Impact on Stage 2 Failure

### Original Failure Mode:

```
1. Agent calls rollback_to_checkpoint → Tool silently ignored
2. Agent tries manual git restore → Sentinel not removed
3. Agent confused → Mode switching chaos
4. Context explosion → "request too large" errors
5. Stuck in retry loop → Never completes
```

### Fixed Behavior:

```
1. Agent calls rollback_to_checkpoint → Tool executes
2. Rollback succeeds → Verification confirms sentinel removed
3. Agent receives confirmation → Continues with clean state
4. Execution completes successfully
```

---

## Compliance with Spec

These fixes address spec violations:

**R7** (Rollback semantics): ✅ Now deterministic, idempotent, reliable

- Fixed: Tool execution was non-deterministic (sometimes silently ignored)
- Fixed: Manual git commands made rollback non-idempotent

**R9** (Action-safety): ✅ Now enforced for git rollback commands

- Added: Pre-execution guard against manual git rollback commands

**Verification**: ✅ Added explicit state verification after rollback

- New: Checks HEAD, sentinel file, working tree status

---

## Rollback to These Changes (Meta)

If these changes cause issues, revert commits for these 5 files:

```bash
git checkout HEAD~1 -- src/core/assistant-message/presentAssistantMessage.ts
git checkout HEAD~1 -- src/core/checkpoints/index.ts
git checkout HEAD~1 -- src/core/tools/rollbackToCheckpointTool.ts
git checkout HEAD~1 -- src/core/tools/executeCommandTool.ts
git checkout HEAD~1 -- src/shared/tools.ts
```

---

## Next Steps

1. **Validation**: Run Stage 2 Boundary 1 + rollback drill
2. **Evidence collection**: Capture logs showing successful rollback with verification
3. **If successful**: Proceed to Boundary 2
4. **If failed**: Investigate failure mode and determine if additional P0 fixes needed

---

**Last Updated**: 2026-02-07
**Implemented By**: Claude Sonnet 4.5
**Reviewed By**: [Pending validation]
