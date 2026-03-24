# Architecture

This repository implements an **agentic transaction system**: a non-deterministic LLM-driven “agent runtime” is **sandboxed and governed** by a **deterministic control plane** that enforces safety/progress/liveness at transactional boundaries.

The end result is “**transactions for agents**”:

- Agents can propose and apply changes
- Commits are **gated**
- Failures trigger **rollback**
- Parallel work is **conflict-checked**

---

## Repo map

### Runtime cores

- `src/` — core agent runtime (LLM loop, tools, checkpoints)
- `apps/` — apps, including the deterministic **control-plane** service
- `packages/` — shared libraries/types (monorepo)
- `locales/` — i18n strings used by runtime/UI
- `.roo/` — runtime modes/config (agent behavior configuration)

### UI

- `webview-ui/` — React UI for the VS Code extension webview
- `src/core/webview/` — VS Code webview provider and UI bridge

### Docs (important)

Specifications live under `docs/` (e.g. `docs/transaction_agents_spec.md`, `docs/CHECKPOINTING.md`). These describe rules like R6/R8/R31/R32/R33 referenced by the code.

---

## High-level architecture

There are three layers:

1. **User Interface (VS Code)**

- Captures user intent
- Starts/controls tasks
- Displays agent output / diffs / approvals

2. **Agent Runtime (LLM-driven, non-deterministic)**

- Prompts the model
- Parses tool calls
- Applies diffs / runs commands
- Wraps actions in **sub-transactions** (checkpoints)

3. **Deterministic Control Plane (“Orchestrator”)**

- Pure code (not an LLM)
- Owns the rules for:
    - action safety
    - progress gating
    - liveness checks
    - git isolation + rollback
    - conflict detection
- Decides whether a checkpoint can be committed

---

## Key components and where they live

### VS Code Extension bootstrap

- `src/extension.ts`
    - Extension entrypoint
    - Initializes services
    - Wires commands and providers
    - Boots the runtime and connects to control-plane

### Webview UI bridge

- `src/core/webview/ClineProvider.ts`
    - The UI controller
    - Creates `Task` instances from user requests
    - Maintains UI/task lifecycle state

### Agent runtime (“the brain loop”)

- `src/core/task/Task.ts`
    - Main task executor (LLM prompting, message loop, tool orchestration)
    - Where model outputs become actions
    - Integrates sub-transaction boundaries so the agent can act, but only commit safely

### Transaction wrapper / checkpoint manager

- `src/core/checkpoints/SubTransactionManager.ts`
    - Creates sub-transactions (checkpoints)
    - Requests safety-gate evaluation from control-plane
    - Commits or aborts
    - Rollbacks to previous commit when needed

### Deterministic control plane (HTTP service)

Located under `apps/control-plane/` (paths below):

- `apps/control-plane/src/server.ts`

    - Fastify server entrypoint
    - Registers transaction/git/shell/version routes
    - Initializes DB + allowlists

- `apps/control-plane/src/routes/tx.ts`

    - Transaction endpoints (start sub-tx, safety-gate, commit/abort)
    - Enforces “tests are given” restrictions (R31/R32)

- `apps/control-plane/src/action-safety.ts` (Rule R6)

    - Pre-execution action safety:
        - file writes/deletes
        - command allow/deny patterns
        - network request restrictions
    - Returns allow/deny + reason

- `apps/control-plane/src/progress-gate.ts` (Rule R33)

    - Progress check at commit boundary:
        - runs test command
        - parses pass/fail counts
        - enforces monotonic improvement (don’t get worse)

- `apps/control-plane/src/liveness.ts` (Rule R8)

    - Final “done” gate:
        - verifies task completion criteria
        - ensures required tests pass at FINAL checkpoint

- `apps/control-plane/src/structural-conflict.ts` (Rules R16/R22/R23)

    - Structural/AST-ish conflict detection for parallel work
    - Detects overlapping edits and dependency/import graph conflicts

- `apps/control-plane/src/git.ts`
    - Git primitives:
        - worktree creation/isolation
        - patch apply
        - commit/merge/abort
        - safe-path validation
    - Core rollback mechanism

### Persistence / DB layer

