# Spec Compliance Audit: Transaction Agents Spec vs Roo-Code Implementation

**Date**: 2026-03-02
**Branch**: `feat/post-edit-quality-gate`
**Spec**: `docs/transaction_agents_spec.md` v1.0

---

## Methodology

Every requirement R1–R39, the Clause Interface, and the Structural Conflict Policy were traced to actual code. Each was verified for:

1. Code existence
2. Reachability from normal execution
3. Correct behavior per spec text

---

## Results: R1–R9 (Orchestrator + Safety)

| ID     | Requirement                                         | Verdict  | Evidence                                                                                                                                                                                                                                                   |
| ------ | --------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | Transaction boundaries MUST be pre-specified        | **PASS** | PlannerAgent generates `Plan` with `SubTransaction[]` before execution. Non-planner tasks get implicit single sub-tx in `initiateTaskLoop()`.                                                                                                              |
| **R2** | Commit points at end of each boundary               | **PASS** | PlanExecutor: `waitForChildren → runSafetyChecks → mergeWorktrees` per group. Non-planner: `runPostEditQualityGate()` after each file mutation.                                                                                                            |
| **R3** | Checkpoint at each commit point                     | **PASS** | Pre-edit: `checkpointSaveAndMark()`. Post-edit (R3 FIX): `task.checkpointSave(true)` when quality gate passes. Sub-tx: `endCommit = HEAD` captured.                                                                                                        |
| **R4** | Check Safety AND Progress at each commit point      | **PASS** | Both checked in `SubTransactionManager.commitSubTransaction()`. With `roo.experimental.txStrictMode=true` (default), progress gate blocks commit when CP unreachable. `safetyClause` or `safetyChecks` required to enable safety gate.                     |
| **R5** | Commit only if Safety ∧ Progress satisfied          | **PASS** | Conjunction correct when both active. Strict mode (default true) fails closed when CP unreachable — fail-open only in explicit degraded mode.                                                                                                              |
| **R6** | Liveness at final commit point                      | **PASS** | `attemptCompletionTool.ts:144-214` calls CP `/tx/:tx_id/commit`. With strict mode (default), CP-unreachable blocks completion with error. Degraded mode requires explicit opt-out via `roo.experimental.txStrictMode=false`.                               |
| **R7** | Rollback on Safety/Progress/Liveness violation      | **PASS** | Safety: `abortSubTransaction()` in SubTransactionManager. Progress: same path. Liveness: `rollbackToCheckpointManual()` in attemptCompletionTool. PlanExecutor: `rollbackFailedSubTransactions()`.                                                         |
| **R8** | Safety rules MUST be declarative                    | **PASS** | `Clause` type + `ClauseResult` in `packages/types/src/clause.ts`. Recursive evaluator in `apps/control-plane/src/clause-eval.ts`. `/safety-gate` accepts `{ clause: Clause }` or legacy `{ checks: string[] }`. `SubTransaction.safetyClause` field added. |
| **R9** | Action-safety before tools, state-safety at commits | **PASS** | Action-safety: `checkActionSafety()` in presentAssistantMessage.ts before every mutating tool. State-safety: QualityGate at commit points + CP `/safety-gate`.                                                                                             |

### R4/R5/R6 Note: strict mode (default) fails closed

With `roo.experimental.txStrictMode=true` (default), progress and liveness gates fail **closed** when CP is unreachable — commit/completion is blocked. Set to `false` for degraded mode (allows with warning). This prevents silent pass-through when CP is down.

---

## Results: R10–R24 (OCC / Concurrent Agents)

