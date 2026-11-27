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

| ID                                 | Verdict    | Runtime call site                                                                                                                                                                                                                                          | Evidence                                                                   |
| ---------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| R31/R32 tests are given            | PASS       | Action-safety blocks writes, creation and deletion of test files for every write tool. `/shell/exec` blocks parsed test-file writes before running and reverts any after. `/write` refuses new test files. The only override is the server-side allowlist. | `gates.unit.test.ts`, `strict-merge`, `occ-acceptance` Scenario 10         |
| R33 progress monotonic             | PASS       | `/checkpoint` with order-independent parsers (Jest, Vitest, pytest, mocha, node:test, TAP, go) and an exit-code fallback.                                                                                                                                  | `gates.unit.test.ts` (parser table), `txn-pipeline` T3, `commit-lifecycle` |
| R34 termination = all tests pass   | PASS (MAY) | Liveness at `/commit`                                                                                                                                                                                                                                      | `txn-pipeline` T4                                                          |
| R35/R36 files and dirs             | PASS       | `write_to_file`, `execute_command`                                                                                                                                                                                                                         | —                                                                          |
| R37 bash with guardrails           | PASS       | All commands, including planner children's, go through `/shell/exec`, which runs action-safety on every parsed simple command (nested shells too). Upstream approval prompts still apply.                                                                  | `executeCommandTool.cp.spec.ts`, `strict-merge` shell tests                |
| R38 env without permanent override | PARTIAL    | `/shell/exec` env is per call and not persisted. Nothing stops a command from editing shell rc files outside the worktree, except containment rules for paths that action-safety can parse.                                                                | —                                                                          |
| R39 install deps                   | PASS       | `execute_command`                                                                                                                                                                                                                                          | —                                                                          |

## Policies

| Policy                                             | Verdict | Evidence                                                                                                                                                                                             |
| -------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clause interface                                   | PARTIAL | Six node types (see R8). `gates.unit.test.ts`.                                                                                                                                                       |
| Structural policy (disjoint AST nodes MAY proceed) | PASS    | Implemented in the merge-base-aware refinement (`txn-pipeline` T7a–T7f). Limited to JS/TS top-level declarations; any uncertainty keeps the conflict.                                                |
| Rollback semantics                                 | PASS    | Tracked and untracked files are restored, with a backup ref; ignored files are kept; tx processes are killed (`commit-lifecycle` rollback tests). External side effects are not undone (documented). |
| Replay                                             | PARTIAL | File-level only; commands and model calls are refused (`replay.test.ts`).                                                                                                                            |

## Known limitations

- **No live VS Code run.** There has been no interactive VS Code (F5) end-to-end run against a real model. The extension's CP traffic is covered by the live contract spec, and task logic by unit tests.
- **Shell analysis is best-effort.** It parses POSIX sh, PowerShell and cmd syntax; a sufficiently obfuscated command can still evade it. The post-exec test-file revert and worktree isolation are the backstop.
- **Narrow conflict analysis.** Dependent-file analysis follows only relative JS/TS imports; other languages fall back to same-file detection.
- **Workspace commit outside transactions.** The non-transactional `save_checkpoint` path still makes a git commit in the user's workspace (pre-existing behaviour).
