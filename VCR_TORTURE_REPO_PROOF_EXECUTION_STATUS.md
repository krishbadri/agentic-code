# VCR Torture Repo Proof - Execution Status

## Current Status: ⚠️ BLOCKED

**Blocker**: VS Code must be closed to run e2e tests
**Error**: "Running extension tests from the command line is currently only supported if no other instance of Code is running."

## What's Ready ✅

1. **E2E Test Infrastructure**: ✅ Complete
   - Test enabled in `apps/vscode-e2e/src/suite/task.test.ts`
   - Uses OpenAI provider (configured)
   - Reads API key from `OPENAI_API_KEY` env var
   - Test timeout: 10 minutes
   - Workspace: Uses torture repo when `TEST_TORTURE_REPO_WORKSPACE` is set

2. **Torture Repo Setup**: ✅ Complete
   - Git repository initialized
   - Task file exists: `tasks/001_add_sqlite_store.md`
   - Path: `C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo`

3. **VCR Configuration**: ✅ Ready
   - VCR layer integrated at provider boundary
   - All LLM calls route through VCR

## What's Pending ❌

1. **Record Mode Run**: ❌ Cannot execute (VS Code running)
2. **Fixture Verification**: ❌ Pending record mode
3. **Replay Mode Run**: ❌ Pending record mode
4. **First Error Capture**: ❌ Pending record mode
5. **Minimal Fix**: ❌ Pending first error
6. **Determinism Proof**: ❌ Pending all above

## Exact Commands to Run (After Closing VS Code)

### Step 1: Close VS Code
Close all VS Code windows before proceeding.

### Step 2: Record Mode

```powershell
# Set up environment
cd "C:\Users\kpb20\Downloads\Roo-Code"
$vcrDir = "C:\Users\kpb20\AppData\Local\Temp\vcr-torture-95b639d1"
$env:ROO_VCR_MODE = "record"
$env:ROO_VCR_DIR = $vcrDir
$env:TEST_TORTURE_REPO = "1"
$env:TEST_TORTURE_REPO_WORKSPACE = "C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo"
$env:TEST_GREP = "Torture repo"

# Load API key from .env.sample
$env:OPENAI_API_KEY = (Get-Content .env.sample | Select-String -Pattern "OPENAI_API_KEY=" | ForEach-Object { $_.Line -replace "OPENAI_API_KEY=", "" })

# Run test
cd apps/vscode-e2e
pnpm test:run
```

### Step 3: Verify Fixtures

```powershell
# List and count fixtures
$vcrDir = "C:\Users\kpb20\AppData\Local\Temp\vcr-torture-95b639d1"
Get-ChildItem -Path $vcrDir -Recurse -File -Filter "*.json" | Select-Object FullName
$count = (Get-ChildItem -Path $vcrDir -Recurse -File -Filter "*.json").Count
Write-Output "Fixture count: $count"

# Secret scan
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

### Step 4: Replay Mode

```powershell
# Use same $vcrDir from record mode
$vcrDir = "C:\Users\kpb20\AppData\Local\Temp\vcr-torture-95b639d1"
$env:ROO_VCR_MODE = "replay"
$env:ROO_VCR_DIR = $vcrDir
$env:TEST_TORTURE_REPO = "1"
$env:TEST_TORTURE_REPO_WORKSPACE = "C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo"
$env:TEST_GREP = "Torture repo"
$env:OPENAI_API_KEY = (Get-Content .env.sample | Select-String -Pattern "OPENAI_API_KEY=" | ForEach-Object { $_.Line -replace "OPENAI_API_KEY=", "" })

cd apps/vscode-e2e
pnpm test:run
```

## Summary

**Infrastructure**: ✅ 100% Ready
**Execution**: ❌ Blocked on VS Code being open

**Next Action**: Close VS Code, then run the commands above to complete the determinism proof.