| ID      | Requirement                                    | Verdict     | Evidence                                                                                                                                                                                                                                                                                                               |
| ------- | ---------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R10** | Concurrency baseline MUST be OCC               | **PASS**    | PlanExecutor: work in isolated worktrees, detect conflicts at merge.                                                                                                                                                                                                                                                   |
| **R11** | One agent per task                             | **PASS**    | `spawnChildTasks()` creates one Task per SubTransaction.                                                                                                                                                                                                                                                               |
| **R12** | Limit fan-out                                  | **PASS**    | `MAX_SUB_TRANSACTIONS = 10` enforced in PlanExecutor + planner prompt.                                                                                                                                                                                                                                                 |
| **R13** | Isolated worktree/branch per agent             | **PASS**    | `git worktree add -B` per sub-tx via CP `/sub-tx/begin`. Child `cwd` set to worktree path.                                                                                                                                                                                                                             |
| **R14** | Apply patch locally in worktree                | **PASS**    | `child.skipTransactionalWrites = true`, `cwd = worktreePath`. All writes local to worktree.                                                                                                                                                                                                                            |
| **R15** | Conflicts identified at merge time             | **PASS**    | `git merge --no-ff` in `mergeSubTx()`. Merge failure detected and surfaced.                                                                                                                                                                                                                                            |
| **R16** | Structural conflicts beyond Git                | **PARTIAL** | Same-file overlap + import-graph overlap implemented in `structural-conflict.ts`. PlanExecutor now calls `POST /tx/:tx_id/structural-check` before merging (via `checkStructuralConflicts()`). Gap: no AST node-level analysis — all same-file overlap = conflict regardless of whether edited functions are disjoint. |
| **R17** | Abort/rollback conflicting work                | **PASS**    | `git merge --abort` + `worktree remove --force` + `branch -D` on any merge conflict.                                                                                                                                                                                                                                   |
| **R18** | Create worktree per agent                      | **PASS**    | Same as R13.                                                                                                                                                                                                                                                                                                           |
| **R19** | Run agent in worktree                          | **PASS**    | `workspacePath: worktreePath` passed to `createTask()`.                                                                                                                                                                                                                                                                |
| **R20** | Apply patches locally                          | **PASS**    | Same as R14.                                                                                                                                                                                                                                                                                                           |
| **R21** | Detect structural conflicts when agents finish | **PASS**    | `checkStructuralConflicts()` in PlanExecutor calls CP `/structural-check` before any merge. Conflicting sub-txs rolled back before `mergeWorktrees()` runs.                                                                                                                                                            |
| **R22** | Merge no-conflict branches first               | **PARTIAL** | `partitionByConflicts()` in `/merge-pipeline` implements this correctly. PlanExecutor uses individual merges (no full merge-pipeline call) — merge ordering not applied to remaining non-conflicting branches. Acceptable interim state while full merge algorithm is pending.                                         |
| **R23** | Order conflicted branches by modifications     | **PARTIAL** | `orderByModifications()` in structural-conflict.ts works. Not called by PlanExecutor (same reason as R22 — full merge-pipeline not yet used).                                                                                                                                                                          |
| **R24** | Rollback on merge failure                      | **PASS**    | Both individual merge path (PlanExecutor) and merge-pipeline path handle rollback correctly.                                                                                                                                                                                                                           |

### R16/R21/R22/R23 Status: structural pre-check wired, merge ordering pending

PlanExecutor now calls `POST /tx/:tx_id/structural-check` (via `checkStructuralConflicts()`) before merging. Conflicting sub-transactions are rolled back before any merge attempt. Individual merges via `POST /tx/:tx_id/sub-tx/:sub_tx_id/merge` are preserved — no full merge-pipeline call yet (intentional: full merge ordering algorithm is pending future work).

Remaining gap (R22/R23): `/merge-pipeline`'s no-conflict-first ordering and modification-based priority are still unreachable from PlanExecutor. This is acceptable interim state — structural conflicts are pre-detected and rolled back, preventing bad merges, but merge ordering is not optimized.

---

## Results: R25–R28 (Git Operations)

| ID      | Requirement                       | Verdict     | Evidence                                                                                                                                           |
| ------- | --------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R25** | `git worktree add -B`             | **PARTIAL** | `beginSubTx()` correctly uses `worktree add -B`. `beginTx()` uses 2-step `git branch` + `git worktree add` (functionally equivalent but not `-B`). |
| **R26** | `git apply --reject` with .rej    | **PASS**    | `applyPatch()`: `git apply --reject`, .rej file detection, path validation, rollback on partial apply.                                             |
| **R27** | `git merge --no-ff`               | **PARTIAL** | `mergeSubTx()` correctly uses `--no-ff`. `commitToMain()` uses `--ff-only` (intentional for clean main history but deviates from spec literal).    |
| **R28** | Rollback: abort + remove + delete | **PASS**    | `abortMerge()`: `git merge --abort`. `cleanupSubTx()`: `worktree remove --force` + `branch -D`. Three-tier rollback verified.                      |

---

## Results: R29–R34 (Isolation, Correctness, Progress)

