# Namespace Rename Evidence Report

## [Manifest]

### File: `src/package.json`

**Publisher**: `AgenticCode`  
**Name**: `agentic-cline`  
**DisplayName**: `%extension.displayName%` (localized)

**Activation Events**:
- `onStartupFinished`
- `onCommand:roo.startControlPlaneHere`
- `onCommand:roo.commitTransaction`
- `onCommand:roo-cline.saveCheckpoint`
- `onCommand:roo-cline.rollbackCheckpoint`
- `onCommand:roo-cline.suggestRollback`

**Commands** (first ~20):
1. `roo-cline.saveCheckpoint`
2. `roo.startControlPlaneHere`
3. `roo-cline.plusButtonClicked`
4. `roo-cline.promptsButtonClicked`
5. `roo-cline.mcpButtonClicked`
6. `roo-cline.historyButtonClicked`
7. `roo-cline.marketplaceButtonClicked`
8. `roo-cline.popoutButtonClicked`
9. `roo-cline.cloudButtonClicked`
10. `roo-cline.settingsButtonClicked`
11. `roo-cline.openInNewTab`
12. `roo-cline.explainCode`
13. `roo-cline.fixCode`
14. `roo-cline.improveCode`
15. `roo-cline.addToContext`
16. `roo-cline.newTask`
17. `roo-cline.terminalAddToContext`
18. `roo-cline.terminalFixCommand`
19. `roo-cline.terminalExplainCommand`
20. `roo-cline.setCustomStoragePath`
21. `roo-cline.importSettings`
22. `roo-cline.focusInput`
23. `roo-cline.acceptInput`
24. `roo-cline.toggleAutoApprove`
25. `roo.commitTransaction`
26. `roo-cline.rollbackCheckpoint`
27. `roo-cline.suggestRollback`

**Configuration Properties** (keys):
- `roo.controlPlane.rootPath`
- `roo.cpPortOverride`
- `roo.experimental.transactionalMode`
- `roo-cline.experimental.transactionalMode` (alias)
- `roo.experimental.plannerMode`
- `roo-cline.experimental.plannerMode` (alias)
- `roo.autoCheckpoint.enabled`
- `roo.autoCheckpoint.patchBytes`
- `roo.autoCheckpoint.filesTouched`
- `roo.autoCheckpoint.elapsedMs`
- `roo-cline.allowedCommands`
- `roo-cline.deniedCommands`
- `roo-cline.commandExecutionTimeout`
- `roo-cline.commandTimeoutAllowlist`
- `roo-cline.preventCompletionWithOpenTodos`
- `roo-cline.vsCodeLmModelSelector`
- `roo-cline.customStoragePath`
- `roo-cline.enableCodeActions`
- `roo-cline.autoImportSettingsPath`
- `roo-cline.useAgentRules`
- `roo-cline.apiRequestTimeout`
- `roo-cline.newTaskRequireTodos`
- `roo-cline.codeIndex.embeddingBatchSize`

**Views/Menus**:
- Activity bar ID: `roo-cline-ActivityBar`
- Sidebar provider ID: `roo-cline.SidebarProvider`
- Context menu ID: `roo-cline.contextMenu`
- Terminal menu ID: `roo-cline.terminalMenu`

---

## [Namespace Hits]

### "agentic-cline" occurrences:

1. **src/package.json:2** - `"name": "agentic-cline"`
2. **src/activate/__tests__/CodeActionProvider.spec.ts:113** - Test expectation: `expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith("agentic-cline")`
3. **RUNBOOK.md:52** - Documentation reference
4. **RUNBOOK.md:84** - Command reference: `pnpm --filter agentic-cline test`
5. **RUNBOOK.md:240** - Test results reference
6. **RUNBOOK.md:261** - Build command reference
7. **RUNBOOK.md:269** - Test command reference
8. **RUNBOOK.md:278** - VSIX command reference
9. **RUNBOOK.md:297** - Build verification reference
10. **RUNBOOK.md:299** - VSIX packaging reference

### "roo-cline" occurrences:

1. **src/package.json:52** - Activation event: `onCommand:roo-cline.saveCheckpoint`
2. **src/package.json:53** - Activation event: `onCommand:roo-cline.rollbackCheckpoint`
3. **src/package.json:54** - Activation event: `onCommand:roo-cline.suggestRollback`
4. **src/package.json:61** - Activity bar ID: `roo-cline-ActivityBar`
5. **src/package.json:71** - Sidebar provider ID: `roo-cline.SidebarProvider`
6. **src/package.json:78** - Command: `roo-cline.saveCheckpoint`
7. **src/package.json:88** - Command: `roo-cline.plusButtonClicked`
8. **src/package.json:93** - Command: `roo-cline.promptsButtonClicked`
9. **src/package.json:98** - Command: `roo-cline.mcpButtonClicked`
10. **src/package.json:103** - Command: `roo-cline.historyButtonClicked`
11. **src/package.json:108** - Command: `roo-cline.marketplaceButtonClicked`
12. **src/package.json:113** - Command: `roo-cline.popoutButtonClicked`
13. **src/package.json:118** - Command: `roo-cline.cloudButtonClicked`
14. **src/package.json:123** - Command: `roo-cline.settingsButtonClicked`
15. **src/package.json:128** - Command: `roo-cline.openInNewTab`
16. **src/package.json:133** - Command: `roo-cline.explainCode`
17. **src/package.json:138** - Command: `roo-cline.fixCode`
18. **src/package.json:143** - Command: `roo-cline.improveCode`
19. **src/package.json:148** - Command: `roo-cline.addToContext`
20. **src/package.json:153** - Command: `roo-cline.newTask`
21. **src/package.json:158** - Command: `roo-cline.terminalAddToContext`
22. **src/package.json:163** - Command: `roo-cline.terminalFixCommand`
23. **src/package.json:168** - Command: `roo-cline.terminalExplainCommand`
24. **src/package.json:173** - Command: `roo-cline.setCustomStoragePath`
25. **src/package.json:178** - Command: `roo-cline.importSettings`
26. **src/package.json:183** - Command: `roo-cline.focusInput`
27. **src/package.json:188** - Command: `roo-cline.acceptInput`
28. **src/package.json:193** - Command: `roo-cline.toggleAutoApprove`
29. **src/package.json:203** - Command: `roo-cline.rollbackCheckpoint`
30. **src/package.json:209** - Command: `roo-cline.suggestRollback`
31. **src/package.json:218** - Menu: `roo-cline.contextMenu`
32. **src/package.json:224** - Command reference: `roo-cline.addToContext`
33. **src/package.json:228** - Command reference: `roo-cline.explainCode`
34. **src/package.json:232** - Command reference: `roo-cline.improveCode`
35. **src/package.json:238** - Menu: `roo-cline.terminalMenu`
36. **src/package.json:244** - Command reference: `roo-cline.terminalAddToContext`
37. **src/package.json:248** - Command reference: `roo-cline.terminalFixCommand`
38. **src/package.json:252** - Command reference: `roo-cline.terminalExplainCommand`
39. **src/package.json:258** - View condition: `view == roo-cline.SidebarProvider`
40. **src/package.json:260** - View condition: `view == roo-cline.SidebarProvider`
41. **src/package.json:268** - View condition: `view == roo-cline.SidebarProvider`
42. **src/package.json:273** - View condition: `view == roo-cline.SidebarProvider`
43. **src/package.json:278** - View condition: `view == roo-cline.SidebarProvider`
44. **src/package.json:283** - View condition: `view == roo-cline.SidebarProvider`
45. **src/package.json:288** - View condition: `view == roo-cline.SidebarProvider`
46. **src/package.json:293** - View condition: `view == roo-cline.SidebarProvider`
47. **src/package.json:298** - View condition: `view == roo-cline.SidebarProvider`
48. **src/package.json:303** - View condition: `view == roo-cline.SidebarProvider`
49. **src/package.json:308** - View condition: `view == roo-cline.SidebarProvider`
50. **src/package.json:315** - View condition: `activeWebviewPanelId == roo-cline.TabPanelProvider`
51. **src/package.json:365** - Keybinding: `roo-cline.addToContext`
52. **src/package.json:373** - Keybinding: `roo-cline.toggleAutoApprove`
53. **src/package.json:382** - Submenu: `roo-cline.contextMenu`
54. **src/package.json:386** - Submenu: `roo-cline.terminalMenu`
55. **src/package.json:408** - Config property: `roo-cline.experimental.transactionalMode`
56. **src/package.json:418** - Config property: `roo-cline.experimental.plannerMode`
57. **src/package.json:446** - Config property: `roo-cline.allowedCommands`
58. **src/package.json:458** - Config property: `roo-cline.deniedCommands`
59. **src/package.json:466** - Config property: `roo-cline.commandExecutionTimeout`
60. **src/package.json:473** - Config property: `roo-cline.commandTimeoutAllowlist`
61. **src/package.json:481** - Config property: `roo-cline.preventCompletionWithOpenTodos`
62. **src/package.json:486** - Config property: `roo-cline.vsCodeLmModelSelector`
63. **src/package.json:500** - Config property: `roo-cline.customStoragePath`
64. **src/package.json:505** - Config property: `roo-cline.enableCodeActions`
65. **src/package.json:510** - Config property: `roo-cline.autoImportSettingsPath`
66. **src/package.json:515** - Config property: `roo-cline.useAgentRules`
67. **src/package.json:520** - Config property: `roo-cline.apiRequestTimeout`
68. **src/package.json:527** - Config property: `roo-cline.newTaskRequireTodos`
69. **src/package.json:532** - Config property: `roo-cline.codeIndex.embeddingBatchSize`
70. **webview-ui/src/components/cloud/CloudView.tsx:318** - URI scheme: `vscode://RooVeterinaryInc.roo-cline/auth/clerk/callback`
71. **src/services/mdm/__tests__/MdmService.spec.ts:38** - Test mock: `name: "roo-cline"`
72. **src/integrations/editor/DiffViewProvider.ts:205** - Config read: `cfg.get<boolean>("roo-cline.experimental.transactionalMode")`
73. **src/integrations/editor/DiffViewProvider.ts:725** - Config read: `cfg.get<boolean>("roo-cline.experimental.transactionalMode")`

