# Roo Control-Plane (Fastify)

Local daemon that runs every agent task inside a git-worktree **transaction**
and gates file writes, shell commands, merges and the final commit.

## Run

```
pnpm -C apps/control-plane run dev:oneshot --repo /path/to/workspace --port 0 --disableMcp \
    [--test-command "pnpm test"] [--test-timeout-ms 300000] [--db postgresql://...]
```

- Without `--db`, state is kept in SQLite at `<repo>/.cp/db.sqlite`; `--disableDb` keeps it in memory.
- `--test-command` (or `CP_TEST_COMMAND`) is the default progress / liveness test command for
  transactions that do not pass their own.
- `--test-modify-allowlist` (or `CP_TEST_MODIFY_ALLOWLIST`) lists test files the agent may create or change,
  as comma-separated paths or globs relative to the repository (`tests/test_new.py,tests/gen/**`). Empty by
  default: tests are "given". It is read once at start-up, so the agent cannot change it.
- `CP_UNKNOWN_ACTION_POLICY=allow` relaxes action-safety for unrecognised actions (default: deny).
- `.cp/` is added to `.git/info/exclude` automatically.
- OpenAPI UI: `/docs`. (The MCP endpoint is not implemented; `mcp.ts` is a stub.)

## Contract (api 2)

All requests send `Content-Type: application/json` and `X-Actor-Id`. Errors are
`{ code, message, ...details }` with: 400 `VALIDATION_ERROR`, 404 `TX_NOT_FOUND` /
`SUB_TX_NOT_FOUND`, 403 policy blocks, 409 conflicts, 412 missing configuration,
422/501 replay limits. Sub-tx ids may be relative (`agent-a`) or global
(`<tx>:agent-a`); `<tx>_sub_<rel>` addresses a sub-tx worktree directly on
`/checkpoint`, `/rollback` and `/shell/exec`.