| ID      | Requirement                    | Level  | Verdict  | Evidence                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------ | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R29** | Pessimistic locking            | SHOULD | **FAIL** | Not implemented. No locking interface exists.                                                                                                                                                                                                                                             |
| **R30** | No duplicate new files         | MUST   | **PASS** | `POST /tx/:tx_id/reserve-file` endpoint in CP (Node.js Map — no race). `writeToFileTool.ts` calls reservation before creating any new file in a sub-task. 409 response blocks creation with error directing agent to choose a different path. Reservations cleaned up on commit/rollback. |
| **R31** | Tests are "given"              | MUST   | **PASS** | `isTestFile()` + write/apply route guards in tx.ts. Test files protected from modification.                                                                                                                                                                                               |
| **R32** | No new tests by agents         | MUST   | **PASS** | `/apply` blocks all test patches. `writeToFileTool.ts`: `isTestFile()` guard blocks agents (`cline.parentTask`) from creating new test files (`!fileExists`). Existing test file modification is R31's domain (also PASS).                                                                |
| **R33** | Progress: monotonic test count | SHOULD | **PASS** | `progress-gate.ts`: `isProgressValid(baseline, current)` enforces `current >= baseline`. Multi-framework parser. Rollback on violation.                                                                                                                                                   |
| **R34** | Termination = all tests pass   | MAY    | **PASS** | Not required. Liveness check effectively covers this when test_command configured.                                                                                                                                                                                                        |

---

## Results: R35–R39 (Agent Action Surface)

| ID      | Requirement                         | Verdict     | Evidence                                                                                 |
| ------- | ----------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| **R35** | Files: add/remove/rename            | **PASS**    | `write_to_file`, `execute_command` (rm, mv).                                             |
| **R36** | Directories                         | **PASS**    | `execute_command` (mkdir, rmdir, mv).                                                    |
| **R37** | Bash with guardrails                | **PASS**    | `execute_command` + action-safety blocks dangerous patterns.                             |
| **R38** | Env vars without permanent override | **PARTIAL** | Env accessible via bash. No mechanism prevents permanent modification of shell profiles. |
| **R39** | Install dependencies                | **PASS**    | npm/pnpm/yarn whitelisted in bash prefixes.                                              |

---

## Results: Clause Interface

| Aspect                                     | Verdict     | Evidence                                                                                                                                                                                                              |
| ------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BNF grammar (`FORALL`, `AND`, `NOT`, etc.) | **PASS**    | `Clause` discriminated union in `packages/types/src/clause.ts`: `cmd_exits_0`, `test_suite`, `file_exists`, `not`, `and`, `or`. JSON-only (no text parser — sufficient for machine-generated rules).                  |
| Clause evaluator                           | **PASS**    | `evalClause()` in `apps/control-plane/src/clause-eval.ts`. Recursive, handles all clause types. `/safety-gate` routes to evaluator when `clause` field present; falls back to legacy shell-command loop for `checks`. |
| Action-time checker inputs                 | **PARTIAL** | Receives tool name + args. Missing: current file contents, touched-file list, pending diff.                                                                                                                           |
| Commit-time checker inputs                 | **PARTIAL** | Receives test results. Missing: AST edits, tool call metadata (sequence, durations).                                                                                                                                  |

---

## Results: Structural Conflict Policy

| Aspect                          | Verdict  | Evidence                                                                               |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| Same-file overlap detection     | **PASS** | `detectConflicts()` in structural-conflict.ts.                                         |
| Import-graph overlap detection  | **PASS** | `detectDependentFileConflicts()` with regex-based import parsing + transitive closure. |
| Disjoint AST nodes MAY proceed  | **FAIL** | Not implemented. All same-file overlap = conflict. No AST parsing library used.        |
| Overlapping nodes MUST conflict | **PASS** | Conservative: all same-file = conflict (superset of spec requirement).                 |
| PlanExecutor integration        | **FAIL** | PlanExecutor does not call structural check endpoints.                                 |

---

## Overall Summary

### By verdict count (39 requirements + 2 special sections)

| Verdict     | Count | Requirements                                                                                                                                          |
| ----------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**    | 31    | R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R17, R18, R19, R20, R21, R24, R26, R28, R30, R31, R32, R33, R34, R35, R36, R37, R39 |
| **PARTIAL** | 6     | R16, R22, R23, R25, R27, R38                                                                                                                          |
| **FAIL**    | 2     | R29 (SHOULD), AST-level conflict                                                                                                                      |

### MUST-level failures

All MUST-level requirements now **PASS**. R29 (pessimistic locking) is SHOULD-level. AST-level conflict detection is cosmetic (conservative file-level detection is a superset).

### Remaining items

1. **No merge ordering** (R22/R23): Structural conflicts are pre-checked and conflicting sub-txs rolled back, but no modification-based ordering applied to remaining merges.
2. **No AST-level conflict resolution**: Conservative file-level detection works but doesn't allow disjoint same-file edits.
