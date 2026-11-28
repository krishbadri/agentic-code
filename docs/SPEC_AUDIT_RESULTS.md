# Spec Compliance Audit: Transaction Agents Spec vs. Implementation

**Date**: 2026-11-27
**Branch**: `fix/make-it-work`
**Spec**: `docs/transaction_agents_spec.md` (including "Implementation Decisions (2026-11)")

This document replaces the 2026-03 audit. That audit described code that existed only in an
uncommitted working tree (dropped stash `a2b872d48`, preserved as `rescue/stash-0320`). Every
row below cites:

1. the **runtime call site**, i.e. code reachable from a normal extension task, not only from CP
   routes or tests;
2. the **test** that demonstrates the behaviour.

**Test evidence** (run on this branch):

| Suite                | Result                            |
| -------------------- | --------------------------------- |
| `apps/control-plane` | 257 passed, 7 skipped             |
| `src/`               | 3943 passed, 0 failed, 75 skipped |

- The 7 skipped CP tests are CooperBench, which needs network access and Python; enable with `CP_COOPERBENCH=1`.
- `src/core/control-plane/__tests__/cp-contract.integration.spec.ts` drives a real CP server through the extension's own client.

**Verdict scale:**

- **PASS**: implemented, reachable from the runtime, and covered by a test.
- **PARTIAL**: implemented with a stated limitation.
- **N/A**: optional (MAY) or not applicable.

**Not verified:** there has been no interactive VS Code (F5) end-to-end run. The interactive UX (worktree paths showing in editors while a transaction is open) is untested by automation.

## Gating defaults

| Setting                              | Default | Effect                                           |
| ------------------------------------ | ------- | ------------------------------------------------ |
| `roo.experimental.transactionalMode` | `true`  | The CP auto-starts (`src/extension.ts`).         |
| `roo.experimental.plannerMode`       | `true`  | Multi-agent planning for non-trivial root tasks. |

- **CP unavailable at task start:** the task runs single-agent with a warning (`Task.ensureTaskTransaction`).
- **CP lost while a transaction is open:** mutating tools and the final commit fail closed.

## R1–R9: transactions, gates, rollback

| ID                           | Verdict | Runtime call site                                                                                                                                                                                                                                                                                         | Evidence                                                                                                            |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| R1 boundaries                | PASS    | `Task.ensureTaskTransaction` (`src/core/task/Task.ts`) begins one tx per top-level task; the planner's sub-txs come from `PlanExecutor` via `cpTx.subTxBegin`.                                                                                                                                            | `Task.transaction.spec.ts` (distinct txIds per task); contract spec                                                 |
| R2 commit point              | PASS    | Final commit: `Task.commitTaskTransaction`, called from `attemptCompletionTool` and the planner success path. Per-edit checkpoints: `presentAssistantMessage` post-edit gate. Per group: `PlanExecutor` → `checkpoint {reason: "plan-group"}`.                                                            | `attemptCompletionTool.spec.ts`, `PlanExecutor.spec.ts`                                                             |
| R3 checkpoint                | PASS    | Each mutating tool is followed by a CP `/checkpoint`, which commits in the tx worktree. The post-edit hash is recorded.                                                                                                                                                                                   | `QualityGate.spec.ts`, `checkpoint.test.ts`, contract spec                                                          |
| R4 safety ∧ progress checked | PASS    | Progress: `/checkpoint` runs the tx test command, plus the compile command if one is set. Safety: `PlanExecutor` runs `/safety-gate` with the planner's checks or clause; if neither is given, it uses a default clause from `detectProjectCommands`.                                                     | `txn-pipeline` T3, `occ-acceptance` Scenario 4, `commit-lifecycle` (SQLite progress gate)                           |
| R5 commit only if both       | PASS    | `/merge-pipeline` rolls back a sub-tx whose gate is missing or failed (`SAFETY_GATE_FAILED`). `/checkpoint` 403s and resets on regression.                                                                                                                                                                | `strict-merge` "safety gate enforcement"                                                                            |
| R6 liveness at final commit  | PASS    | `/commit` re-runs the tests (exit code and parsed failures) and returns 403 `LIVENESS_FAILED` with a reset. The extension sends a valid body and fails closed on 409/412/5xx or network errors.                                                                                                           | `commit-lifecycle` (liveness with exit 0 but reported failures), `txn-pipeline` T4, `attemptCompletionTool.spec.ts` |
| R7 rollback on violation     | PASS    | Progress and liveness violations reset to the last good checkpoint (else the tx base) and save a backup ref. Failed sub-txs are rolled back by `PlanExecutor` (explicit id list) and by `/merge-pipeline`.                                                                                                | `commit-lifecycle` rollback tests, `strict-merge`, `PlanExecutor.spec.ts`                                           |
| R8 safety rules              | PARTIAL | Declarative clauses (`cmd_exits_0`, `test_suite`, `file_exists`, `not/and/or`) have a strict schema. Granularity is the sub-tx / edit boundary. FORALL and metric atoms are expressed as commands (see spec decisions).                                                                                   | `gates.unit.test.ts` (clauses), `strict-merge` (malformed → 400)                                                    |
| R9 action-safety             | PASS    | `presentAssistantMessage` calls `checkActionSafety` before every mutating tool (`write_to_file`, `apply_diff`, `insert_content`, `search_and_replace`, `execute_command`, `generate_image`). It posts to `/tx/:id/action-safety` and fails closed when the CP is unreachable. Unknown actions are denied. | `actionSafety.spec.ts`, `gates.unit.test.ts` (~60 cases incl. every 2026-11 audit probe), contract spec             |