### "roo." occurrences:

1. **src/package.json:50** - Activation event: `onCommand:roo.startControlPlaneHere`
2. **src/package.json:51** - Activation event: `onCommand:roo.commitTransaction`
3. **src/package.json:83** - Command: `roo.startControlPlaneHere`
4. **src/package.json:85** - Command category: `"Roo"`
5. **src/package.json:198** - Command: `roo.commitTransaction`
6. **src/package.json:200** - Command category: `"Roo"`
7. **src/package.json:205** - Command category: `"Roo"`
8. **src/package.json:211** - Command category: `"Roo"`
9. **src/package.json:263** - Command reference: `roo.startControlPlaneHere`
10. **src/package.json:308** - Command reference: `roo.commitTransaction`
11. **src/package.json:393** - Config property: `roo.controlPlane.rootPath`
12. **src/package.json:398** - Config property: `roo.cpPortOverride`
13. **src/package.json:403** - Config property: `roo.experimental.transactionalMode`
14. **src/package.json:413** - Config property: `roo.experimental.plannerMode`
15. **src/package.json:423** - Config property: `roo.autoCheckpoint.enabled`
16. **src/package.json:428** - Config property: `roo.autoCheckpoint.patchBytes`
17. **src/package.json:434** - Config property: `roo.autoCheckpoint.filesTouched`
18. **src/package.json:440** - Config property: `roo.autoCheckpoint.elapsedMs`
19. **src/integrations/editor/DiffViewProvider.ts:204** - Config read: `cfg.get<boolean>("roo.experimental.transactionalMode")`
20. **src/integrations/editor/DiffViewProvider.ts:209** - Config read: `vscode.workspace.getConfiguration().get<number>("roo.cpPortOverride")`
21. **src/integrations/editor/DiffViewProvider.ts:724** - Config read: `cfg.get<boolean>("roo.experimental.transactionalMode")`
22. **src/integrations/editor/DiffViewProvider.ts:729** - Config read: `vscode.workspace.getConfiguration().get<number>("roo.cpPortOverride")`
23. **src/extension.ts:294** - Config read: `cfg.get<boolean>("roo.experimental.transactionalMode")`
24. **src/extension.ts:295** - Config read: `cfg.get<boolean>("roo-cline.experimental.transactionalMode")`
25. **src/extension.ts:300** - Global state key: `"roo.cpPort"`
26. **webview-ui/src/components/welcome/WelcomeView.tsx:106** - Translation key: `t("welcome:routers.roo.description")`
27. **webview-ui/src/components/settings/ApiOptions.tsx:673** - Translation key: `t("settings:providers.roo.authenticatedMessage")`
28. **webview-ui/src/components/settings/ApiOptions.tsx:681** - Translation key: `t("settings:providers.roo.connectButton")`

### "roo.internal" occurrences:

