# Transactional Agents Specification

**Version**: 1.0  
**Status**: Normative  
**Derived From**: Source-of-truth requirements for transactional agentic programming

---

## Terminology

- **MUST**: Absolute requirement
- **SHOULD**: Recommended but not mandatory
- **MAY**: Optional

---

## Requirements

### Transaction Boundaries

**R1**: Transaction boundaries MUST be pre-specified by human or agent.

**R2**: Commit points MUST occur at the end of each transaction boundary.

---

### Orchestrator Behavior

**R3**: The orchestrator MUST take a checkpoint at each commit point.

**R4**: The orchestrator MUST deterministically check Safety and Progress at each commit point.

**R5**: The orchestrator MUST commit only if Progress is satisfied.

**R6**: The orchestrator MUST check Liveness at the final commit point.

**R7**: The orchestrator MUST roll back to prior commit points if Safety, Progress, or Liveness is violated.

---

### Safety Rules

**R8**: Safety rules MUST define transaction granularity; a transaction is the set of actions between consecutive safety-rule evaluations.

**R9**: Safety MUST be split into action-safety (checked before tool calls) and state-safety (checked at commit points).

---

### Concurrency Model (Optimistic CC)

**R10**: The concurrency baseline MUST be Optimistic Concurrency Control (OCC).

**R11**: The system MUST spawn one agent per task.

**R12**: The system MUST limit fan-out.

**R13**: Each agent MUST use an isolated git worktree/branch.

**R14**: Each agent MUST apply its patch locally within its worktree.

**R15**: Conflicts MUST be identified at merge time.

**R16**: The system MUST detect structural conflicts beyond Git (AST-level and dependent files).

**R17**: The system MUST abort and rollback conflicting work.

---

### OCC Implementation Steps

**R18**: OCC implementation MUST create a worktree for each agent.

**R19**: OCC implementation MUST run the agent within its isolated worktree.

**R20**: OCC implementation MUST apply patches locally within the worktree.

**R21**: When all agents finish, the system MUST detect structural conflicts.

**R22**: The system MUST merge no-conflict branches first.

**R23**: The system MUST order conflicted branches by amount of modifications and merge them sequentially.

**R24**: If a merge fails, the system MUST rollback that branch.

---

### Required Git Operations

**R25**: Git operations MUST include `git worktree add -B` for creating isolated worktrees.

**R26**: Git operations MUST include `git apply --reject` for applying patches.

**R27**: Git operations MUST include `git merge --no-ff` for merging branches.

**R28**: Rollback MUST use `git merge --abort` + `git worktree remove --force` + `git branch -D`.

---

### Isolation Alternative (Optional)

**R29**: The system SHOULD support an optional pessimistic hierarchical locking interface over a dependency DAG (imports).

**R30**: Two agents MUST NOT create the same new file.

---

### Correctness and Progress

**R31**: Tests MUST be treated as "given" (developer-provided).

**R32**: Agents MUST NOT introduce new tests unless explicitly developer-provided.

**R33**: The progress metric MUST be: number of passing tests is monotonically non-decreasing.

**R34**: Termination condition MAY be "all tests pass".

---

### Agent Action Surface

**R35**: Agent action surface MUST include add, remove, and rename files.

**R36**: Agent action surface MUST include modify directories.

**R37**: Agent action surface MUST include run bash commands with guardrails.

**R38**: Agent action surface MUST include environment variable access without permanent override.

**R39**: Agent action surface MUST include install dependencies.

---

## Summary Table

| ID | Category | Level | Summary |
|----|----------|-------|---------|
| R1 | Boundaries | MUST | Transaction boundaries pre-specified by human/agent |
| R2 | Boundaries | MUST | Commit points at end of each transaction boundary |
| R3 | Orchestrator | MUST | Take checkpoint at each commit point |
| R4 | Orchestrator | MUST | Deterministically check Safety+Progress at commit points |
| R5 | Orchestrator | MUST | Commit only if Progress satisfied |
| R6 | Orchestrator | MUST | Check Liveness at final commit point |
| R7 | Orchestrator | MUST | Rollback if Safety/Progress/Liveness violated |
| R8 | Safety | MUST | Safety rules define transaction granularity |
| R9 | Safety | MUST | Split safety into action-safety and state-safety |
| R10 | Concurrency | MUST | Baseline is Optimistic CC |
| R11 | Concurrency | MUST | Spawn 1 agent per task |
| R12 | Concurrency | MUST | Limit fan-out |
| R13 | Concurrency | MUST | Each agent uses isolated git worktree/branch |
| R14 | Concurrency | MUST | Each agent applies patch locally |
| R15 | Concurrency | MUST | Conflicts identified at merge time |
| R16 | Concurrency | MUST | Detect structural conflicts beyond Git (AST + deps) |
| R17 | Concurrency | MUST | Abort/rollback conflicting work |
| R18 | OCC Steps | MUST | Create worktree |
| R19 | OCC Steps | MUST | Run agent in worktree |
| R20 | OCC Steps | MUST | Patch locally |
| R21 | OCC Steps | MUST | Detect structural conflicts when all finish |
| R22 | OCC Steps | MUST | Merge no-conflict branches first |
| R23 | OCC Steps | MUST | Order conflicted branches by modifications, merge sequentially |
| R24 | OCC Steps | MUST | Rollback branch if merge fails |
| R25 | Git Ops | MUST | Use `git worktree add -B` |
| R26 | Git Ops | MUST | Use `git apply --reject` |
| R27 | Git Ops | MUST | Use `git merge --no-ff` |
| R28 | Git Ops | MUST | Rollback via `git merge --abort` + `worktree remove` + `branch -D` |
| R29 | Isolation | SHOULD | Support pessimistic hierarchical locking over dependency DAG |
| R30 | Isolation | MUST | Two agents cannot create same new file |
| R31 | Progress | MUST | Tests are "given" (developer-provided) |
| R32 | Progress | MUST | Agents must not introduce new tests unless explicit |
| R33 | Progress | MUST | # passing tests monotonically non-decreasing |
| R34 | Progress | MAY | Termination = "all tests pass" |
| R35 | Actions | MUST | Add/remove/rename files |
| R36 | Actions | MUST | Modify directories |
| R37 | Actions | MUST | Run bash with guardrails |
| R38 | Actions | MUST | Env vars without permanent override |
| R39 | Actions | MUST | Install dependencies |
