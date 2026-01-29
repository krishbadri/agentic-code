# VCR Torture Repo Execution Guide

## Step 1: Discovery Complete ✅

**Torture Repo**: `C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo\`
**Task File**: `tasks/001_add_sqlite_store.md`
**No automated runner** - manual process via VS Code extension UI

## Step 2: Call Chain Confirmed ✅

**All LLM calls route through VCR-wrapped providers**:
- `src/api/providers/openai.ts:198` → `maybeVcrWrapStream()`
- `src/api/providers/base-openai-compatible-provider.ts:124` → `maybeVcrWrapStream()`
- `src/api/providers/anthropic.ts:166` → `maybeVcrWrapStream()`

**No bypass detected** - all provider calls go through VCR layer.

## Step 3-6: Execution Commands

### Record Mode

```powershell
# 1. Create VCR directory
$vcrDir = (New-TemporaryFile | ForEach-Object { 
    Remove-Item $_; 
    $dir = New-Item -ItemType Directory -Path ($_.DirectoryName + "\vcr-torture-" + [guid]::NewGuid().ToString().Substring(0,8)) -Force; 
    $dir.FullName 
})
Write-Output "VCR Dir: $vcrDir"

# 2. Set environment
$env:ROO_VCR_MODE = "record"
$env:ROO_VCR_DIR = $vcrDir
$env:ROO_VCR_KEEP_FIXTURES = "1"

# 3. Open VS Code with torture repo
code "C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo"

# 4. In Roo Code extension UI, send prompt from tasks/001_add_sqlite_store.md
# (Manual step - copy task file content and paste into extension)

# 5. Wait for task completion or first error

# 6. List fixtures
Get-ChildItem -Path $vcrDir -Recurse -File -Filter "*.json" | Select-Object FullName

# 7. Count fixtures
$count = (Get-ChildItem -Path $vcrDir -Recurse -File -Filter "*.json").Count
Write-Output "Fixture count: $count"
if ($count -eq 0) { Write-Error "FAIL: No fixtures found"; exit 1 }

# 8. Secret scan
$files = Get-ChildItem -Path $vcrDir -Recurse -File -Filter "*.json"
$secretsFound = $false
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw
    $issues = @()
    if ($content -match '(?i)sk-[a-z0-9_-]{20,}') { $issues += "sk-*" }
    if ($content -match '(?i)gsk_[a-z0-9_-]{20,}') { $issues += "gsk_*" }
    if ($content -match '(?i)Bearer\s+[a-z0-9_-]{20,}') { $issues += "Bearer" }
    if ($content -match '(?i)"apiKey"\s*:\s*"[^[REDACTED]]') { $issues += "apiKey" }
    if ($content -match '(?i)"token"\s*:\s*"[^[REDACTED]]') { $issues += "token" }
    if ($content -match '(?i)"authorization"\s*:\s*"[^[REDACTED]]') { $issues += "authorization" }
    if ($issues.Count -gt 0) {
        Write-Error "FAIL: $($f.Name) - $($issues -join ', ')"
        $secretsFound = $true
    } else {
        Write-Output "PASS: $($f.Name)"
    }
}
if ($secretsFound) { Write-Error "SECRET SCAN FAILED"; exit 1 } else { Write-Output "SECRET SCAN PASSED" }
```

### Replay Mode

```powershell
# Use same $vcrDir from record mode
$env:ROO_VCR_MODE = "replay"
$env:ROO_VCR_DIR = $vcrDir  # Same directory from record mode
Remove-Item Env:\ROO_VCR_KEEP_FIXTURES -ErrorAction SilentlyContinue

# Open VS Code and send same prompt
code "C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo"

# In Roo Code extension UI, send same prompt
# Should reproduce exact same first error
```

## Alternative: E2E Test (Automated)

**Test file created**: `apps/vscode-e2e/src/suite/torture-repo-vcr.test.ts`

**To run**:
```powershell
cd apps/vscode-e2e
$env:ROO_VCR_MODE = "record"
$env:ROO_VCR_DIR = "C:\Users\kpb20\AppData\Local\Temp\vcr-torture-<unique-id>"
pnpm test:run --grep "torture-repo-vcr"
```

**Note**: E2E tests require VS Code test runner infrastructure.

## Status

✅ **Step 1**: Discovery complete
✅ **Step 2**: Call chain confirmed (routes through VCR)
⚠️ **Step 3-6**: Requires VS Code extension running (manual or e2e test)

**Recommendation**: Use e2e test infrastructure for automated proof, or follow manual process above.