| Route                                  | Body                                                                                   | Success                                                                                                     | Errors                                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                          | –                                                                                      | `{status, version, api: 2, capabilities[], db, test_command_configured}`                                    | –                                                                                                                                                                  |
| `POST /tx/begin`                       | `{isolation?="hybrid", base?="HEAD", target_branch?, test_command?, compile_command?}` | `{tx_id, base_commit, branch, target_branch, worktree_path, progress_baseline?}`                            | 400 detached HEAD / unknown branch / `TEST_COMMAND_INVALID`                                                                                                        |
| `GET /tx/:id`                          | –                                                                                      | `{status: active\|committed\|aborted, worktree_path?, base_commit, head_commit?, target_branch, isolation}` | 404                                                                                                                                                                |
| `POST /tx/:id/abort`                   | `{reason?}`                                                                            | `{aborted, sub_txs_removed[], processes_killed}` (idempotent)                                               | –                                                                                                                                                                  |
| `POST /tx/:id/checkpoint`              | `{reason, trailers?}`                                                                  | 201 `{commit_sha, tag, progress?}`                                                                          | 403 `PROGRESS_VIOLATION {kind: tests\|compile, rollback_to, backup_ref}`                                                                                           |
| `POST /tx/:id/commit`                  | `{strategy?, test_command?, require_liveness?, required_steps?, completed_steps?}`     | `{merged_sha, target_branch, strategy, liveness: {ran, passed?, reason?}}`                                  | 403 `LIVENESS_FAILED {rollback_to, backup_ref}`; 409 `CONFLICT_BASE_ADVANCED` / `REBASE_CONFLICT` / `WORKSPACE_DIRTY` (tx stays open); 412 `LIVENESS_UNCONFIGURED` |
| `POST /tx/:id/rollback`                | `{hash}` (must be in the tx history)                                                   | `{rolled_back_to, backup_ref, files_affected, bytes_rolled_back, processes_killed}`                         | 400                                                                                                                                                                |
| `POST /tx/:id/sub-tx/:sid/begin`       | `{base?, title?, description?, agentType?, prompt?, dependsOn?, safetyChecks?}`        | `{worktree_path, sub_tx_id, relative_id, base_commit}`                                                      | 400                                                                                                                                                                |
| `POST /tx/:id/sub-tx/:sid/safety-gate` | `{checks?: string[], clause?: Clause}` (both are evaluated)                            | `{ok, results[], clause_results?, failedAt?, reason?, error?}`                                              | 400 malformed clause, 404                                                                                                                                          |
| `POST /tx/:id/merge-pipeline`          | `{sub_tx_ids, depends_on?, require_safety_gate?}`                                      | `{success, merged_ids, rolled_back_ids, failed_ids, order, conflicts, dismissed_by_ast, results[]}`         | 400 cycle, 404 unknown ids                                                                                                                                         |
| `POST /tx/:id/sub-tx/:sid/merge`       | `{safetyGate?, hasSafetyChecks?, forceMerge?}`                                         | `{merged, sub_tx_id, merge_commit}`                                                                         | 409 `STRUCTURAL_CONFLICT` / `MERGE_CONFLICT` / `DEPENDENCY_NOT_MET`; 403 safety                                                                                    |
| `POST /tx/:id/sub-tx/:sid/rollback`    | `{reason?, failureKind?}`                                                              | `{rolled_back, bytes_rolled_back}` (idempotent)                                                             | –                                                                                                                                                                  |
| `POST /tx/:id/structural-check`        | `{sub_tx_ids}`                                                                         | `{hasConflicts, sameFileConflicts, dependentFileConflicts, dismissedByAst, snapshots}`                      | 404                                                                                                                                                                |
| `POST /tx/:id/action-safety`           | `{action: <Roo tool name>, args: {path?, paths?, command?, cwd_rel?}, sub_tx_id?}`     | `{allowed: true, normalized_paths?}`                                                                        | 403 `ACTION_BLOCKED {reason, rule}`                                                                                                                                |
| `POST /tx/:id/reserve-file`            | `{file_path, claimer_id}`                                                              | `{reserved, file_path, by}`                                                                                 | 409 `FILE_ALREADY_RESERVED` / `FILE_EXISTS`                                                                                                                        |
| `POST /shell/exec/:id`                 | `{command, shell?, cwd_rel?, timeout_ms?, env?}` (legacy `{cmd, args}`)                | `{exit_code, timed_out, stdout_base64, stderr_base64}`                                                      | 403 `ACTION_BLOCKED` / `TEST_FILE_PROTECTED`, 400                                                                                                                  |
| `POST /tx/:id/replay`                  | `{from_checkpoint, tool_calls? \| source: "log", allow_partial?, dry_run?}`            | `{complete, results[], final_commit, backup_ref}`                                                           | 501 `REPLAY_UNSUPPORTED`, 422 `REPLAY_PARTIAL`                                                                                                                     |
| `POST /tx/:id/metric/execution`        | `{execution_mode, sub_tx_count, total_duration_ms (Σ sub-tx), wall_clock_ms}`          | 201                                                                                                         | 503 without DB                                                                                                                                                     |
| `GET /metrics/speedup`                 | –                                                                                      | `{parallel_runs, serial_runs, estimated_speedup, measured_speedup, speedup_ratio}`                          | –                                                                                                                                                                  |

Also: `/tx/:id/apply`, `/tx/:id/write`, `/tx/:id/read`, `/tx/:id/liveness`,
`/tx/:id/tool-call(s)`, `/tx/:id/model-call(s)`, `/tx/:id/history`, `/tx/:id/plan`, `/plans`,
`/metrics/rollback`, `/git/*`, `/versions`.

## Policies

- **Structural conflicts (strict).** Within a merge batch and against sub-txs already merged into
  the parent, a later concurrent sub-tx that touches the same file, or whose files import (or are
  imported by) the other's, is rolled back, even when git could merge it. The exception: same-file
  JS/TS edits that the AST check proves touch different top-level declarations. Merge order is
  `depends_on`, then non-conflicting first, then more lines changed, then id.
- **Rollback.** Discarded work, including untracked files, is saved to `refs/cp/backup/...`
  before every reset. Ignored files (`node_modules`, `.env`) are left alone. Processes the tx
  started are killed.
- **Tests are given (R31/R32).** Test files may not be created, modified or deleted unless they
  are on the server-side `testModifyAllowlist`.
- **Replay** is file-level only. Commands and model calls are not deterministically replayable,
  and the route says so instead of pretending.
