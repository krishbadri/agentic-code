# PowerShell script to run torture repo scenario with VCR
# Usage: .\scripts\run-torture-vcr-proof.ps1 [record|replay]

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("record", "replay")]
    [string]$Mode,
    
    [string]$VcrDir = $null
)

$ErrorActionPreference = "Stop"

# Set VCR environment
if (-not $VcrDir) {
    $VcrDir = (New-TemporaryFile | ForEach-Object { 
        Remove-Item $_; 
        $dir = New-Item -ItemType Directory -Path ($_.DirectoryName + "\vcr-torture-" + [guid]::NewGuid().ToString().Substring(0,8)) -Force; 
        $dir.FullName 
    })
}

$env:ROO_VCR_MODE = $Mode
$env:ROO_VCR_DIR = $VcrDir

Write-Host "=== VCR Torture Repo Proof ===" -ForegroundColor Cyan
Write-Host "Mode: $Mode" -ForegroundColor Yellow
Write-Host "VCR Dir: $VcrDir" -ForegroundColor Yellow

# Torture repo paths
$tortureRepo = "C:\Users\kpb20\Downloads\txn-agent-torture-repo\txn-agent-torture-repo"
$taskFile = Join-Path $tortureRepo "tasks\001_add_sqlite_store.md"

if (-not (Test-Path $taskFile)) {
    Write-Error "Task file not found: $taskFile"
    exit 1
}

Write-Host "`nTask file: $taskFile" -ForegroundColor Green
Write-Host "Workspace: $tortureRepo" -ForegroundColor Green

# Read task prompt
$prompt = Get-Content $taskFile -Raw
Write-Host "Prompt length: $($prompt.Length) chars" -ForegroundColor Green

Write-Host "`n=== NOTE ===" -ForegroundColor Yellow
Write-Host "The torture repo is designed for manual use via VS Code extension UI." -ForegroundColor Yellow
Write-Host "To prove VCR determinism:" -ForegroundColor Yellow
Write-Host "1. Open VS Code with torture repo: code $tortureRepo" -ForegroundColor Yellow
Write-Host "2. In Roo Code extension, send this prompt:" -ForegroundColor Yellow
Write-Host "   $($prompt.Substring(0, [Math]::Min(200, $prompt.Length)))..." -ForegroundColor Gray
Write-Host "3. VCR will record/replay based on ROO_VCR_MODE=$Mode" -ForegroundColor Yellow
Write-Host "4. After completion, check fixtures in: $VcrDir" -ForegroundColor Yellow

Write-Host "`nVCR_DIR preserved for inspection: $VcrDir" -ForegroundColor Cyan
