# Transaction Agents Specification - Complete Reference

**Source**: Transaction_Agents_RunningPPT (1).pptx  
**Version**: 1.0  
**Status**: Normative  
**Purpose**: Complete specification for building transactional agentic programming system on top of Roo-Code

---

## Table of Contents

1. [Problem Statement](#0-problem-statement)
2. [Task as Fundamental Unit](#1-task-as-fundamental-unit)
3. [Explicit State Model](#2-explicit-state-model)
4. [Checkpoints / Commit Points](#3-checkpoints--commit-points)
5. [Sub-Transactions](#4-sub-transactions)
6. [Rollback Semantics](#5-rollback-semantics)
7. [Safety Model](#6-safety-model)
8. [Planner Agent](#7-planner-agent)
9. [Concurrency Model](#8-concurrency-model)
10. [Multi-Agent Execution](#9-multi-agent-execution)
11. [History, Auditability, and Replay](#10-history-auditability-and-replay)
12. [Evaluation Criteria](#11-evaluation-criteria)
13. [Detailed Requirements (R1-R39)](#detailed-requirements-r1-r39)

---

## 0. Problem Statement

The system addresses this problem:

> **How can multiple autonomous LLM agents modify a shared codebase safely, efficiently, and scalably, while supporting partial failure, rollback, and parallelism?**

The system must:

- Support agent autonomy
- Support rollback and recovery
- Support parallelism without corruption
- Be auditable, explainable, and reproducible

---

## 1. Task as Fundamental Unit (REQUIRED)

### Definition

- A **task** is the top-level unit of execution.
- A task corresponds to one user intent (e.g., "add feature X").

### Requirements

Each task has:

- a start
- an execution history
- a termination condition (success / abort)

**All actions, agents, and state changes are scoped to exactly one task.**

### Rationale

This defines the transaction boundary for reasoning, evaluation, and rollback.

---

## 2. Explicit State Model (REQUIRED)

The system MUST define and maintain two **disjoint** classes of state.

### 2.1 System State

**Includes:**
- Files
- Repository contents
- Build artifacts
- Any state that affects program execution

**Properties:**
- Must be snapshot-able
- Must be restorable exactly
- Must be deterministic

### 2.2 Agent State

**Includes:**
- LLM conversation history
- Tool call history
- Planner decisions
- Intermediate reasoning traces

**Properties:**
- Must persist across rollback
- Must be inspectable
- Must be replayable

### Rollback Rule (Hard Requirement)

**Rollback affects system state only. Agent state is never implicitly erased.**

This separation is non-negotiable for correctness and analysis.

---

## 3. Checkpoints / Commit Points (REQUIRED)

### Definition

A **checkpoint** is a stable snapshot of system state.

### Requirements

**Checkpoints:**
- are explicitly created
- are immutable
- are uniquely identifiable

**Rollback:**
- can occur only to checkpoints
- restores system state exactly
- removes all effects after the checkpoint

### Properties

- Checkpoints represent safe states
- All progress is measured between checkpoints

---

## 4. Sub-Transactions (REQUIRED SEMANTICS)

### Definition

A **sub-transaction** is a logical unit of work inside a task.

**Formally:**
> A sub-transaction is a contiguous interval between two checkpoints whose effects must be committed or rolled back atomically.

### Requirements

Each sub-transaction has:

- a start checkpoint
- an end checkpoint
- a status (committed / aborted)

The system can:

- abort a sub-transaction
- preserve earlier committed sub-transactions
- retry or skip failed sub-transactions

### Important Constraint

Sub-transactions are **semantic groupings**, not infrastructure primitives.

They may span:
- multiple tool calls
- multiple checkpoints
- multiple agent actions

---

## 5. Rollback Semantics (REQUIRED)

**On sub-transaction failure:**

- System state MUST be rolled back to the sub-transaction's start checkpoint.
- No partial effects may remain.
- Earlier committed sub-transactions MUST remain intact.

**Rollback must be:**
- deterministic
- idempotent
- cheap enough to use frequently

### Explicit Non-Requirements

- Compensating actions are optional
- Forward recovery is not required in the code domain

---

## 6. Safety Model (REQUIRED)

### Safety Definition

Safety is defined over **states**, not individual actions.

### Requirements

**Safety checks MUST be evaluated:**
- at commit points
- at sub-transaction boundaries

**Safety checks MAY include:**
- tests
- builds
- linters
- static analyzers
- custom predicates

### Safety Policy

- Detect-and-mitigate is preferred over prevent-only.
- Human intervention is optional, not mandatory.

### Formal Requirement

**A sub-transaction may be committed iff all safety predicates pass.**

---

## 7. Planner Agent (REQUIRED INTERFACE)

### Planner Role

The planner defines **intent and structure**, not execution mechanics.

### Requirements

- **Planner runs once per task.**
- Planner outputs a structured plan containing:
  - ordered sub-transactions
  - actions per sub-transaction
  - dependency relations
  - optional safety checks

### Constraints

**Planner output must be:**
- machine-readable
- auditable
- deterministic given the same input (up to LLM variance)

### Non-Requirement

- Planner intelligence or optimality is not required
- Planner errors must be recoverable via rollback

---

## 8. Concurrency Model (REQUIRED CHOICE)

The system MUST explicitly choose one concurrency design.

### Design Category 1: Optimistic Concurrency (Preferred)

**Properties:**
- Agents execute in isolated environments (forks/worktrees/clones).
- No shared mutable system state during execution.
- Conflicts are detected:
  - at merge time
  - at validation time
- Failed merges result in rollback.

### Correctness Requirement

**The final committed system state MUST correspond to some serial execution of sub-transactions.**

This is **view serializability**, not strict serial execution.

---

## 9. Multi-Agent Execution (OPTIONAL BUT EXPECTED FOR TOP TIER)

If multi-agent execution is enabled, the system SHOULD:

- Execute independent sub-transactions in parallel.
- Enforce dependency constraints.
- Serialize commits.
- Allow independent failure and rollback.

### Non-Requirements

- Pessimistic locking
- CRDTs
- AST-level merging

---

## 10. History, Auditability, and Replay (REQUIRED FOR RESEARCH)

The system MUST provide:

- Full agent execution history
- Full checkpoint history
- Diffs for committed and rolled-back sub-transactions
- Ability to answer:
  - what happened
  - why it failed
  - what was undone
  - what was preserved

**This is critical for:**
- evaluation
- debugging
- scientific reproducibility

---

## 11. Evaluation Criteria (REQUIRED FOR ICML / NeurIPS)

A finished system MUST be able to demonstrate:

### Functional Correctness

- No corruption under parallel execution
- Deterministic rollback
- Safety preservation

### Empirical Metrics

- Task success rate
- Rollback frequency
- Cost of rollback
- Parallel speedup vs serial
- Failure recovery effectiveness

### Comparative Baselines

- Serial agent execution
- No-rollback systems
- Lock-based approaches (where applicable)

---

## 12. Explicit Non-Goals (Important)

The system is **not required** to:

- Prove formal correctness
- Use CRDTs
- Prevent all failures
- Be fully autonomous
- Be optimal

**Failure is expected. Recovery is the contribution.**

---

## Detailed Requirements (R1-R39)

### Terminology

- **MUST**: Absolute requirement
- **SHOULD**: Recommended but not mandatory
- **MAY**: Optional

---

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

---

## Implementation Notes

### Why Planner Mode is Required

The spec **REQUIRES** a Planner Agent (Section 7) that:
- Runs once per task
- Generates structured plans with sub-transactions
- Defines dependencies and safety checks

**This is NOT optional** - it's a core requirement of the spec.

### Why Workarounds Are Necessary

When implementing the spec on top of Roo-Code with OpenAI models:

1. **Planner mode creates subtasks** (required by spec)
2. **OpenAI models default to function-call syntax** (training bias)
3. **Workarounds needed** to make OpenAI models follow XML format:
   - Function-call to XML converter (safety net)
   - Enhanced prompts with explicit XML examples (primary fix)
   - Tool usage instructions in subtask prompts

**These are NOT overcomplications** - they're necessary to make the spec work with OpenAI models while keeping Roo-Code's base functionality intact.

---

## Current Implementation Status

See `SPEC_COMPLIANCE_REAUDIT.md` for detailed compliance status (92.3% compliant).

**Key Points:**
- Planner mode is implemented and working
- All MUST requirements (R1-R28, R30-R39) are met
- R9 (action-safety separation) is partially documented
- R30 (prevent same new file) is detected but not prevented proactively

---

**Last Updated**: January 2026