1. **src/integrations/editor/__tests__/DiffViewProvider.transactional.spec.ts:14** - Mock: `if (id === "roo.internal.getCurrentTxId") return "tx-test"`
2. **src/integrations/editor/__tests__/DiffViewProvider.transactional.spec.ts:15** - Mock: `if (id === "roo.internal.getCpPort") return 12345`
3. **src/integrations/editor/DiffViewProvider.ts:207** - Command: `vscode.commands.executeCommand<string>("roo.internal.getCurrentTxId")`
4. **src/integrations/editor/DiffViewProvider.ts:210** - Command: `await vscode.commands.executeCommand<number>("roo.internal.getCpPort")`
5. **src/integrations/editor/DiffViewProvider.ts:225** - Command: `await vscode.commands.executeCommand("roo.internal.recordEdit", ...)`
6. **src/integrations/editor/DiffViewProvider.ts:229** - Command: `await vscode.commands.executeCommand("roo.internal.maybeAutoCheckpoint")`
7. **src/integrations/editor/DiffViewProvider.ts:250** - Command: `await vscode.commands.executeCommand("roo.internal.recordEdit", ...)`
8. **src/integrations/editor/DiffViewProvider.ts:255** - Command: `await vscode.commands.executeCommand("roo.internal.maybeAutoCheckpoint")`
9. **src/integrations/editor/DiffViewProvider.ts:727** - Command: `vscode.commands.executeCommand<string>("roo.internal.getCurrentTxId")`
10. **src/extension.ts:315** - Command registration: `vscode.commands.registerCommand("roo.internal.getCurrentTxId", ...)`
11. **src/extension.ts:320** - Command registration: `vscode.commands.registerCommand("roo.internal.getCpPort", ...)`

---

## [Test Mocks]

### Vitest Configuration

**File**: `src/vitest.config.ts`
- Uses alias: `vscode: path.resolve(__dirname, "./__mocks__/vscode.js")`
- Setup file: `./vitest.setup.ts`
- Test timeout: 20_000ms
- Hook timeout: 20_000ms

**File**: `src/vitest.setup.ts`
- Disables network requests via nock
- Provides global `structuredClone` polyfill

### Global VSCode Mock

**File**: `src/__mocks__/vscode.js`

```javascript
export const workspace = {
	workspaceFolders: [],
	getWorkspaceFolder: () => null,
	onDidChangeWorkspaceFolders: () => mockDisposable,
	getConfiguration: () => ({
		get: () => null,
	}),
	createFileSystemWatcher: () => ({ ... }),
	fs: { ... },
}

export const window = {
	activeTextEditor: null,
	onDidChangeActiveTextEditor: () => mockDisposable,
	showErrorMessage: () => Promise.resolve(),
	showWarningMessage: () => Promise.resolve(),
	showInformationMessage: () => Promise.resolve(),
	createOutputChannel: () => ({ ... }),
	createTerminal: () => ({ ... }),
	onDidCloseTerminal: () => mockDisposable,
	createTextEditorDecorationType: () => ({ dispose: () => {} }),
}

export const commands = {
	registerCommand: () => mockDisposable,
	executeCommand: () => Promise.resolve(),
}
```

**Note**: The global mock's `getConfiguration()` returns `{ get: () => null }` - this is a minimal mock that may not satisfy all test expectations.

### Per-Test VSCode Mocks

**File**: `src/activate/__tests__/CodeActionProvider.spec.ts:8-33`
```typescript
vi.mock("vscode", () => ({
	CodeAction: vi.fn().mockImplementation((title, kind) => ({ ... })),
	CodeActionKind: { ... },
	Range: vi.fn().mockImplementation(...),
	DiagnosticSeverity: { ... },
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(true),
		}),
	},
}))
```
**Used by**: CodeActionProvider tests

**File**: `src/integrations/editor/__tests__/DiffViewProvider.transactional.spec.ts:7-30`
```typescript
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({ get: (k: string, d: any) => (k.includes("transactionalMode") ? true : d) })),
		applyEdit: vi.fn().mockResolvedValue(true),
	},
	commands: {
		executeCommand: vi.fn(async (id: string) => {
			if (id === "roo.internal.getCurrentTxId") return "tx-test"
			if (id === "roo.internal.getCpPort") return 12345
			return undefined
		}),
	},
	window: {
		visibleTextEditors: [],
		tabGroups: { all: [] },
		showTextDocument: vi.fn().mockResolvedValue({ ... }),
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	Range: vi.fn(),
	Position: vi.fn(),
	TextEditorRevealType: {},
	languages: { getDiagnostics: vi.fn(() => []) },
}))
```
**Used by**: DiffViewProvider transactional routing test

