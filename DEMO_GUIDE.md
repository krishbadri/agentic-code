# Agentic Code - Demo Guide for Research Mentor

**Purpose**: Complete guide for demonstrating the transactional agentic coding system to your research mentor.

**System Overview**: Agentic Code models agentic coding edits as database transactions, providing safety, rollback, parallelism, and full auditability.

---

## 🎯 What This System Does

**Core Concept**: Treat agentic coding edits as database transactions with:
- **Atomicity**: Sub-transactions either fully commit or fully rollback
- **Isolation**: Each agent works in an isolated Git worktree
- **Durability**: All operations persisted to PostgreSQL
- **Consistency**: Safety checks enforce invariants before commits

**Research Value**: This enables empirical study of:
- Multi-agent coordination patterns
- Rollback frequency and effectiveness
- Parallel execution speedup
- Safety check impact on code quality

---

## 🏗️ System Architecture

```
┌─────────────────┐
│  VS Code        │
│  Extension      │
│  (agentic-cline)│
└────────┬────────┘
         │ HTTP REST API
         │
┌────────▼────────┐
│  Control-Plane  │
│  (Local Daemon) │
│  Port: 8899     │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐ ┌──▼────┐
│  Git  │ │Postgres│
│Repo   │ │  DB   │
└───────┘ └───────┘
```

**Components**:

1. **VS Code Extension** (`src/`): User-facing interface, task management, planner agent
2. **Control-Plane** (`apps/control-plane/`): Transaction coordinator, Git worktree manager, safety gate executor
3. **PostgreSQL**: Audit trail, metrics, transaction history
4. **Git Worktrees**: Isolation mechanism for parallel execution

---

## ✅ Prerequisites Check

Before the demo, verify:

```bash
# 1. Node.js 20+
node --version  # Should be v20.x or higher

# 2. pnpm installed
pnpm --version  # Should be 8.x or higher

# 3. PostgreSQL running
psql --version  # Should be 12+ or higher

# 4. Git installed
git --version

# 5. VS Code or Cursor installed
code --version  # or cursor --version
```

---

## 🚀 Quick Setup (5 minutes)

### Step 1: Clone and Build

```bash
git clone https://github.com/krishbadri/agentic-code.git
cd agentic-code
pnpm install
pnpm build
pnpm vsix
```

### Step 2: Install Extension

```bash
# Install the VSIX file
code --install-extension bin/agentic-cline-*.vsix

# Or manually:
# 1. Open VS Code
# 2. Extensions view (Ctrl+Shift+X)
# 3. Click "..." → "Install from VSIX..."
# 4. Select bin/agentic-cline-*.vsix
```

### Step 3: Set Up PostgreSQL

```bash
# Create database
createdb agentic_cp

# Or using psql:
psql -U postgres
CREATE DATABASE agentic_cp;
\q
```

### Step 4: Configure VS Code

Open VS Code Settings (Ctrl+,) and set:

```json
{
  "roo.controlPlane.rootPath": "C:\\Users\\YourName\\agentic-code",  // Absolute path!
  "roo.experimental.transactionalMode": true,
  "roo.experimental.plannerMode": true
}
```

**Important**: Use forward slashes or double backslashes on Windows:
- ✅ `C:/Users/YourName/agentic-code`
- ✅ `C:\\Users\\YourName\\agentic-code`
- ❌ `C:\Users\YourName\agentic-code`

### Step 5: Start Control-Plane

```bash
cd apps/control-plane

# Development mode (with auto-reload):
pnpm dev --repo /path/to/your/test/project --port 8899 --db postgres://localhost/agentic_cp

# Production mode:
pnpm start --repo /path/to/your/test/project --port 8899 --db postgres://localhost/agentic_cp
```

**Example** (Windows):
```bash
pnpm dev --repo C:\Users\YourName\my-test-project --port 8899 --db postgres://localhost/agentic_cp
```

**Example** (Mac/Linux):
```bash
pnpm dev --repo /Users/YourName/my-test-project --port 8899 --db postgres://localhost/agentic_cp
```

**Verify Control-Plane is running**:
```bash
curl http://127.0.0.1:8899/health
# Should return: {"status":"ok","timestamp":...}
```

---

## 🎬 Demo Script