## R10–R30: concurrency (OCC)

| ID                               | Verdict | Runtime call site                                                                                                                                                                                       | Evidence                                                           |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| R10 OCC                          | PASS    | `PlanExecutor`: one worktree per sub-tx, then `/merge-pipeline`.                                                                                                                                        | `PlanExecutor.spec.ts`, contract spec                              |
| R11 one agent per task           | PASS    | `Task.spawnChildTasks`                                                                                                                                                                                  | `Task.transaction.spec.ts`                                         |
| R12 limit fan-out                | PASS    | `PlanExecutor` concurrency cap                                                                                                                                                                          | `PlanExecutor.spec.ts`                                             |
| R13/R18 isolated worktree        | PASS    | Each sub-tx gets its own worktree. If worktree creation fails, the sub-tx is marked failed and never spawned (`spawnChildTasks` throws without a worktree).                                             | `Task.transaction.spec.ts`, `PlanExecutor.spec.ts`                 |
| R14/R19/R20 local patching       | PASS    | The task's cwd is its worktree, and writes go directly to the filesystem there.                                                                                                                         | `DiffViewProvider.transactional.spec.ts`                           |
| R15 detect at merge              | PASS    | `git.mergeSubTx`                                                                                                                                                                                        | `occ-acceptance` Scenario 2                                        |
| R16 structural conflicts         | PASS    | `analyzeStructuralConflicts` runs inside `/merge-pipeline` and `/sub-tx/:id/merge`. Same-file and dependent-file conflicts are detected (directed import reachability; relative imports in JS/TS only). | `strict-merge` T9a/T9b, `txn-pipeline` T5/T7, `gates.unit.test.ts` |
| R17 abort/rollback conflicting   | PASS    | A later structurally conflicting sub-tx is rolled back even when git could merge it.                                                                                                                    | `strict-merge` T9a (git-clean README edit rolled back), T9e, T9g   |
| R21 detect when agents finish    | PASS    | `/merge-pipeline` after `waitForChildren`                                                                                                                                                               | contract spec                                                      |
| R22 no-conflict first            | PASS    | `planMergeOrder`                                                                                                                                                                                        | `gates.unit.test.ts`, `occ-acceptance` Scenario 3                  |
| R23 order by modifications       | PASS    | `planMergeOrder`: lines changed descending, id as tie-break.                                                                                                                                            | `occ-acceptance` tie-breaker test, `strict-merge` T9c              |
| R24 rollback failed merge        | PASS    | `merge --abort` + reset + cleanup                                                                                                                                                                       | `occ-acceptance` R28 test                                          |
| R25 `worktree add -B`            | PASS    | `git.beginSubTx`                                                                                                                                                                                        | `git.adapter.spec.ts`                                              |
| R26 `apply --reject`             | PASS    | `git.applyPatch`. Note: the extension now writes files directly rather than via `/apply`.                                                                                                               | `occ-acceptance` R26 tests                                         |
| R27 `merge --no-ff`              | PASS    | `git.mergeSubTx`                                                                                                                                                                                        | `occ-acceptance`                                                   |
| R28 abort + remove + `branch -D` | PASS    | `git.cleanupSubTx` / `rollbackSubTx`                                                                                                                                                                    | `txn-pipeline` T2                                                  |
| R29 pessimistic locking          | N/A     | Optional alternative; not implemented.                                                                                                                                                                  | —                                                                  |
| R30 no duplicate new files       | PASS    | `writeToFileTool` → `reserveNewFile` against the parent tx before creating a file. `/merge-pipeline` enforces it (`R30_FILE_RESERVED`).                                                                 | `writeToFileTool.spec.ts`, `strict-merge` T9f, `txn-pipeline` T6   |

