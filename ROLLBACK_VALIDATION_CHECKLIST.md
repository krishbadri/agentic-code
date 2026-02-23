# Rollback Drill Validation Checklist

**Purpose**: Verify P0 fixes enable Stage 2 rollback drill to complete successfully
**Date**: 2026-02-07

---

## Pre-Validation Setup

### 1. Build the extension

```bash
cd /c/Users/kpb20/Downloads/Roo-Code
pnpm install
pnpm build
pnpm vsix
```

### 2. Install the VSIX

```bash
code --install-extension bin/agentic-cline-*.vsix
```

### 3. Configure settings

- Enable checkpoints: `roo.experimental.checkpointsEnabled: true`
- Set API key for LLM provider

### 4. Start Control-Plane (if using transactional mode)

```bash
cd apps/control-plane
pnpm start
```

---

## Validation Scenario: Boundary 1 + Rollback Drill

### Phase 1: Boundary 1 (tests-first)

**Expected behavior:**

1. ✅ Agent adds new project-isolation tests
2. ✅ Tests fail for expected reason (missing wiring / unexpected keyword args)
3. ✅ Agent creates checkpoint named C1_tests

**Verification:**

- [ ] Tests were added
- [ ] Tests failed with expected error
- [ ] Checkpoint C1_tests exists
- [ ] Git log shows checkpoint commit

```bash
# Check checkpoint exists
git log --oneline | grep -i c1_tests
```

---

### Phase 2: Rollback Drill

**Expected behavior:**

1. ✅ Agent creates ROLLBACK_SENTINEL.txt
2. ✅ Agent injects intentional bad code change
3. ✅ Agent runs tests → tests fail
4. ✅ Agent calls `rollback_to_checkpoint` tool (NOT manual git)
5. ✅ Tool executes successfully
6. ✅ Verification confirms ROLLBACK_SENTINEL.txt removed
7. ✅ Verification confirms HEAD at C1_tests
8. ✅ Agent receives success message with verification results
9. ✅ Execution continues cleanly

**Verification checklist:**

#### A. Sentinel file creation

- [ ] ROLLBACK_SENTINEL.txt was created

```bash
# After step 1, verify file exists
ls ROLLBACK_SENTINEL.txt
```

#### B. Bad code injection

- [ ] Intentional bad code was added
- [ ] Tests failed as expected

#### C. Tool invocation (CRITICAL)

- [ ] Agent used `<rollback_to_checkpoint>` tool
- [ ] Agent did NOT use `git reset`, `git restore`, `git checkout <hash>`, etc.
- [ ] Check logs for: `[rollback_to_checkpoint to 'C1_tests']` or similar

#### D. Tool execution (NEW - P0 fix #1)

- [ ] Tool was NOT silently ignored
- [ ] Tool execution log entry exists
- [ ] No "Tool ... is not implemented" error

```bash
# Check extension logs for tool execution
# Look for: "[presentAssistantMessage] Tool call detected - Name: rollback_to_checkpoint"
```

#### E. Rollback verification (NEW - P0 fix #3)

- [ ] HEAD is at correct commit (C1_tests)

```bash
git log -1 --oneline
# Should match C1_tests checkpoint
```

- [ ] ROLLBACK_SENTINEL.txt is GONE

```bash
ls ROLLBACK_SENTINEL.txt
# Should return: No such file or directory
```

- [ ] Working tree is clean

```bash
git status
# Should show: nothing to commit, working tree clean
```

- [ ] Verification log entry exists

```bash
# Check extension logs for:
# "[RollbackVerification] ✓ HEAD at ..., ✓ ROLLBACK_SENTINEL.txt removed, ✓ Working tree status: ..."
```

#### F. Agent feedback (NEW - P0 fix #4)

- [ ] Agent received success message with verification results
- [ ] Message includes: "✓ Rollback completed successfully"
- [ ] Message includes: "ROLLBACK_SENTINEL.txt has been removed"
- [ ] Message includes: "Repository state matches checkpoint"