### Demo 1: Basic Transactional Editing (5 minutes)

**Goal**: Show atomic commits with safety checks

**Steps**:

1. **Open a test project in VS Code**:
   ```bash
   code /path/to/your/test/project
   ```

2. **Open Agentic Code sidebar**:
   - Click the Agentic Code icon in the Activity Bar (left sidebar)
   - Or use Command Palette: "Roo: Open Sidebar"

3. **Make a simple request**:
   ```
   Create a file called hello.js with a function that returns "Hello, World!"
   ```

4. **Observe**:
   - Extension creates a transaction
   - File is created in isolated worktree
   - Changes are staged
   - Transaction commits atomically

5. **Check Control-Plane logs**:
   ```bash
   # In the Control-Plane terminal, you should see:
   [INFO] Transaction started: tx_xxx
   [INFO] Sub-transaction created: sub_tx_yyy
   [INFO] Transaction committed: tx_xxx
   ```

6. **Verify in database**:
   ```sql
   psql -U postgres -d agentic_cp
   SELECT tx_id, status, created_at FROM transaction ORDER BY created_at DESC LIMIT 5;
   SELECT sub_tx_id, tx_id, status FROM sub_transaction ORDER BY created_at DESC LIMIT 5;
   ```

---

### Demo 2: Multi-Agent Planner (10 minutes)

**Goal**: Show parallel execution with dependency management

**Steps**:

1. **Create a test project**:
   ```bash
   mkdir demo-project
   cd demo-project
   git init
   echo "# Demo Project" > README.md
   git add README.md
   git commit -m "Initial commit"
   ```

2. **Start Control-Plane** pointing to this project:
   ```bash
   cd /path/to/agentic-code/apps/control-plane
   pnpm dev --repo /absolute/path/to/demo-project --port 8899 --db postgres://localhost/agentic_cp
   ```

3. **Open project in VS Code**:
   ```bash
   code /path/to/demo-project
   ```

4. **Make a complex request**:
   ```
   Create a user authentication system:
   1. Create a User model with email and password fields
   2. Create a login API endpoint
   3. Write unit tests for the login function
   4. Update the README with authentication instructions
   ```

5. **Observe the planner**:
   - Extension analyzes the request
   - Planner generates a structured plan with sub-transactions
   - Plan shows dependencies (e.g., tests depend on API)
   - Sub-transactions execute in parallel where possible

6. **Check the plan**:
   ```bash
   # Get the transaction ID from Control-Plane logs, then:
   curl http://127.0.0.1:8899/tx/{tx_id}/plan | jq
   ```

   **Expected output**:
   ```json
   {
     "subTransactions": [
       {
         "id": "sub_tx_1",
         "title": "Create User model",
         "agentType": "coder",
         "dependsOn": [],
         "safetyChecks": []
       },
       {
         "id": "sub_tx_2",
         "title": "Create login API",
         "agentType": "coder",
         "dependsOn": ["sub_tx_1"],
         "safetyChecks": []
       },
       {
         "id": "sub_tx_3",
         "title": "Write unit tests",
         "agentType": "tester",
         "dependsOn": ["sub_tx_2"],
         "safetyChecks": ["npm test"]
       }
     ]
   }
   ```

7. **Observe parallel execution**:
   - `sub_tx_1` runs first (no dependencies)
   - `sub_tx_2` waits for `sub_tx_1` to complete
   - `sub_tx_3` waits for `sub_tx_2` to complete
   - `sub_tx_4` can run in parallel with `sub_tx_3` if no dependency

8. **Check worktrees**:
   ```bash
   ls -la /path/to/agentic-code/apps/control-plane/.cp/worktrees/
   # Should see worktrees for each sub-transaction
   ```

---

### Demo 3: Safety Gates (5 minutes)

**Goal**: Show safety checks blocking bad commits

**Steps**:

1. **Create a project with a failing test**:
   ```bash
   mkdir safety-demo
   cd safety-demo
   git init
   npm init -y
   npm install --save-dev jest
   
   # Create a test file that will fail
   echo "test('fails', () => { expect(1).toBe(2); });" > test.js
   
   # Add to package.json:
   # "scripts": { "test": "jest test.js" }
   
   git add .
   git commit -m "Initial commit with failing test"
   ```

