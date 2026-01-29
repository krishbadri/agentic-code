# VCR Verification Commands

## Command Sequence 1: Record Tests + List Fixtures

```powershell
# Set up temp directory and run record tests
cd "c:\Users\kpb20\Downloads\Roo-Code\src"
$tempDir = (New-TemporaryFile | ForEach-Object { Remove-Item $_; $dir = New-Item -ItemType Directory -Path ($_.DirectoryName + "\vcr-record-" + [guid]::NewGuid().ToString().Substring(0,8)) -Force; $dir.FullName })
$env:ROO_VCR_MODE="record"
$env:ROO_VCR_DIR=$tempDir
Write-Output "=== Running record tests ==="
pnpm test api/vcr
Write-Output "`n=== Listing fixtures ==="
if (Test-Path $tempDir) {
    $files = Get-ChildItem -Path $tempDir -Recurse -File -Filter "*.json"
    if ($files.Count -eq 0) {
        Write-Output "  ❌ No fixtures found"
        exit 1
    } else {
        Write-Output "  ✓ Found $($files.Count) fixture(s):"
        foreach ($f in $files) {
            Write-Output "    $($f.FullName)"
        }
    }
} else {
    Write-Output "  ❌ Fixture directory not found"
    exit 1
}
Write-Output "`n=== Temp directory (for replay): $tempDir ==="
```

## Command Sequence 2: Replay Tests + Scan Fixtures for Secrets

```powershell
# Set temp directory (use value from Sequence 1)
cd "c:\Users\kpb20\Downloads\Roo-Code\src"
$tempDir = "<PASTE_TEMP_DIR_FROM_SEQUENCE_1>"
$env:ROO_VCR_MODE="replay"
$env:ROO_VCR_DIR=$tempDir
Write-Output "=== Running replay tests ==="
pnpm test api/vcr
Write-Output "`n=== Scanning fixtures for secrets ==="
if (Test-Path $tempDir) {
    $files = Get-ChildItem -Path $tempDir -Recurse -File -Filter "*.json"
    $secretsFound = $false
    foreach ($f in $files) {
        Write-Output "  Checking: $($f.Name)"
        $content = Get-Content $f.FullName -Raw
        $issues = @()
        
        # Check for sk- pattern (not [REDACTED])
        if ($content -match '(?i)"sk-[a-z0-9_-]{20,}"') {
            $issues += "sk-* pattern found"
        }
        
        # Check for gsk_ pattern (not [REDACTED])
        if ($content -match '(?i)"gsk_[a-z0-9_-]{20,}"') {
            $issues += "gsk_* pattern found"
        }
        
        # Check for Bearer token (not [REDACTED])
        if ($content -match '(?i)"Bearer\s+[a-z0-9_-]{20,}"') {
            $issues += "Bearer token found"
        }
        
        # Check for apiKey not redacted
        if ($content -match '(?i)"apiKey"\s*:\s*"[^[REDACTED]]') {
            $issues += "apiKey not redacted"
        }
        
        # Check for token not redacted
        if ($content -match '(?i)"token"\s*:\s*"[^[REDACTED]]') {
            $issues += "token not redacted"
        }
        
        # Check for authorization not redacted
        if ($content -match '(?i)"authorization"\s*:\s*"[^[REDACTED]]') {
            $issues += "authorization not redacted"
        }
        
        if ($issues.Count -gt 0) {
            Write-Output "    ❌ SECRETS FOUND: $($issues -join ', ')"
            $secretsFound = $true
        } else {
            Write-Output "    ✓ No secrets detected"
        }
    }
    
    if ($secretsFound) {
        Write-Output "`n❌ VERIFICATION FAILED: Secrets found in fixtures"
        exit 1
    } else {
        Write-Output "`n✓ VERIFICATION PASSED: No secrets in fixtures"
    }
} else {
    Write-Output "  ❌ Fixture directory not found"
    exit 1
}
```

## Alternative: Single Combined Command

```powershell
# Record + List + Replay + Scan (all in one)
cd "c:\Users\kpb20\Downloads\Roo-Code\src"
$tempDir = (New-TemporaryFile | ForEach-Object { Remove-Item $_; $dir = New-Item -ItemType Directory -Path ($_.DirectoryName + "\vcr-verify-" + [guid]::NewGuid().ToString().Substring(0,8)) -Force; $dir.FullName })
$env:ROO_VCR_MODE="record"
$env:ROO_VCR_DIR=$tempDir
Write-Output "=== RUN 1: RECORD ==="
pnpm test api/vcr
Write-Output "`n=== FIXTURES CREATED ==="
$files = Get-ChildItem -Path $tempDir -Recurse -File -Filter "*.json" -ErrorAction SilentlyContinue
if ($files.Count -eq 0) { Write-Output "  ❌ No fixtures"; exit 1 }
foreach ($f in $files) { Write-Output "  $($f.FullName)" }
Write-Output "`n=== RUN 2: REPLAY ==="
$env:ROO_VCR_MODE="replay"
pnpm test api/vcr
Write-Output "`n=== SECRET SCAN ==="
$secretsFound = $false
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw
    if ($content -match '(?i)"(sk-|gsk_|Bearer\s+)[a-z0-9_-]{20,}"' -or 
        $content -match '(?i)"(apiKey|token|authorization)"\s*:\s*"[^[REDACTED]]') {
        Write-Output "  ❌ SECRET in $($f.Name)"
        $secretsFound = $true
    }
}
if ($secretsFound) { Write-Output "`n❌ FAILED"; exit 1 } else { Write-Output "`n✓ PASSED" }
```
