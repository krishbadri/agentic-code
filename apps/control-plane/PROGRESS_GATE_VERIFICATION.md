# Progress Gate Verification (Slide 34)

## Specification
"# passing tests is monotonically non-decreasing across commit points."

## Implementation Verification

### 1. Test Command ("Given Tests")

**Location**: `apps/control-plane/src/routes/tx.ts:158-159`
- **Input**: `test_command: z.string().optional()` in `/tx/begin` request body
- **Storage**: Stored in progress baseline (DB or in-memory)
- **Usage**: Executed at each checkpoint via `runTestsAndCount(worktreePath, baseline.test_command)`
- **Code Evidence**:
  ```typescript
  // Line 186-187: Run tests at transaction begin
  const { runTestsAndCount } = await import("../progress-gate.js")
  const result = await runTestsAndCount(worktree_path, body.test_command)
  
  // Line 347-348: Run tests at checkpoint
  const { runTestsAndCount, isProgressValid } = await import("../progress-gate.js")
  const currentResult = await runTestsAndCount(worktreePath, baseline.test_command)
  ```

### 2. Passing Count Computation

**Location**: `apps/control-plane/src/progress-gate.ts:72-118`

**Parser Rules** (in order of precedence):
1. **Jest/Vitest**: `Tests?:\s*(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*total)?`
   - Example: "Tests: 5 passed, 2 failed, 7 total"
2. **Mocha**: `(\d+)\s*passing` and optionally `(\d+)\s*failing`
   - Example: "5 passing" and "2 failing"
3. **pytest**: `(\d+)\s*passed(?:,\s*(\d+)\s*failed)?`
   - Example: "5 passed, 2 failed" or "5 passed"
4. **Node test runner**: `pass\s*(\d+)` and `fail\s*(\d+)`
   - Example: "pass 3" and "fail 2"
5. **TAP format** (fallback): Count `^ok\s+\d+` and `^not ok\s+\d+` lines
   - Example: "ok 1 - test a" and "not ok 2 - test b"
6. **Unknown format** (final fallback): Returns `{ passingCount: 0, failingCount: 0, totalCount: 0 }`

**Deterministic Behavior**:
- Environment variables forced: `FORCE_COLOR: "0"`, `CI: "true"` (line 44-45)
- Parser order is fixed (first match wins)
- Same output always produces same count

**Supported Formats**: Jest/Vitest, Mocha, pytest, Node test runner, TAP

### 3. Checkpoint Rejection on Decrease

**Location**: `apps/control-plane/src/routes/tx.ts:351-376`

**Behavior**:
- Compares `lastPassingCount` (from last checkpoint or baseline) with `currentResult.passingCount`
- If `!isProgressValid(lastPassingCount, currentResult.passingCount)` → returns 403 `PROGRESS_VIOLATION`
- **Code Evidence**:
  ```typescript
  // Line 352: Check monotonicity
  if (!isProgressValid(lastPassingCount, currentResult.passingCount)) {
      // Rollback and return 403
      await git.resetHard(txId, rollbackTarget)
      return reply.code(403).send({
          code: "PROGRESS_VIOLATION",
          message: `Progress gate failed: passing test count decreased from ${lastPassingCount} to ${currentResult.passingCount}`,
          rollback_to: rollbackTarget,
      })
  }
  ```

**Validation Function**: `apps/control-plane/src/progress-gate.ts:123-125`
```typescript
export function isProgressValid(baseline: number, current: number): boolean {
    return current >= baseline
}
```

### 4. Rollback to Last Good Checkpoint SHA

**Location**: `apps/control-plane/src/routes/tx.ts:353-366`

**Rollback Logic**:
1. **Primary**: Use `baseline.last_checkpoint_sha` if available (from last successful checkpoint)
2. **Fallback**: Use `HEAD~1` (previous commit)
3. **Final fallback**: Use `HEAD` (if HEAD~1 doesn't exist - first commit)

**Implementation**:
```typescript
// Line 355-364: Determine rollback target
let rollbackTarget: string
if (baseline.last_checkpoint_sha) {
    rollbackTarget = baseline.last_checkpoint_sha
} else {
    try {
        rollbackTarget = await git.revParse("HEAD~1", worktreePath)
    } catch {
        rollbackTarget = await git.revParse("HEAD", worktreePath)
    }
}

// Line 366: Perform rollback
await git.resetHard(txId, rollbackTarget)
```

**Git Operation**: `apps/control-plane/src/git.ts:31-34`
```typescript
public async resetHard(tx_id: string, targetRef: string): Promise<void> {
    const wt = this.worktreePath(tx_id)
    await this.git(["reset", "--hard", targetRef], wt)
}
```

**Note**: Rollback uses `git reset --hard <SHA>`, not just "abort merge". This resets the worktree to the exact state of the last good checkpoint.

## Test Coverage

### Existing Tests
- ✅ `should record baseline passing count at transaction begin`
- ✅ `should allow checkpoint when passing test count stays same`
- ✅ `should allow checkpoint when passing test count increases`
- ✅ `should block checkpoint when passing test count decreases (R33)`
- ✅ `should rollback to last good checkpoint on progress violation`

### All Tests
- ✅ `should record baseline passing count at transaction begin`
- ✅ `should allow checkpoint when passing test count stays same`
- ✅ `should allow checkpoint when passing test count increases`
- ✅ `should block checkpoint when passing test count decreases (R33)`
- ✅ `should reject ambiguous test output or parse deterministically` - **NEW TEST**
- ✅ `should rollback to last good checkpoint SHA (not just HEAD~1)` - **ENHANCED TEST**

## Test Results

**Progress Gate Tests**: 6/6 passing ✅

**Full Suite**: 53/54 tests passing (1 unrelated failure: git apply --reject test setup issue)

## Summary

✅ **Test Command**: Stored from `/tx/begin` request, executed at each checkpoint  
✅ **Passing Count**: Parsed deterministically using ordered regex patterns (Jest/Vitest → Mocha → pytest → Node → TAP)  
✅ **Checkpoint Rejection**: Returns 403 `PROGRESS_VIOLATION` when count decreases  
✅ **Rollback**: Uses `baseline.last_checkpoint_sha` (or `HEAD~1` fallback), performs `git reset --hard <SHA>`  
✅ **Ambiguous Output**: Parsed deterministically (first match wins - Jest pattern)
