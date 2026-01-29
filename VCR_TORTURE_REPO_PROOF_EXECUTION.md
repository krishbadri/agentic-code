# VCR Torture Repo Proof - Execution Report

## Step 1: Discover Torture Repo Runner ✅

### Directory Listing
**Command**: `Get-ChildItem -File` in `C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo\`
**Result**: No top-level files (only directories: `.github`, `patches`, `scenarios`, `src`, `tasks`, `tests`)

### Package Configuration
**Command**: Checked for `package.json` and `pyproject.toml`
**Result**:
- ❌ No `package.json` (not a Node.js project)
- ✅ `pyproject.toml` exists (Python project with pytest as dev dependency)

### Search Results
**Command**: Searched for task/scenario references
**Findings**:
- `tasks/001_add_sqlite_store.md` ✅ - Task file exists
- `src/txn_demo/store.py:36` - `build_store("sqlite")` raises `NotImplementedError`
- `README.md` - States manual process: "Spawn one agent transaction per task" via VS Code

### Canonical Command
**Result**: ❌ **NO PER-TASK RUNNER FOUND**

The torture repo README states:
> "How to use this repo to test your system:
> 1. Pick a scenario in `scenarios/` (e.g., `structural_same_file.json`).
> 2. Spawn one "agent transaction" per task (`tasks/*.md`).
> 3. Have each agent implement its task on its own branch/worktree.
> 4. Merge results into `main` using your transaction/merge logic.
> 5. Gate on `pytest -q` and (optionally) `ruff check .`."

**Narrowest "run loop" command**: 
- The torture repo has **no automated runner**
- It's designed for **manual use via VS Code extension UI**
- Process: Open VS Code → Send prompt via Roo Code extension → VCR intercepts LLM calls

**To automate**: Use existing e2e test infrastructure pattern (like `apps/vscode-e2e/src/suite/task.test.ts`)

## Step 2: Call Chain Confirmation ✅

### LLM Call Flow (Torture Repo → VCR-Wrapped Providers)

**1. Extension API** (`src/extension/api.ts:142`):
```typescript
const task = await provider.createTask(text, images, undefined, options, configuration)
```
- Entry point for sending prompts (via UI or e2e test)

**2. Task → API Handler** (`src/core/task/Task.ts:3649`):
```typescript
const stream = this.api.createMessage(systemPrompt, cleanConversationHistory, metadata)
```
- `this.api` is `ApiHandler` from `src/api/index.ts:90`

**3. VCR Interception Points** ✅ **CONFIRMED**:
- `src/api/providers/openai.ts:198` → `maybeVcrWrapStream()`
- `src/api/providers/base-openai-compatible-provider.ts:124` → `maybeVcrWrapStream()`
- `src/api/providers/anthropic.ts:166` → `maybeVcrWrapStream()`

**✅ CONFIRMED**: All LLM calls route through VCR-wrapped provider codepaths. **No bypass detected**.

## Step 3-6: Execution Plan

### Infrastructure Created (Verification-Only)

**Modified**: `apps/vscode-e2e/src/suite/task.test.ts`
- Added verification-only test (skipped by default, gated by `TEST_TORTURE_REPO` env var)
- Uses existing e2e test pattern
- Reads torture repo task prompt and runs it via extension API

### Execution Commands

**Record Mode**:
```powershell
cd apps/vscode-e2e
$vcrDir = "C:\Users\kpb20\AppData\Local\Temp\vcr-torture-<unique-id>"
$env:ROO_VCR_MODE = "record"
$env:ROO_VCR_DIR = $vcrDir
$env:TEST_TORTURE_REPO = "1"  # Enable torture repo test
$env:TEST_GREP = "Torture repo"
pnpm test:run
```

**Replay Mode** (same `$vcrDir`):
```powershell
$env:ROO_VCR_MODE = "replay"
$env:ROO_VCR_DIR = $vcrDir  # Same directory
pnpm test:run
```

**Note**: E2E tests require VS Code test infrastructure (downloads VS Code, runs extension in test mode).

## Status

✅ **Step 1**: Discovery complete - No automated runner, use e2e test infrastructure
✅ **Step 2**: Call chain confirmed (routes through VCR)
⚠️ **Step 3-6**: Requires VS Code test infrastructure to execute

**Verification-only changes**:
- Modified `apps/vscode-e2e/src/suite/task.test.ts` (added skipped test gated by env var)
- No new e2e test files created
- Uses existing e2e test pattern
