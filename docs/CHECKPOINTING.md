# Transactional Checkpoint System

This document explains how to use the transactional checkpoint system in Roo Code.

## Quick Start

### 1. Enable Transactional Mode

Add this to your VS Code settings:

```json
{
	"roo.experimental.transactionalMode": true
}
```

The Control-Plane will automatically start when you open a workspace.

### 2. Manual Checkpointing

- **Save Checkpoint**: Click the save icon (💾) in the Roo sidebar
- **Rollback**: Use the command palette: `Roo: Rollback to Checkpoint`
- **Smart Rollback**: Use `Roo: Suggest Rollback` for AI-powered suggestions

### 3. Auto-Checkpointing

Auto-checkpoints are enabled by default and trigger when:

- **Bytes threshold**: 8KB of changes (configurable)
- **Files threshold**: 5 files touched (configurable)
- **Time threshold**: 90 seconds elapsed (configurable)

Toggle auto-checkpointing via the status bar: "Roo Auto: On/Off"

## Configuration

### Auto-Checkpoint Settings

```json
{
	"roo.autoCheckpoint.enabled": true,
	"roo.autoCheckpoint.patchBytes": 8192,
	"roo.autoCheckpoint.filesTouched": 5,
	"roo.autoCheckpoint.elapsedMs": 90000
}
```

### Commit Strategy

```json
{
	"roo.commit.strategy": "fail-fast"
}
```

Options: `fail-fast`, `rebase`, `hybrid`

## Commands

| Command                         | Description                   |
| ------------------------------- | ----------------------------- |
| `Roo: Save Checkpoint`          | Create manual checkpoint      |
| `Roo: Rollback to Checkpoint`   | Rollback to specific commit   |
| `Roo: Suggest Rollback`         | AI suggests best checkpoint   |
| `Roo: Commit Transaction`       | Commit changes to main branch |
| `Roo: Start Control-Plane Here` | Manually start Control-Plane  |

## Troubleshooting

### Control-Plane Won't Start

**Problem**: Port 8899 is busy
**Solution**: Control-Plane automatically finds a free port. Check the output channel for the actual port.

**Problem**: Node version error
**Solution**: Requires Node 20+. Update your Node version or use `nvm`.

**Problem**: MCP initialization fails
**Solution**: MCP is disabled by default. If you need it, check your MCP configuration.

### Checkpoints Not Working

**Problem**: No checkpoints being created
**Solution**:

1. Ensure transactional mode is enabled
2. Check auto-checkpoint settings
3. Verify Control-Plane is running (status bar should show port)

**Problem**: Rollback fails
**Solution**:

1. Ensure you have an active transaction
2. Check that the commit hash exists
3. Verify Control-Plane is running

### Terminal Commands Blocked

**Problem**: "Command not allowed" error
**Solution**: The Control-Plane blocks dangerous commands. Use the VS Code terminal directly for git operations.

## Architecture

### Sub-Transactions: Semantic Units of Atomicity

**Sub-transactions** represent semantic units of atomicity - contiguous sequences of agent actions whose effects are either fully committed or fully rolled back. They answer the question: "What unit of work is supposed to be atomic?"

**Checkpoints** are internal implementation details (Git commits) that enable rollback. Sub-transactions are the semantic units that define what gets committed or rolled back together.

#### Sub-Transaction Lifecycle

1. **Create**: When a task starts, a sub-transaction is created with the current HEAD as `baseCheckpoint`
2. **Work**: Agent actions create checkpoints (Git commits) during the sub-transaction
3. **Commit**: When work is complete, the sub-transaction is committed:
    - Safety checks run (if defined)
    - `endCheckpoint` is set to current HEAD
    - Status changes to "committed"
4. **Abort**: If work fails, the sub-transaction is aborted:
    - SystemState rolls back to `baseCheckpoint`
    - Status changes to "aborted"
    - AgentState is preserved for debugging

### SystemState vs AgentState Separation

**SystemState** (what gets rolled back):

- Repository commit hash
- File system state
- Tracked files

**AgentState** (what gets preserved):

- Chat history (ClineMessage[])
- Tool call records
- API conversation history

**Critical Principle**: Rollback affects ONLY SystemState; AgentState is preserved for debugging, replay, and informed retries.

This separation is intentional and enables:

- **Replay**: See what the agent tried even after rollback
- **Debugging**: Understand why rollback was needed
- **Informed Retries**: Use agent history to make better decisions

### Git Worktrees

Each transaction uses a Git worktree for isolation:

- Transaction branch: `tx/{transaction-id}`
- Worktree path: `.cp/worktrees/tx_{transaction-id}`
- Checkpoints are Git commits with tags

### Control-Plane API

- **Port**: Dynamic (stored in VS Code global state)
- **Endpoints**: REST API for transactions, checkpoints, rollback
- **Database**: Optional Postgres for audit trail
- **MCP**: Optional Model Context Protocol integration

### Storage Efficiency

- Git handles minimal diffs automatically (content-addressable)
- Checkpoints are just Git commits (cheap storage)
- History pruning available via settings

## Research Goals

✅ **Human vs Autonomous Checkpointing**: Toggle + reason metadata  
✅ **When to Checkpoint**: Threshold heuristics + smart suggestions  
✅ **History Efficiency**: Git diff storage + pruning  
🚧 **Multi-Agent**: Deferred to future work

## Advanced Usage

### Custom Checkpoint Triggers

You can trigger checkpoints programmatically:

```typescript
// Store error context for smart rollback
await vscode.commands.executeCommand("roo.internal.storeError", "Build failed")

// Manual checkpoint
await vscode.commands.executeCommand("roo-cline.saveCheckpoint")
```

### API Integration

The Control-Plane exposes a REST API:

```bash
# Get checkpoints
curl http://localhost:8899/tx/{tx_id}/checkpoints

# Suggest rollback
curl "http://localhost:8899/tx/{tx_id}/suggest-rollback?context=error&message=Build failed"

# Rollback to checkpoint
curl -X POST http://localhost:8899/tx/{tx_id}/rollback \
  -H "Content-Type: application/json" \
  -d '{"hash": "abc123"}'
```

### Conflict Resolution

When committing with conflicts:

1. VS Code shows conflicted files
2. Use "Accept Theirs" / "Accept Ours" buttons
3. Or "Edit Manually" for 3-way merge
4. Retry commit after resolution
