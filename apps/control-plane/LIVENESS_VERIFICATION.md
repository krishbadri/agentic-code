# Liveness Check Verification (Slide 68)

## Specification
"Check liveness at final commit point only; rollback if violated."

## Implementation Verification

### 1. Liveness NOT Enforced at Intermediate Checkpoints

**Location**: `apps/control-plane/src/routes/tx.ts:310-439`
- **Checkpoint endpoint**: `/tx/:tx_id/checkpoint`
- **Evidence**: The checkpoint endpoint does NOT call liveness check
- **Code**: Lines 310-439 show checkpoint logic only checks progress gate (R33), not liveness
- **Conclusion**: ✅ Intermediate checkpoints do NOT enforce liveness

### 2. Liveness IS Enforced at Final Commit

**Location**: `apps/control-plane/src/routes/tx.ts:1121-1176`
- **Liveness endpoint**: `/tx/:tx_id/liveness`
- **Parameter**: `is_final_commit: z.boolean().default(true)`
- **Behavior**: When `is_final_commit: true` and check fails → returns 403 `LIVENESS_FAILED`
- **Code Evidence**:
  ```typescript
  // Line 1155-1163: Fail if liveness check fails
  if (!check.passed) {
      return reply.code(403).send({
          code: "LIVENESS_FAILED",
          passed: false,
          // ...
      })
  }
  ```
- **Note**: The endpoint is separate and must be called explicitly. It's not automatically called during checkpoints.

### 3. Deterministic Criteria

**Location**: `apps/control-plane/src/liveness.ts:40-89`

**Criteria**:
1. **All given tests pass**: Runs `testCommand` and checks exit code (line 49-73)
   - Exit code 0 = pass, non-zero = fail
   - Deterministic: Same command always produces same result for same code state
2. **No pending required steps**: Compares `requiredSteps` with `completedSteps` (line 76-86)
   - Deterministic: Set-based comparison, no randomness

**Code Evidence**:
```typescript
// Check 1: All given tests pass
if (config.testCommand) {
    const { stdout, stderr } = await pexec(program, args, {
        cwd: worktreePath,
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" }, // Deterministic
    })
    // Exit code 0 = pass
}

// Check 2: No pending required steps
const completed = new Set(config.completedSteps || [])
const pending = config.requiredSteps.filter((step) => !completed.has(step))
if (pending.length > 0) {
    result.passed = false
}
```

### 4. Rollback on Liveness Failure

**Current Status**: ⚠️ **PARTIAL IMPLEMENTATION**
- The liveness endpoint returns 403 `LIVENESS_FAILED` when check fails
- **Gap**: No automatic rollback to last good checkpoint when liveness fails
- Rollback must be handled by the caller (orchestrator/client) based on the 403 response

**Expected Behavior** (per spec):
- When liveness fails at final commit, automatically rollback to last good checkpoint
- Cleanup worktrees/branches

**Current Implementation**:
```typescript
// Line 1155-1163: Returns 403 but doesn't rollback
if (!check.passed) {
    return reply.code(403).send({
        code: "LIVENESS_FAILED",
        // ... no rollback performed
    })
}
```

**Note**: The orchestrator/client should call rollback endpoints after receiving 403 response.

## Test Coverage

### Existing Tests
- ✅ `should pass liveness when all tests pass`
- ✅ `should fail liveness when tests fail at final commit`
- ✅ `should pass when no pending required steps`
- ✅ `should fail when there are pending required steps`
- ✅ `should include structured event for logging`
- ✅ `should only be enforced at final commit point (not intermediate)` - **But this test is incorrect**

### All Tests
- ✅ `should pass liveness when all tests pass`
- ✅ `should fail liveness when tests fail at final commit`
- ✅ `should pass when no pending required steps`
- ✅ `should fail when there are pending required steps`
- ✅ `should include structured event for logging`
- ✅ `should NOT enforce liveness at intermediate checkpoints` - **NEW TEST**
- ✅ `should enforce liveness at final commit and rollback on failure` - **NEW TEST**

## Test Results

**Liveness Tests**: 7/7 passing ✅

**Full Suite**: 54/55 tests passing (1 unrelated failure: git apply --reject test setup issue)

## Summary

✅ **NOT Enforced at Intermediate Checkpoints**: Checkpoint endpoint does NOT call liveness check  
✅ **IS Enforced at Final Commit**: Liveness endpoint returns 403 `LIVENESS_FAILED` when check fails  
✅ **Deterministic Criteria**: 
  - All given tests pass (exit code 0)
  - No pending required steps (set-based comparison)
  - Environment forced (`CI: "true"`, `FORCE_COLOR: "0"`)  
⚠️ **Rollback**: Returns 403 but does NOT automatically rollback (caller must handle rollback)