## R31–R39: correctness, progress, action surface

| ID                                 | Verdict    | Runtime call site                                                                                                                                                                                                                                                                      | Evidence                                                                   |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| R31/R32 tests are given            | PASS       | Action-safety blocks writes, creation and deletion of test files for every write tool. `/shell/exec` blocks parsed test-file writes before running and reverts any after. `/write` refuses new test files. The only override is the server-side allowlist (`--test-modify-allowlist`). | `gates.unit.test.ts`, `strict-merge`, `occ-acceptance` Scenario 10         |
| R33 progress monotonic             | PASS       | `/checkpoint` with order-independent parsers (Jest, Vitest, pytest, mocha, node:test, TAP, go) and an exit-code fallback.                                                                                                                                                              | `gates.unit.test.ts` (parser table), `txn-pipeline` T3, `commit-lifecycle` |
| R34 termination = all tests pass   | PASS (MAY) | Liveness at `/commit`                                                                                                                                                                                                                                                                  | `txn-pipeline` T4                                                          |
| R35/R36 files and dirs             | PASS       | `write_to_file`, `execute_command`                                                                                                                                                                                                                                                     | —                                                                          |
| R37 bash with guardrails           | PASS       | All commands, including planner children's, go through `/shell/exec`, which runs action-safety on every parsed simple command (nested shells too). Upstream approval prompts still apply.                                                                                              | `executeCommandTool.cp.spec.ts`, `strict-merge` shell tests                |
| R38 env without permanent override | PARTIAL    | `/shell/exec` env is per call and not persisted. Nothing stops a command from editing shell rc files outside the worktree, except containment rules for paths that action-safety can parse.                                                                                            | —                                                                          |
| R39 install deps                   | PASS       | `execute_command`                                                                                                                                                                                                                                                                      | —                                                                          |

## Policies

| Policy                                             | Verdict | Evidence                                                                                                                                                                                             |
| -------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clause interface                                   | PARTIAL | Six node types (see R8). `gates.unit.test.ts`.                                                                                                                                                       |
| Structural policy (disjoint AST nodes MAY proceed) | PASS    | Implemented in the merge-base-aware refinement (`txn-pipeline` T7a–T7f). Limited to JS/TS top-level declarations; any uncertainty keeps the conflict.                                                |
| Rollback semantics                                 | PASS    | Tracked and untracked files are restored, with a backup ref; ignored files are kept; tx processes are killed (`commit-lifecycle` rollback tests). External side effects are not undone (documented). |
| Replay                                             | PARTIAL | File-level only; commands and model calls are refused (`replay.test.ts`).                                                                                                                            |

## End-to-end verification (real VS Code)

`pnpm --filter @roo-code/vscode-e2e test:cp` launches a real VS Code with the built extension on a throw-away git
repository and drives it with a scripted OpenAI-compatible model (`apps/vscode-e2e/src/suite/cp/mock-llm.ts`).
Everything except the model is real: extension activation, Control-Plane auto-start, worktrees, tool execution,
gates, merge pipeline and commit. No API key is needed and the run is deterministic.

| Scenario (`cp-transactions.test.ts`)                   | What it proves                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Control-Plane auto-starts for this repository          | Default settings start the server; `/health` reports the workspace as `repo_root`.                                                                     |
| Single agent: edits reach the workspace only at commit | While the task runs the file exists only in the worktree; after `attempt_completion` it is committed, the workspace is clean and the worktree is gone. |
| Gates                                                  | A test-file write, a recursive delete outside the worktree and `curl \| sh` are refused and the model is told why; a safe command runs; tx ids differ. |
| Progress gate                                          | An edit that breaks a passing test is rolled back automatically and never reaches the workspace.                                                       |
| Planner: different functions of one file               | Two parallel sub-agents in separate sub-transaction worktrees; both edits merge (AST-disjoint) and are committed.                                      |
| Planner: same function                                 | The later sub-transaction is rolled back (`STRUCTURAL_CONFLICT`), the plan fails, nothing is committed and the transaction is discarded.               |
| Cancel → resume                                        | The cancelled task keeps its transaction and worktree; the resumed task re-attaches to the same transaction and commits the earlier work.              |
| Control-Plane lost mid-task                            | Completion fails closed (nothing committed); the next task runs single-agent with the visible warning.                                                 |