**File**: `src/integrations/editor/__tests__/DiffViewProvider.spec.ts:29-92`
```typescript
vi.mock("vscode", () => ({
	workspace: {
		applyEdit: vi.fn(),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		openTextDocument: vi.fn().mockResolvedValue({ ... }),
		textDocuments: [],
		fs: { stat: vi.fn() },
	},
	window: {
		createTextEditorDecorationType: vi.fn(),
		showTextDocument: vi.fn(),
		onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
		tabGroups: { all: [], close: vi.fn() },
		visibleTextEditors: [],
	},
	commands: {
		executeCommand: vi.fn(),
	},
	languages: {
		getDiagnostics: vi.fn(() => []),
	},
	// ... more mocks
}))
```
**Used by**: DiffViewProvider tests (saveDirectly, saveChanges methods)

**File**: `src/core/webview/__tests__/ClineProvider.spec.ts:135-181`
```typescript
vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Uri: { joinPath: vi.fn(), file: vi.fn() },
	CodeActionKind: { ... },
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: { uriScheme: "vscode", language: "en", appName: "Visual Studio Code" },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	version: "1.85.0",
}))
```
**Used by**: ClineProvider tests

**File**: `src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:10-55`
```typescript
vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Uri: { joinPath: vi.fn(), file: vi.fn() },
	CodeActionKind: { ... },
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: { uriScheme: "vscode", language: "en", appName: "Visual Studio Code" },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	version: "1.85.0",
}))
```
**Used by**: ClineProvider sticky-mode tests

**File**: `src/__tests__/extension.spec.ts:6-43`
```typescript
vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({ appendLine: vi.fn() }),
		registerWebviewViewProvider: vi.fn(),
		registerUriHandler: vi.fn(),
		tabGroups: { onDidChangeTabs: vi.fn() },
		onDidChangeActiveTextEditor: vi.fn(),
	},
	workspace: {
		registerTextDocumentContentProvider: vi.fn(),
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
		}),
		createFileSystemWatcher: vi.fn().mockReturnValue({ ... }),
		onDidChangeWorkspaceFolders: vi.fn(),
	},
	languages: {
		registerCodeActionsProvider: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	env: { language: "en" },
	ExtensionMode: { Production: 1 },
}))
```
**Used by**: Extension activation tests

**File**: `src/core/task/__tests__/grounding-sources.test.ts:6-48`
```typescript
vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({ ... })),
		getConfiguration: vi.fn(() => ({
			get: vi.fn(() => true),
		})),
		openTextDocument: vi.fn(),
		applyEdit: vi.fn(),
	},
	RelativePattern: vi.fn((base, pattern) => ({ base, pattern })),
	window: {
		createOutputChannel: vi.fn(() => ({ ... })),
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showTextDocument: vi.fn(),
		activeTextEditor: undefined,
	},
	Uri: { file: vi.fn((path) => ({ fsPath: path })), parse: vi.fn((str) => ({ toString: () => str })) },
	Range: vi.fn(),
	Position: vi.fn(),
	WorkspaceEdit: vi.fn(() => ({ replace: vi.fn(), insert: vi.fn(), delete: vi.fn() })),
	ViewColumn: { One: 1, Two: 2, Three: 3 },
}))
```
**Used by**: Task grounding sources tests

---

## [Test Failures]

### Summary

**Test Files**: 6 failed | 290 passed | 3 skipped (299 total)  
**Tests**: 108 failed | 3757 passed | 42 skipped (3907 total)

### Failure Category A: TypeError: vscode.workspace.getConfiguration is not a function

**Stack Trace 1**:
```
TypeError: workspace.getConfiguration is not a function
```
**Occurrences**: Multiple (8+ instances observed)

**Root Cause**: Some tests import modules that call `vscode.workspace.getConfiguration()` but the test's vscode mock doesn't include `workspace.getConfiguration`, or the mock is incomplete.

**Affected Files** (likely):
- Tests that import production code calling `getConfiguration()` without proper mocks
- Tests using the global `__mocks__/vscode.js` which has `getConfiguration` but may be overridden by incomplete per-test mocks

### Failure Category B: Transactional routing test expecting fetch but not called

**File**: `src/integrations/editor/__tests__/DiffViewProvider.transactional.spec.ts:42`

**Test**: `"routes saveChanges to control-plane"`

