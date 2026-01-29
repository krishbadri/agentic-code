# Database Status Report

**Date**: January 24, 2026  
**Issue**: Database is optional and defaults to disabled, breaking auditability

---

## Current Behavior

### Database Initialization

**Location**: `apps/control-plane/src/server.ts:48-52`

```typescript
if (!config.disableDb && config.databaseUrl) {
    const pool = createPool(config.databaseUrl)
    await migrate(pool)
    app.decorate("db", pool)
}
```

**Problem**: Database is only initialized if BOTH:
1. `disableDb` is false
2. `databaseUrl` is provided

### Extension Startup

**Location**: `src/extension.ts:393`

```typescript
const disableDb = !process.env.CP_DATABASE_URL
```

**Problem**: If `CP_DATABASE_URL` environment variable is NOT set, database is **disabled by default**.

### Fallback to In-Memory Storage

**Location**: `apps/control-plane/src/server.ts:46`

```typescript
// R33: In-memory progress baselines for DB-less mode (testing)
app.decorate("progressBaselines", new Map<string, {...}>())
```

**Current State**: System falls back to in-memory `Map` storage when database is disabled.

---

## Impact Analysis

### What Works Without Database

✅ **Core Functionality**:
- Transaction creation (`/tx/begin`)
- Sub-transaction creation (`/tx/:tx_id/sub-tx/:sub_tx_id/begin`)
- File operations (`/tx/:tx_id/apply`, `/tx/:tx_id/write`)
- Safety gates (`/tx/:tx_id/sub-tx/:sub_tx_id/safety-gate`)
- Merge pipeline (`/tx/:tx_id/merge-pipeline`)
- Progress baselines (in-memory Map)

### What's Broken Without Database

❌ **Auditability** (Critical for Research):
- Transaction history (`/tx/:tx_id/history`) → Returns 503
- Tool call logging (`POST /tx/:tx_id/tool-calls`) → Returns 503
- Model call logging → Not persisted
- Plan persistence (`GET /tx/:tx_id/plan`) → Returns 503
- Safety check results → Not persisted
- Replay capability → Not available

❌ **Persistence**:
- All data lost on Control-Plane restart
- No transaction history across sessions
- No audit trail for research/evaluation

❌ **Research Metrics**:
- Rollback metrics → Not collected
- Execution metrics → Not collected
- Model call tracking → Not persisted

---

## Code Evidence

### Endpoints That Require Database

All these endpoints return `503 "Database not available"` if `!app.db`:

1. **`GET /tx/:tx_id/history`** (line 1302)
   ```typescript
   if (!app.db) {
       return reply.code(503).send({ error: "Database not available" })
   }
   ```

2. **`GET /tx/:tx_id/tool-calls`** (line 1327)
   ```typescript
   if (!app.db) {
       return reply.code(503).send({ error: "Database not available" })
   }
   ```

3. **`POST /tx/:tx_id/tool-calls`** (line 1302)
   ```typescript
   if (!app.db) {
       return reply.code(503).send({ error: "Database not available" })
   }
   ```

4. **`GET /tx/:tx_id/plan`** (line 1440)
   ```typescript
   if (!app.db) {
       return reply.code(503).send({ error: "Database not available" })
   }
   ```

5. **`GET /tx/:tx_id/model-calls`** (line 1494)
   ```typescript
   if (!app.db) {
       return reply.code(503).send({ error: "Database not available" })
   }
   ```

6. **`GET /tx/:tx_id/sub-transactions`** (line 1523)
   ```typescript
   if (!app.db) {
       return reply.code(503).send({ error: "Database not available" })
   }
   ```

7. **`GET /tx/:tx_id/safety-checks`** (line 1548)
   ```typescript
   if (!app.db) {
       return reply.code(503).send({ error: "Database not available" })
   }
   ```

8. **`POST /tx/:tx_id/replay`** (line 1563)
   ```typescript
   if (!app.db) {
       return reply.code(503).send({ error: "Database not available" })
   }
   ```

9. **`GET /metrics/rollback`** (line 1581)
   ```typescript
   if (!app.db) {
       return reply.code(503).send({ error: "Database not available" })
   }
   ```