`pnpm --filter @roo-code/vscode-e2e test:cp:real` runs a two-task smoke test with a real model
(`cp-real-model.test.ts`, OpenRouter key from the repo-root `.env`; `CP_REAL_MODEL_ID` overrides the model). Last
run: both tasks passed with `nvidia/nemotron-3-ultra-550b-a55b:free` — a single-agent edit committed through its
transaction, and a planned task whose two parallel sub-agents edited different functions of one file and were
merged and committed.

Bugs this suite found that unit and contract tests could not:

- The extension reused any healthy Control-Plane it found (stored port, well-known ports), even one serving a
  different repository; the port was stored globally, so a second window picked up the first window's server. Now
  `/health` reports `repo_root`, the client refuses a mismatch, and the port is stored per workspace.
- The streaming tool-call "repairer" rewrote the `<command>` parameter of every `execute_command` that arrived in
  one chunk (emptying the command) and could rewrite file content inside `write_to_file`. It now only repairs text
  that precedes the first valid tool call (`toolCallRepairer.spec.ts`).
- Planner sub-agents could not get tool approvals outside the repo's test-only "E2E mode": the chat view answers only
  the visible task, so parallel sub-agents' edits were dropped. Their asks are now decided in the extension host from
  the auto-approval settings (`headlessApproval.ts`); if those settings do not allow reading and writing, the planner
  is skipped and the task runs as a single interactive agent.
- A test runner that finds no tests (pytest exit 5, jest/vitest "no tests found") blocked every commit. An empty
  suite now passes liveness vacuously; a suite that is already red at the base commit is reported when the
  transaction begins and named in the commit refusal.

- Cancel → resume opened a new transaction and orphaned the earlier work: the resumed task saved its history
  record (without the transaction id) before re-attaching. The recorded id is now kept until re-attachment.
- A failure to _produce_ a plan (model error, unparsable answer) stopped the task and discarded the transaction.
  Nothing has run at that point, so the task now continues as a single agent in the same transaction.
- With a real model, sub-agents wrapped `write_to_file` parameters in `<args><file>…` (copying the `read_file`
  example in their prompt) and every write failed with "no target path". The prompt now shows both shapes and the
  wrapper is unwrapped for tools that do not take `args` (`unwrapArgs.spec.ts`).
- A task whose folder is not the one the Control-Plane manages (multi-root workspace, workspace override) now runs
  without a transaction instead of transacting in the other repository.

### Found by CI (Linux and Windows runners)

- **Symlink guard did nothing on Windows.** `checkSymlinkPath` split the relative path on the platform separator,
  but paths arrive with `/`, so on Windows no directory component was ever checked and a write or read through a
  link or junction inside a worktree could reach outside it. It now splits on both separators. The acceptance
  test used to skip silently when symlinks needed admin rights; it now falls back to a junction and always runs.
- **No database on a fresh install.** pnpm 10 does not run dependency build scripts unless allow-listed, so
  `better-sqlite3` had no native binding and the Control-Plane silently ran DB-less (no metrics, no replay log).
  `pnpm-workspace.yaml` now allow-lists it.
- **Bundle failed on a clean checkout.** `src/esbuild.mjs` copied a stale `webview-ui/build` folder that exists
  only on a developer machine. The copy step is removed.
- **Unhandled rejection after cancel.** A transaction-setup notice could be sent after the task was aborted.
  Setup notices now go through `sayIfActive`.

## Known limitations

- **Dev-host `.env`.** `src/.env` is loaded by the extension in the development host. If it sets
  `TEST_TORTURE_REPO` / `TEST_TORTURE_REPO_WORKSPACE`, every task runs in the test-only "E2E mode" and uses the
  torture repository as its working directory, whatever folder is open. Keep those lines out of `.env`; the
  torture harness sets them itself (`pnpm --filter @roo-code/vscode-e2e test:torture`).
- **Tasks that must add tests.** Tests are "given", so a task that asks the agent to write a new test file is
  blocked unless the operator names that file in `--test-modify-allowlist` / `CP_TEST_MODIFY_ALLOWLIST` when the
  Control-Plane starts. The torture harness does this for the one file its prompt names.
- **Shell analysis is best-effort.** It parses POSIX sh, PowerShell and cmd syntax; a sufficiently obfuscated command can still evade it. The post-exec test-file revert and worktree isolation are the backstop.
- **Narrow conflict analysis.** Dependent-file analysis follows only relative JS/TS imports; other languages fall back to same-file detection.
- **Liveness is absolute.** A test suite that was already failing before the task still blocks the commit (the user is warned when the transaction begins).
- **Sub-agents follow auto-approval.** Planner sub-agents cannot prompt; anything the auto-approval settings do not allow fails that sub-transaction with the reason.
