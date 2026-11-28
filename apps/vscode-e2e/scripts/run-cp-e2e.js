// Runs the Control-Plane end-to-end suite in a real VS Code.
//
//   pnpm --filter @roo-code/vscode-e2e test:cp        scripted model, no API key, deterministic
//   pnpm --filter @roo-code/vscode-e2e test:cp:real   real model smoke test (OPENROUTER_API_KEY from ../../.env)
//
// Requires a built extension (`pnpm bundle` at the repo root).
process.env.TEST_CP_E2E = "1"
if (process.argv.includes("--real")) process.env.TEST_CP_REAL = "1"
else delete process.env.TEST_CP_REAL
delete process.env.TEST_GREP
delete process.env.TEST_FILE
require("../out/runTest.js")