10. **`GET /metrics/speedup`** (line 1630)
    ```typescript
    if (!app.db) {
        return reply.code(503).send({ error: "Database not available" })
    }
    ```

### What Uses In-Memory Fallback

Only **progress baselines** use in-memory fallback:

- `apps/control-plane/src/routes/tx.ts:193-203` - Progress baseline storage
- `apps/control-plane/src/routes/tx.ts:352-354` - Progress baseline retrieval
- `apps/control-plane/src/routes/tx.ts:504-506` - Progress baseline for liveness check

**Everything else requires database or fails silently.**

---

## Specification Compliance Impact

### IDEAL_SYSTEM_SPEC.md Section 10: History, Auditability, and Replay

**Requirement**: "The system MUST provide: Full agent execution history, Full checkpoint history, Diffs for committed and rolled-back sub-transactions, Ability to answer: what happened, why it failed, what was undone, what was preserved"

**Current State**: ❌ **NON-COMPLIANT** when database is disabled

- No execution history (503 error)
- No checkpoint history (not stored)
- No tool call history (503 error)
- No model call history (503 error)
- No replay capability (503 error)

**Impact**: **CRITICAL** - Research-grade system cannot function without auditability.

---

## Root Cause

1. **Database is optional by design** - Intended for testing (DB-less mode)
2. **Extension defaults to DB-less** - `disableDb = !process.env.CP_DATABASE_URL`
3. **No warning/error** - System silently falls back to in-memory storage
4. **Critical features disabled** - Auditability endpoints return 503

---

## Recommendations

### Option 1: Make Database Required for Production (Recommended)

**Change**: Require database for production use, only allow DB-less for testing.

**Implementation**:
1. Add configuration flag: `roo.controlPlane.requireDatabase` (default: `true`)
2. If required and not configured, show error message
3. Only allow `--disableDb` in test mode or with explicit override

**Code Changes**:
```typescript
// src/extension.ts
const requireDb = cfg.get<boolean>("roo.controlPlane.requireDatabase", true)
if (requireDb && !process.env.CP_DATABASE_URL) {
    vscode.window.showErrorMessage(
        "Database required for production use. Set CP_DATABASE_URL environment variable or configure roo.controlPlane.requireDatabase=false"
    )
    return undefined
}
```

### Option 2: Use Local SQLite Database (Fallback)

**Change**: Use SQLite as fallback when PostgreSQL not available.

**Implementation**:
1. Check for `CP_DATABASE_URL`
2. If not set, use SQLite database in `.cp/db.sqlite`
3. Migrate SQLite schema
4. Use SQLite for all operations

**Pros**: 
- No external database required
- Persistence across restarts
- Full auditability

**Cons**:
- SQLite doesn't support concurrent writes well
- May need connection pooling workaround

### Option 3: Warn User About Missing Database

**Change**: Show warning but allow operation.

**Implementation**:
1. Check if database is available
2. Show warning: "Database not configured - auditability features disabled"
3. Continue with in-memory storage
4. Log all operations to file as backup

---

## Immediate Fix

**For Production Use**: Set `CP_DATABASE_URL` environment variable:

```bash
# Windows PowerShell
$env:CP_DATABASE_URL = "postgresql://user:password@localhost:5432/roo_control_plane"

# Linux/Mac
export CP_DATABASE_URL="postgresql://user:password@localhost:5432/roo_control_plane"
```

**For VS Code**: Add to `.vscode/settings.json`:
```json
{
  "terminal.integrated.env.windows": {
    "CP_DATABASE_URL": "postgresql://user:password@localhost:5432/roo_control_plane"
  }
}
```

---

## Conclusion

**Current State**: System is running in **DB-less mode** by default, which:
- ✅ Works for basic functionality
- ❌ Breaks auditability (research requirement)
- ❌ Loses all data on restart
- ❌ Cannot replay transactions
- ❌ Cannot collect research metrics

**Recommendation**: 
1. **Immediate**: Set `CP_DATABASE_URL` environment variable
2. **Short-term**: Make database required for production (Option 1)
3. **Long-term**: Consider SQLite fallback (Option 2)

**Impact on Spec Compliance**: Database is **required** for IDEAL_SYSTEM_SPEC.md Section 10 (History, Auditability, and Replay). Current implementation is non-compliant when database is disabled.