2. **Start Control-Plane**:
   ```bash
   cd /path/to/agentic-code/apps/control-plane
   pnpm dev --repo /absolute/path/to/safety-demo --port 8899 --db postgres://localhost/agentic_cp
   ```

3. **Make a request with safety checks**:
   ```
   Add a new function add(a, b) that returns a + b. 
   Make sure tests pass before committing.
   ```

4. **The planner should generate**:
   ```json
   {
     "subTransactions": [{
       "id": "sub_tx_1",
       "title": "Add add function",
       "safetyChecks": ["npm test"]
     }]
   }
   ```

5. **Observe**:
   - Agent creates the function
   - Safety gate runs: `npm test`
   - Test fails (because of the existing failing test)
   - Commit is **BLOCKED**
   - Sub-transaction is **ABORTED**

6. **Check database**:
   ```sql
   SELECT sub_tx_id, status, failure_kind, failure_message 
   FROM sub_transaction 
   ORDER BY created_at DESC LIMIT 1;
   -- Should show: status='ABORTED', failure_kind='SAFETY_FAIL'
   
   SELECT cmd, exit_code, stdout_tail 
   FROM safety_check_result 
   WHERE sub_tx_id = '...';
   -- Should show: cmd='npm test', exit_code=1
   ```

7. **Fix the test and retry**:
   - Fix the failing test manually
   - Make the same request again
   - This time, safety checks pass and commit succeeds

---

### Demo 4: Rollback (5 minutes)

**Goal**: Show atomic rollback of sub-transactions

**Steps**:

1. **Create a project**:
   ```bash
   mkdir rollback-demo
   cd rollback-demo
   git init
   echo "# Demo" > README.md
   git add README.md
   git commit -m "Initial"
   ```

2. **Start Control-Plane**:
   ```bash
   cd /path/to/agentic-code/apps/control-plane
   pnpm dev --repo /absolute/path/to/rollback-demo --port 8899 --db postgres://localhost/agentic_cp
   ```

3. **Make a request that will fail**:
   ```
   Create a file bad.js that imports a non-existent module 'nonexistent-package'
   ```

4. **Observe**:
   - Agent creates `bad.js`
   - Sub-transaction starts
   - Agent tries to run the file (or safety check fails)
   - Sub-transaction is aborted
   - **File is automatically deleted** (rollback)

5. **Verify rollback**:
   ```bash
   # In the project directory:
   ls -la
   # bad.js should NOT exist
   
   git status
   # Should be clean (no uncommitted changes)
   ```

6. **Check database**:
   ```sql
   SELECT sub_tx_id, status, base_commit, end_commit 
   FROM sub_transaction 
   ORDER BY created_at DESC LIMIT 1;
   -- Should show: status='ABORTED', end_commit=NULL
   ```

---

### Demo 5: Audit Trail (5 minutes)

**Goal**: Show full history and auditability

**Steps**:

1. **Query transaction history**:
   ```sql
   psql -U postgres -d agentic_cp
   
   -- List all transactions
   SELECT tx_id, status, created_at, ended_at 
   FROM transaction 
   ORDER BY created_at DESC;
   
   -- List all sub-transactions for a transaction
   SELECT sub_tx_id, title, status, agent_type, created_at, ended_at
   FROM sub_transaction
   WHERE tx_id = 'your-tx-id'
   ORDER BY created_at;
   
   -- List all tool calls
   SELECT tool_name, input, timestamp, checkpoint_before
   FROM tool_call
   WHERE tx_id = 'your-tx-id'
   ORDER BY timestamp;
   
   -- List all model calls (LLM invocations)
   SELECT model_id, prompt_hash, timestamp
   FROM model_call
   WHERE tx_id = 'your-tx-id'
   ORDER BY timestamp;
   
   -- List safety check results
   SELECT cmd, exit_code, duration_ms, stdout_tail
   FROM safety_check_result
   WHERE sub_tx_id = 'your-sub-tx-id';
   ```

2. **Show plan persistence**:
   ```bash
   curl http://127.0.0.1:8899/tx/{tx_id}/plan | jq '.plan_json.subTransactions'
   ```