**Error**:
```
AssertionError: expected "spy" to be called at least once
 ❯ integrations/editor/__tests__/DiffViewProvider.transactional.spec.ts:42:33
     40|   const res = await dp.saveChanges(true, 0)
     41|   expect(res.userEdits).toBeUndefined()
     42|   expect((global as any).fetch).toHaveBeenCalled()
```

**Root Cause**: The test mocks `roo.internal.getCurrentTxId` and `roo.internal.getCpPort`, but the implementation in `DiffViewProvider.ts:202-210` checks:
1. `cfg.get<boolean>("roo.experimental.transactionalMode")` OR `cfg.get<boolean>("roo-cline.experimental.transactionalMode")`
2. If true, gets `txId` and `port`
3. Only calls `fetch` if both `txId` and `port` are truthy

The mock's `getConfiguration` returns `{ get: (k: string, d: any) => (k.includes("transactionalMode") ? true : d) }`, which should work, but the test may be failing because:
- The mock's `get` function may not be called correctly
- The `txId` or `port` may be falsy
- The `fetch` call may be conditional on other state

**Status**: ✅ **FIXED** - Test now passes after adding `roo.internal.getCpPort` mock.

### Failure Category C: Other High-Frequency Failures

**1. Extension.spec.ts timeout failures**

**File**: `src/__tests__/extension.spec.ts:195` and `src/__tests__/extension.spec.ts:228`

**Tests**:
- `"authStateChangedHandler calls BridgeOrchestrator.disconnect when logged-out event fires"`
- `"authStateChangedHandler does not call BridgeOrchestrator.disconnect for other states"`

**Error**: Test timed out in 20000ms

**Root Cause**: Tests dynamically import `@roo-code/cloud` and `../extension`, which may be slow or have circular dependencies. The timeout was increased to 30s but may still be insufficient.

**2. Grounding sources test timeout**

**File**: `src/core/task/__tests__/grounding-sources.test.ts:80`

**Test**: `"Task grounding sources handling"` (beforeAll hook)

**Error**: Hook timed out in 20000ms

**Root Cause**: Dynamic import of `../Task` in `beforeAll` hook is taking too long. Timeout increased to 30s.

**3. Checkpoint test failure**

**File**: `src/core/checkpoints/__tests__/checkpoint.test.ts:407`

**Test**: `"should create new service if none exists"`

**Error**:
```
AssertionError: expected "create" to be called with arguments: [ { taskId: 'test-task-id', …(3) } ]
```

**Root Cause**: Test expects `RepoPerTaskCheckpointService.create` to be called synchronously, but `getCheckpointService` returns a Promise. The test may need to await the service creation.

**4. Task.spec.ts TypeError**

**File**: `src/core/task/__tests__/Task.spec.ts:1023` and `1096`

**Tests**:
- `"should enforce rate limiting across parent and subtask"`
- `"should not apply rate limiting if enough time has passed"`

**Error**:
```
TypeError: this.providerRef.deref(...)?.log is not a function
```

**Root Cause**: Test mocks don't provide a `log` function on the provider object returned by `providerRef.deref()`.

---

## [Key Findings]

1. **Namespace Inconsistency**:
   - Package name: `agentic-cline` (in `package.json`)
   - Commands: Mix of `roo-cline.*` and `roo.*`
   - Config sections: Mix of `roo-cline.*` and `roo.*`
   - Internal commands: `roo.internal.*`
   - Code uses `Package.name` (currently `"agentic-cline"`) for `getConfiguration(Package.name)`

2. **Test Mock Issues**:
   - Global mock (`__mocks__/vscode.js`) provides `getConfiguration` but returns minimal implementation
   - Per-test mocks sometimes override with incomplete implementations
   - Some tests don't mock `workspace.getConfiguration` at all, causing "is not a function" errors

3. **Transactional Routing**:
   - Implementation checks both `roo.experimental.transactionalMode` and `roo-cline.experimental.transactionalMode`
   - Requires both `txId` and `port` to call `fetch`
   - Test was missing `roo.internal.getCpPort` mock (now fixed)

4. **Package.name Usage**:
   - `src/activate/CodeActionProvider.ts:40` uses `Package.name` for config section
   - `src/utils/commands.ts` uses `Package.name` to build command IDs
   - `src/services/code-index/processors/scanner.ts:52` uses `Package.name` for config
   - `src/core/webview/webviewMessageHandler.ts:1017` uses `Package.name` for config
   - Since `Package.name` comes from `package.json` which has `"agentic-cline"`, all these will use `"agentic-cline"` unless renamed