#### G. Execution stability (Original failure mode)

- [ ] NO "request too large" errors
- [ ] NO context explosion
- [ ] NO retry loops
- [ ] NO mode confusion (orchestrator ↔ code mode)
- [ ] Execution completed cleanly within reasonable time

---

## Forbidden Command Detection (P0 fix #5)

**Test**: Try to execute a forbidden git command when checkpoints are enabled

**Steps:**

1. Ensure checkpoints are enabled
2. Try to execute: `git reset --hard HEAD~1`

**Expected behavior:**

- [ ] Command is BLOCKED before execution
- [ ] Error message: "FORBIDDEN: Manual git rollback commands are not allowed when checkpoints are enabled"
- [ ] Error message suggests using `rollback_to_checkpoint` tool
- [ ] consecutiveMistakeCount incremented

---

## Default Tool Case (P0 fix #2)

**Test**: Try to call a non-existent tool

**Steps:**

1. Modify a test to call `<nonexistent_tool><param>test</param></nonexistent_tool>`

**Expected behavior:**

- [ ] Tool call is NOT silently ignored
- [ ] Explicit error returned: "Tool 'nonexistent_tool' is not implemented or not available in this context"
- [ ] consecutiveMistakeCount incremented
- [ ] Agent receives feedback about the error

---

## Success Criteria

### ✅ Pass: All of the following are true

1. Boundary 1 completed successfully
2. Rollback drill completed successfully
3. `rollback_to_checkpoint` tool was used (not manual git)
4. Tool executed (not silently ignored)
5. Verification passed (sentinel removed, HEAD correct)
6. Agent received verification feedback
7. Execution completed cleanly (no context explosion, no retry loops)
8. Forbidden git commands are blocked

### ❌ Fail: Any of the following are true

1. Tool call was silently ignored
2. Manual git commands were used for rollback
3. ROLLBACK_SENTINEL.txt still exists after rollback
4. Context explosion / "request too large" errors
5. Retry loops / execution stuck
6. Forbidden git commands were executed

---

## Evidence Collection

For successful validation, collect:

1. **Extension logs** showing:

    - Tool call detected: `rollback_to_checkpoint`
    - Tool executed successfully
    - Verification passed with specific checks

2. **Git log** showing:

    - Checkpoint C1_tests commit
    - HEAD at C1_tests after rollback

3. **File system state**:

    - ROLLBACK_SENTINEL.txt absent after rollback
    - Working tree clean

4. **Conversation history** showing:

    - Agent used `<rollback_to_checkpoint>` tool
    - Agent received verification success message
    - No manual git command attempts

5. **Screenshots/recordings** (optional but helpful):
    - Tool execution in UI
    - Verification success message
    - Clean completion

---

## Troubleshooting

### If tool is still silently ignored:

- Check: Is the case statement present in `presentAssistantMessage.ts`?
- Check: Is the default case present and returning an error?
- Check: Are there any TypeScript compilation errors?

### If verification fails:

- Check: Is `verifyRollbackState()` being called after rollback?
- Check: Are there any exceptions thrown during verification?
- Check: Is ROLLBACK_SENTINEL.txt in the correct location (workspace root)?

### If forbidden commands are not blocked:

- Check: Is `task.enableCheckpoints` true?
- Check: Are the forbidden pattern regexes correct?
- Check: Is the guard before the command execution?

---

## Post-Validation

### If validation PASSES:

1. Document evidence in a validation report
2. Commit changes with message: "P0 fixes: Rollback mechanism now reliable"
3. Proceed to Boundary 2 testing

### If validation FAILS:

1. Document failure mode in detail
2. Compare to original Stage 2 failure
3. Determine if additional P0 fixes needed
4. DO NOT proceed to Boundary 2 until rollback drill passes

---

**Validation performed by**: [Name]
**Date**: [Date]
**Result**: [ ] PASS / [ ] FAIL
**Notes**: [Add notes here]
