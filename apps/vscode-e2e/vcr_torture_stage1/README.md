# Torture VCR fixtures (Stage 1)

This directory is used by the Stage 1 torture E2E test when `TEST_TORTURE_STAGE=1`.

## Default behavior

- Stage 1 runs with `ROO_VCR_MODE=replay` by default.
- The test points `ROO_VCR_DIR` at this directory unless you override it.
- In replay mode the extension **must not make any live LLM network calls**. If a recording is missing, the run fails with a “Recording not found” error.

## Seeding / updating the cassette (one-time)

1. Ensure the torture repo workspace is reset to a clean baseline.
2. Run Stage 1 once in record mode:

```powershell
$env:TEST_TORTURE_STAGE='1'
$env:TEST_TORTURE_REPO='1'
$env:ROO_VCR_MODE='record'
$env:ROO_VCR_DIR='C:\path\to\Roo-Code\apps\vscode-e2e\vcr_torture_stage1'

# Pick a provider/model that can complete the run without throttling.
# Examples:
# - Use a temporary higher-limit OpenAI key/provider
# - Or use a provider with higher limits (e.g. OpenRouter) for the recording run

pnpm -C apps/vscode-e2e test:run
```

3. Commit the generated `*.json` recordings under this directory.