3. **Show metrics**:
   ```bash
   # Rollback frequency
   curl http://127.0.0.1:8899/metrics/rollback | jq
   
   # Parallel speedup
   curl http://127.0.0.1:8899/metrics/speedup | jq
   ```

---

## 🔍 Verification Checklist

Before the demo, verify:

- [ ] Extension builds without errors: `pnpm build`
- [ ] VSIX file created: `ls bin/agentic-cline-*.vsix`
- [ ] Extension installed in VS Code
- [ ] PostgreSQL database created: `agentic_cp`
- [ ] Control-Plane starts: `curl http://127.0.0.1:8899/health`
- [ ] VS Code settings configured (rootPath, transactionalMode, plannerMode)
- [ ] Test project is a Git repository
- [ ] Control-Plane is pointing to the test project

---

## 🐛 Troubleshooting

### Control-Plane won't start

**Symptoms**: Port already in use, database connection error

**Solutions**:
```bash
# Check if port is in use
netstat -an | findstr 8899  # Windows
lsof -i :8899                # Mac/Linux

# Kill existing process
# Windows: Task Manager → End Process
# Mac/Linux: kill -9 <PID>

# Check PostgreSQL is running
psql -U postgres -c "SELECT version();"

# Check database exists
psql -U postgres -l | grep agentic_cp
```

### Extension can't connect to Control-Plane

**Symptoms**: Error in VS Code output: "Control-Plane not available"

**Solutions**:
1. Verify `roo.controlPlane.rootPath` is **absolute path**
2. Verify Control-Plane is running: `curl http://127.0.0.1:8899/health`
3. Check VS Code Output panel: View → Output → Select "Roo Code"
4. Check Control-Plane logs for errors

### Safety checks not running

**Symptoms**: Commits succeed even when tests fail

**Solutions**:
1. Verify `roo.experimental.transactionalMode` is `true`
2. Verify `roo.experimental.plannerMode` is `true`
3. Check that planner generated `safetyChecks` in the plan
4. Check Control-Plane logs for safety-gate endpoint calls

### Worktrees not cleaning up

**Symptoms**: `.cp/worktrees/` directory grows large

**Solutions**:
```bash
# Manual cleanup (if needed):
cd apps/control-plane/.cp/worktrees
git worktree list  # List all worktrees
git worktree remove <path> --force  # Remove specific worktree

# Control-Plane should auto-cleanup on restart
```

---

## 📊 Research Metrics Available

The system collects the following metrics for research:

1. **Rollback Metrics** (`/metrics/rollback`):
   - Rollback frequency per transaction
   - Average time to rollback
   - Rollback reasons (SAFETY_FAIL, MERGE_CONFLICT, etc.)

2. **Execution Metrics** (`/metrics/speedup`):
   - Parallel vs. serial execution time
   - Speedup factor
   - Dependency graph statistics

3. **Transaction History** (`/tx/:tx_id/history`):
   - Full execution timeline
   - Tool call sequence
   - Model call sequence
   - Checkpoint history

4. **Plan Analysis** (`/tx/:tx_id/plan`):
   - Generated plan structure
   - Dependency graph
   - Agent assignments

---

## 🎓 Key Points to Emphasize

1. **Safety Invariants**: System **cannot** run without Control-Plane - no unsafe fallback
2. **Atomicity**: Sub-transactions are all-or-nothing
3. **Isolation**: Git worktrees provide true isolation
4. **Auditability**: Every action is logged to PostgreSQL
5. **Research-Grade**: Full metrics collection for empirical analysis

---

## 📚 Additional Resources

- **User Guide**: `USER_GUIDE.md` - Detailed installation and usage
- **System Specification**: `IDEAL_SYSTEM_SPEC.md` - Complete requirements
- **Verification Report**: `SPEC_VERIFICATION.md` - Compliance analysis
- **API Documentation**: `http://127.0.0.1:8899/docs` (when Control-Plane is running)

---

## ✅ Success Criteria

A successful demo shows:

1. ✅ Extension loads and connects to Control-Plane
2. ✅ Planner generates structured plans with dependencies
3. ✅ Sub-transactions execute in parallel where possible
4. ✅ Safety checks block bad commits
5. ✅ Rollback works atomically
6. ✅ Full audit trail in database
7. ✅ Metrics are queryable via REST API

---

**Good luck with your demo!** 🚀
