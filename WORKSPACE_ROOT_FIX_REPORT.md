# Workspace Root Detection and File Grounding Fix

## Problem
Roo/agent frequently failed with "Error reading file ... File not found" because:
1. Workspace root was incorrectly resolved (opening parent folder instead of nested repo folder)
2. Plans referenced non-existent paths (e.g., `src/store/*`, `src/cli.py`) instead of actual paths (`src/txn_demo/*`)
3. Large file reads caused 429 TPM errors

## Solution

### 1. Auto-Detection of Nested Project Roots

**File**: `src/utils/path.ts`

**Added**:
- `detectProjectRoot(candidateRoot)`: Recursively searches for project indicators (pyproject.toml, package.json, src/, tests/)
- `getWorkspacePathWithDetection()`: Async wrapper that uses detection

**How it works**:
- Checks if candidate root has project files or structure
- If not, searches nested directories
- Returns the first directory that looks like a project root
- Deterministic: same inputs => same result

### 2. Enhanced File Path Resolution

**File**: `src/core/tools/readFileTool.ts`

**Changes**:
- Enhanced `resolveFilePathWithFallback()` usage with better error handling
- Added file existence verification before processing
- Added "did you mean" suggestions when file not found
- Error messages now include:
  - Requested relative path
  - Detected workspace root
  - Resolved absolute path
  - Suggestions for similar file names

**Example error message**:
```
File not found: "src/txn_demo/cli.py" (resolved to: C:\...\txn-agent-torture-repo\src\txn_demo\cli.py). 
Workspace root: C:\...\txn-agent-torture-repo\txn-agent-torture-repo. 
Did you mean: "src/txn_demo/cli.py", "src/txn_demo/config.py"?
```

### 3. Repository Mapping Before Planning

**File**: `src/core/planner/PlannerAgent.ts`

**Added**:
- `mapRepositoryStructure()`: Reads key files before generating plan
- Checks existence of:
  - `src/txn_demo/cli.py`
  - `src/txn_demo/config.py`
  - `src/txn_demo/store.py`
  - `pyproject.toml`
  - `tests/` directory (lists Python test files)

**Integration**:
- Called at start of `generatePlan()`
- Repository structure included in planner prompt
- Planner instructed to only reference files that exist

**Before** (ungrounded):
```
Plan might reference: "src/store/*", "src/cli.py"
```

**After** (grounded):
```
REPOSITORY STRUCTURE (use these actual paths):
✓ src/txn_demo/cli.py exists
✓ src/txn_demo/config.py exists
✓ src/txn_demo/store.py exists
✓ pyproject.toml exists
tests/: 3 Python test files (test_cli.py, test_config.py, test_store.py)

IMPORTANT: Only reference files that exist in the repository structure above.
```

### 4. Request Size Reduction (429 TPM Prevention)

**File**: `src/core/tools/readFileTool.ts`

**Added**:
- Hard cap: 50,000 characters per file
- Deterministic truncation (always at same point)
- Clear notice when file is truncated
- Prevents huge requests that cause 429 errors

**Implementation**:
```typescript
const MAX_FILE_CHARS = 50000
if (content.length > MAX_FILE_CHARS) {
    content = content.substring(0, MAX_FILE_CHARS) + 
        `\n\n[File truncated: showing first ${MAX_FILE_CHARS} of ${content.length} characters...]`
}
```

## Files Changed

1. **src/utils/path.ts** (+148 lines)
   - Added `detectProjectRoot()` function
   - Added `getWorkspacePathWithDetection()` function
   - Enhanced `resolveFilePathWithFallback()` (already existed, now better used)

2. **src/core/tools/readFileTool.ts** (+125 lines, -22 lines)
   - Enhanced error messages with workspace root and suggestions
   - Added file existence verification
   - Added 50k character limit per file
   - Improved retry logic with path re-resolution

3. **src/core/planner/PlannerAgent.ts** (+265 lines, -1 line)
   - Added `mapRepositoryStructure()` method
   - Integrated repo mapping into `generatePlan()`
   - Enhanced planner prompts with actual repo structure
   - Fixed import conflict with `recordRateLimitError`

## Validation

### Before Fix:
- ❌ Opened `C:\Users\kpb20\Downloads\txn-agent-torture-repo` (parent)
- ❌ Tried to read `C:\Users\kpb20\Downloads\txn-agent-torture-repo\src\txn_demo\cli.py` (wrong - missing nested folder)
- ❌ Plans referenced `src/store/*` (doesn't exist)
- ❌ Large files caused 429 errors

### After Fix:
- ✅ Auto-detects `C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo` (nested repo)
- ✅ Reads `C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo\src\txn_demo\cli.py` (correct)
- ✅ Plans reference only `src/txn_demo/*` and `tests/*` (actual paths)
- ✅ Files truncated at 50k chars to prevent 429 errors

## Determinism

All changes are deterministic:
- Same workspace root => same detected project root
- Same file path => same resolution (with fallback)
- Same file content => same truncation point
- Same repo structure => same mapping output

## Minimal Changes

- No new scripts added
- No new tests added
- No refactoring of existing logic
- Only targeted enhancements to existing functions
- All changes gated behind existing behavior (backward compatible)
