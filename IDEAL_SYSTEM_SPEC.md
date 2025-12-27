# Ideal System Specification

## Transactional, Agentic Programming System (Research-Grade)

## 0. Problem Statement (Implicit Requirement)

The system addresses this problem:

> How can multiple autonomous LLM agents modify a shared codebase safely, efficiently, and scalably, while supporting partial failure, rollback, and parallelism?

The system must:

- Support agent autonomy
- Support rollback and recovery
- Support parallelism without corruption
- Be auditable, explainable, and reproducible

## 1. Task as the Fundamental Unit (REQUIRED)

### Definition

- A task is the top-level unit of execution.
- A task corresponds to one user intent (e.g., "add feature X").

### Requirements

Each task has:

- a start
- an execution history
- a termination condition (success / abort)

All actions, agents, and state changes are scoped to exactly one task.

### Rationale

This defines the transaction boundary for reasoning, evaluation, and rollback.

## 2. Explicit State Model (REQUIRED)

The system MUST define and maintain two disjoint classes of state.

### 2.1 System State

Includes:

- Files
- Repository contents
- Build artifacts
- Any state that affects program execution

Properties:

- Must be snapshot-able
- Must be restorable exactly
- Must be deterministic

### 2.2 Agent State

Includes:

- LLM conversation history
- Tool call history
- Planner decisions
- Intermediate reasoning traces

Properties:

- Must persist across rollback
- Must be inspectable
- Must be replayable

### Rollback Rule (Hard Requirement)

Rollback affects system state only. Agent state is never implicitly erased.

This separation is non-negotiable for correctness and analysis.

## 3. Checkpoints / Commit Points (REQUIRED)

### Definition

A checkpoint is a stable snapshot of system state.

### Requirements

Checkpoints:

- are explicitly created
- are immutable
- are uniquely identifiable

Rollback:

- can occur only to checkpoints
- restores system state exactly
- removes all effects after the checkpoint

### Properties

- Checkpoints represent safe states
- All progress is measured between checkpoints

## 4. Sub-Transactions (REQUIRED SEMANTICS)

### Definition

A sub-transaction is a logical unit of work inside a task.

Formally:

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

Sub-transactions are semantic groupings, not infrastructure primitives.
They may span:

- multiple tool calls
- multiple checkpoints
- multiple agent actions

## 5. Rollback Semantics (REQUIRED)

On sub-transaction failure:

- System state MUST be rolled back to the sub-transaction's start checkpoint.
- No partial effects may remain.
- Earlier committed sub-transactions MUST remain intact.

Rollback must be:

- deterministic
- idempotent
- cheap enough to use frequently

### Explicit Non-Requirements

- Compensating actions are optional
- Forward recovery is not required in the code domain

## 6. Safety Model (REQUIRED)

### Safety Definition

Safety is defined over states, not individual actions.

### Requirements

Safety checks MUST be evaluated:

- at commit points
- at sub-transaction boundaries

Safety checks MAY include:

- tests
- builds
- linters
- static analyzers
- custom predicates

### Safety Policy

- Detect-and-mitigate is preferred over prevent-only.
- Human intervention is optional, not mandatory.

### Formal Requirement

A sub-transaction may be committed iff all safety predicates pass.

## 7. Planner Agent (REQUIRED INTERFACE)

### Planner Role

The planner defines intent and structure, not execution mechanics.

### Requirements

- Planner runs once per task.
- Planner outputs a structured plan containing:
    - ordered sub-transactions
    - actions per sub-transaction
    - dependency relations
    - optional safety checks

### Constraints

Planner output must be:

- machine-readable
- auditable
- deterministic given the same input (up to LLM variance)

### Non-Requirement

- Planner intelligence or optimality is not required
- Planner errors must be recoverable via rollback

## 8. Concurrency Model (REQUIRED CHOICE)

The system MUST explicitly choose one concurrency design.

### Design Category 1: Optimistic Concurrency (Preferred)

Properties:

- Agents execute in isolated environments (forks/worktrees/clones).
- No shared mutable system state during execution.
- Conflicts are detected:
    - at merge time
    - at validation time
- Failed merges result in rollback.

### Correctness Requirement

The final committed system state MUST correspond to some serial execution of sub-transactions.

This is view serializability, not strict serial execution.

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

This is critical for:

- evaluation
- debugging
- scientific reproducibility

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

## 12. Explicit Non-Goals (Important)

The system is not required to:

- Prove formal correctness
- Use CRDTs
- Prevent all failures
- Be fully autonomous
- Be optimal

**Failure is expected. Recovery is the contribution.**