- `apps/control-plane/src/db.ts` (or similar)
- `apps/control-plane/src/store.ts` (or similar)
    - Stores transactions, sub-transactions, safety-gate results, progress baselines, etc.
    - Enables auditability and crash recovery

> Note: if exact DB/store paths differ, search for `createTransaction`, `subTransaction`, `safetyGate`, `progressGate`, or the route handlers in `apps/control-plane/src/routes`.

---

## Transaction model (how “checkpoints” work)

A task is executed as a series of **sub-transactions**:

`Start → C1 → C2 → ... → FINAL`

Where each `Ci` is a **consistent checkpoint** (often a Git commit in an isolated worktree).

### Lifecycle

1. Agent runtime begins work in a sub-tx (creates a checkpoint base commit)
2. Agent applies changes (diffs, edits, commands)
3. Runtime calls control-plane safety gate
4. If approved:
    - commit is recorded as `Ci`
5. If denied or something fails:
    - abort sub-tx
    - rollback to `C(i-1)` (previous safe state)
    - retry or change strategy

This matches the “transactions on agents” approach: **allow agent exploration, but gate state transitions**.

---

## Safety / progress / liveness semantics

### Safety (pre-execution + commit gating)

- **Pre-execution**: `action-safety.ts` blocks dangerous actions before they run
- **At commit**: transaction routes + safety gate decide if the checkpoint is admissible

**Test file protection (R31/R32)**:

- Agents cannot modify tests unless explicitly allowed
- Enforced in transaction routing/gating (`routes/tx.ts`)

### Progress (monotonic improvement)

- `progress-gate.ts` ensures the repo state isn’t getting worse across commits
- Typical policy: passing test count should not decrease

### Liveness (final correctness)

- `liveness.ts` runs at FINAL only
- Ensures end-state meets completion criteria (tests pass, required steps done)

---

## Concurrency model

The system supports parallelism by isolating work and validating merges:

- Isolation via **Git worktrees** (`apps/control-plane/src/git.ts`)
- Conflict detection beyond plain text merges (`structural-conflict.ts`)
- Orchestrator orders/accepts merges only when conflicts are ruled out

---

## End-to-end flow (user request → safe commit)

1. User issues request in VS Code UI  
   → `ClineProvider.ts` creates a `Task`

2. `Task.ts` prompts the model and parses tool calls

3. Actions are executed within a sub-transaction  
   → `SubTransactionManager.ts` creates checkpoint state

4. Diffs/changes are applied in an isolated worktree  
   → Git ops in `apps/control-plane/src/git.ts`

5. Control plane evaluates safety/progress/liveness gates  
   → `action-safety.ts`, `routes/tx.ts`, `progress-gate.ts`, `liveness.ts`

6. If approved, checkpoint commits; otherwise rollback and retry

---

## Practical notes for contributors

### If Copilot / tools hallucinate repo structure

- Keep `.copilotignore` up to date to exclude:
    - `node_modules/`, `dist/`, WAL/DB artifacts, logs, build outputs
- Prefer “grounded” prompts:
    - “List files + quote code + cite paths” over “explain the repo”

### Where to start reading code

Recommended reading order:

1. `src/extension.ts`
2. `src/core/webview/ClineProvider.ts`
3. `src/core/task/Task.ts`
4. `src/core/checkpoints/SubTransactionManager.ts`
5. `apps/control-plane/src/server.ts`
6. `apps/control-plane/src/routes/tx.ts`
7. `apps/control-plane/src/action-safety.ts`
8. `apps/control-plane/src/git.ts`
9. `apps/control-plane/src/progress-gate.ts`
10. `apps/control-plane/src/liveness.ts`
11. `apps/control-plane/src/structural-conflict.ts`

---

## Glossary

- **Agent runtime**: LLM-driven logic that proposes actions
- **Control plane / orchestrator**: deterministic enforcement layer
- **Sub-transaction**: a bounded unit of work with a checkpoint commit/rollback
- **Safety gate**: rule evaluation that decides if a checkpoint can be committed
- **Progress gate**: ensures monotonic improvement (e.g., tests)
- **Liveness**: final correctness check at the end of the task
- **Worktree isolation**: per-agent/per-subtask git sandboxing for safe experimentation
