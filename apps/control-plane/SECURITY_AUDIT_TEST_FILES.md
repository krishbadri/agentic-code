# Security Audit: Test File Protection

## All Code Paths That Can Write to Disk

### 1. `POST /tx/:tx_id/write` (File Write Endpoint)
**Location**: `apps/control-plane/src/routes/tx.ts:212`

**Protection**: ✅ **ENFORCED**
- Checks `isTestFile(body.file_path)` before write (line 220)
- Uses `isTestModifyAllowed()` with server-side `app.testModifyAllowlist` (line 220)
- Returns HTTP 403 `TEST_FILE_PROTECTED` if test file and not allowlisted (lines 221-225)
- **No agent-controlled bypass**: Only server config controls allowlist

**Code**:
```typescript
if (isTestFile(body.file_path) && !isTestModifyAllowed(body.file_path, app.testModifyAllowlist)) {
    return reply.code(403).send({
        code: "TEST_FILE_PROTECTED",
        message: `R31/R32 violation: Tests are "given". Writing test file "${body.file_path}" is not allowed.`,
        file_path: body.file_path,
    })
}
```

---

### 2. `POST /tx/:tx_id/apply` (Patch Apply Endpoint)
**Location**: `apps/control-plane/src/routes/tx.ts:186`

**Protection**: ✅ **ENFORCED** (FIXED)
- Checks `isTestFile(body.file_path)` before apply (line 195)
- **FIXED**: Now parses patch content to extract ALL file paths using `extractPatchFilePaths()` (line 192)
- Validates each file path in patch content against test file protection (lines 204-213)
- **Attack vector blocked**: Setting `file_path: "src/safe.ts"` but patch modifying `src/test/file.test.ts` is now rejected

**Code**:
```typescript
// Parse patch to extract ALL file paths
const patchFilePaths = extractPatchFilePaths(body.patch)

// Validate file_path parameter
if (isTestFile(body.file_path) && !isTestModifyAllowed(body.file_path, app.testModifyAllowlist)) {
    return reply.code(403).send({ code: "TEST_FILE_PROTECTED" })
}

// SECURITY: Validate ALL files in patch content (not just file_path parameter)
for (const patchFilePath of patchFilePaths) {
    if (isTestFile(patchFilePath) && !isTestModifyAllowed(patchFilePath, app.testModifyAllowlist)) {
        return reply.code(403).send({ code: "TEST_FILE_PROTECTED", patch_contains_test_file: true })
    }
}
```

**Status**: ✅ **FIXED** - Patch content is now fully validated.

---

### 3. `POST /shell/exec/:tx_id` (Shell Command Execution)
**Location**: `apps/control-plane/src/routes/shell.ts:23`

**Protection**: ⚠️ **PARTIAL - BASIC PROTECTION ADDED**
- Only whitelists command names (node, bash, etc.) (lines 26-43)
- **FIXED**: Added pattern matching to detect test file paths in command arguments (lines 48-66)
- Blocks commands that write to test files using pattern matching (>, >>, echo, cat >, etc.)
- **Limitation**: Pattern-based detection may have false positives/negatives; not as robust as file system monitoring
- **Attack vector partially blocked**: `bash -c "echo 'malicious' > test/file.test.ts"` is now rejected

**Code**:
```typescript
// Check command arguments for test file paths
const fullCommand = [body.cmd, ...body.args].join(" ")
const testFilePatterns = [/test\/.*\.(test|spec)\.(ts|js|tsx|jsx)/i, /__tests__\/.*/i, ...]
for (const pattern of testFilePatterns) {
    if (pattern.test(fullCommand)) {
        const writeOps = />|>>|echo|cat\s+.*\s*>|tee|cp\s+.*\s+test|mv\s+.*\s+test/i
        if (writeOps.test(fullCommand)) {
            return reply.code(403).send({ code: "TEST_FILE_PROTECTED" })
        }
    }
}
```

**Status**: ⚠️ **PARTIALLY FIXED** - Basic pattern-based protection added, but may not catch all edge cases. Full protection would require file system monitoring or sandboxing.

---

### 4. `POST /tx/:tx_id/action-safety` (Action-Safety Check)
**Location**: `apps/control-plane/src/routes/tx.ts:1008`

**Protection**: ✅ **ENFORCED** (if called before execution)
- Checks file writes against `protectedPaths` (includes test patterns) (line 1024)
- Test files are in `DEFAULT_CONFIG.protectedPaths` (action-safety.ts:48-55)
- **BUT**: This endpoint is advisory only - it's not automatically called before writes
- **Gap**: Production code doesn't call this before `/write` or `/apply`

**Code**:
```typescript
const check = checkActionSafety(body.action, body.args)
// Returns { allowed: false } for test file writes
// But this is only called if agent explicitly requests it
```

---

## Summary of Protection Status

| Write Path | Test File Protection | Bypass Risk | Status |
|------------|---------------------|-------------|--------|
| `/tx/:tx_id/write` | ✅ Enforced | None | Secure |
| `/tx/:tx_id/apply` | ✅ Enforced | None | **FIXED** - Patch content validated |
| `/shell/exec/:tx_id` | ⚠️ Partial | Pattern-based (may have edge cases) | **PARTIALLY FIXED** |
| Action-safety endpoint | ✅ Enforced | None | Secure (but not auto-called) |

---

## Critical Vulnerabilities

### V1: Patch Content Bypass
**Severity**: HIGH
**Status**: ✅ **FIXED**
**Vector**: `/tx/:tx_id/apply` endpoint
**Attack**: 
```json
{
  "file_path": "src/safe.ts",  // Non-test file
  "patch": "--- a/src/test/file.test.ts\n+++ b/src/test/file.test.ts\n@@ -1,1 +1,2 @@\n+malicious"
}
```
**Impact**: Agent can modify test files by setting `file_path` to non-test file but including test file in patch content.
**Fix**: Added `extractPatchFilePaths()` to parse patch content and validate all file paths.

### V2: Shell Exec Bypass
**Severity**: HIGH  
**Status**: ⚠️ **PARTIALLY FIXED**
**Vector**: `/shell/exec/:tx_id` endpoint
**Attack**:
```json
{
  "cmd": "bash",
  "args": ["-c", "echo 'malicious' > test/file.test.ts"]
}
```
**Impact**: Agent can write to test files via shell commands, bypassing all file write protections.
**Fix**: Added pattern-based detection for test file paths in command arguments. **Limitation**: May not catch all edge cases (e.g., complex shell scripts, variable expansion).

---

## Implementation Status

1. ✅ **Parse patch content** in `/apply` endpoint to extract all file paths and validate each - **DONE**
2. ⚠️ **Add action-safety check** before shell exec - **PARTIALLY DONE** (pattern-based, not comprehensive)
3. ✅ **Add acceptance tests** proving both vulnerabilities are blocked - **DONE**
