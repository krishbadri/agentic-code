# Agentic Code - User Installation Guide

This guide explains how to install and use the **Agentic Code** VS Code extension with the research-grade transactional agent system.

## 📋 Prerequisites

Before installing, ensure you have:

1. **VS Code** (version 1.84.0 or later) or **Cursor**
2. **Node.js** (version 20.x or later) - [Download](https://nodejs.org/)
3. **pnpm** package manager - Install with: `npm install -g pnpm`
4. **PostgreSQL** (version 12 or later) - [Download](https://www.postgresql.org/download/)
5. **Git** - [Download](https://git-scm.com/)

## 🚀 Installation Steps

### Step 1: Clone the Repository

```bash
git clone https://github.com/krishbadri/agentic-code.git
cd agentic-code
```

### Step 2: Install Dependencies

```bash
pnpm install
```

This will install all dependencies for the extension and Control-Plane.

### Step 3: Build the Extension

```bash
pnpm build
```

This compiles the TypeScript code. The extension will be built to `src/dist/`.

### Step 4: Package the Extension (VSIX)

```bash
pnpm vsix
```

This creates a `.vsix` file in the `bin/` directory (e.g., `bin/agentic-cline-3.28.62.vsix`).

### Step 5: Install the VSIX in VS Code

**Option A: Command Line**

```bash
code --install-extension bin/agentic-cline-*.vsix
```

**Option B: VS Code UI**

1. Open VS Code
2. Go to Extensions view (Ctrl+Shift+X)
3. Click the `...` menu → "Install from VSIX..."
4. Select the `.vsix` file from the `bin/` directory

### Step 6: Set Up PostgreSQL Database

The Control-Plane requires a PostgreSQL database. Create one:

```bash
# On Linux/Mac:
createdb agentic_cp

# On Windows (using psql):
psql -U postgres
CREATE DATABASE agentic_cp;
\q
```

Or use any PostgreSQL GUI tool to create a database named `agentic_cp`.

### Step 7: Configure the Extension

Open VS Code settings (Ctrl+,) and configure:

1. **Control-Plane Root Path** (required for transactional mode):

    ```json
    {
    	"roo.controlPlane.rootPath": "/absolute/path/to/agentic-code"
    }
    ```

    On Windows: `C:\\Users\\YourName\\agentic-code`
    On Mac/Linux: `/Users/YourName/agentic-code`

2. **Enable Transactional Mode** (optional but recommended):

    ```json
    {
    	"roo.experimental.transactionalMode": true
    }
    ```

3. **Enable Planner Mode** (enabled by default):
    ```json
    {
    	"roo.experimental.plannerMode": true
    }
    ```

### Step 8: Start the Control-Plane

The Control-Plane is a local daemon that manages transactions, safety checks, and Git worktrees.

**From the repository root:**

```bash
cd apps/control-plane
pnpm start --repo /path/to/your/workspace --port 8899 --db postgres://localhost/agentic_cp
```

**Or in development mode:**

```bash
pnpm dev --repo /path/to/your/workspace --port 8899 --db postgres://localhost/agentic_cp
```

**Parameters:**

- `--repo`: Absolute path to the Git repository you want to work with
- `--port`: Port number (default: 8899)
- `--db`: PostgreSQL connection string

**Example:**

```bash
# Windows
pnpm dev --repo C:\Users\YourName\my-project --port 8899 --db postgres://localhost/agentic_cp

# Mac/Linux
pnpm dev --repo /Users/YourName/my-project --port 8899 --db postgres://localhost/agentic_cp
```

The Control-Plane will:

- Create necessary database tables automatically
- Start a REST API server on `http://127.0.0.1:8899`
- Expose an OpenAPI documentation at `http://127.0.0.1:8899/docs`

### Step 9: Verify Installation

1. **Check Control-Plane is running:**

    ```bash
    curl http://127.0.0.1:8899/versions
    ```

    Should return version information.

2. **Open VS Code in your project:**

    ```bash
    code /path/to/your/project
    ```

3. **Open the Agentic Code sidebar:**

    - Look for the Agentic Code icon in the Activity Bar (left sidebar)
    - Click it to open the chat interface

4. **Test with a simple request:**
    - Type: "Create a hello world file"
    - The extension should use the Control-Plane to make changes safely

## 🎯 Using the Extension

### Basic Usage

1. **Open the sidebar** - Click the Agentic Code icon in VS Code
2. **Start a conversation** - Type your request in natural language
3. **Review changes** - The extension will show diffs before applying
4. **Approve or reject** - Review and approve changes

### Planner Mode (Multi-Agent)

When planner mode is enabled, the extension will:

1. **Analyze your request** - Break it down into sub-tasks
2. **Create a plan** - Generate a structured execution plan with dependencies
3. **Execute in parallel** - Run independent sub-tasks simultaneously
4. **Run safety checks** - Execute tests/linters before committing
5. **Commit atomically** - Only commit if all safety checks pass

**Example request:**

```
"Add user authentication: create a login page, add API endpoints,
write tests, and update documentation"
```

The planner will:

- Create sub-transactions for each component
- Identify dependencies (e.g., API must exist before tests)
- Execute independent tasks in parallel
- Run safety checks (tests, linters) before committing
- Rollback if any check fails

### Transactional Mode

When transactional mode is enabled:

- **All edits** go through the Control-Plane
- **Automatic checkpoints** are created periodically
- **Rollback support** - Undo changes to any checkpoint
- **Safety gates** - Tests/linters must pass before commits
- **Full audit trail** - All changes are logged to PostgreSQL

### Safety Checks

You can configure safety checks in your plan:

```json
{
	"safetyChecks": ["pnpm test", "pnpm lint", "pnpm build"]
}
```

These commands will run before any commit. If any check fails, the commit is blocked.

## 🔧 Configuration Reference

### VS Code Settings

| Setting                              | Description                        | Default    |
| ------------------------------------ | ---------------------------------- | ---------- |
| `roo.controlPlane.rootPath`          | Absolute path to agentic-code repo | `""`       |
| `roo.cpPortOverride`                 | Override Control-Plane port        | `0` (auto) |
| `roo.experimental.transactionalMode` | Enable transactional mode          | `false`    |
| `roo.experimental.plannerMode`       | Enable multi-agent planner         | `true`     |
| `roo.autoCheckpoint.enabled`         | Auto-create checkpoints            | `true`     |
| `roo.autoCheckpoint.patchBytes`      | Bytes threshold for checkpoint     | `8192`     |
| `roo.autoCheckpoint.filesTouched`    | Files threshold for checkpoint     | `5`        |
| `roo.autoCheckpoint.elapsedMs`       | Time threshold for checkpoint      | `90000`    |

### Control-Plane Environment Variables

You can also set these via environment variables:

```bash
export CP_REPO_PATH="/path/to/workspace"
export CP_PORT=8899
export CP_DB_URL="postgres://localhost/agentic_cp"
```

## 🐛 Troubleshooting

### Control-Plane won't start

1. **Check PostgreSQL is running:**

    ```bash
    psql -U postgres -c "SELECT version();"
    ```

2. **Check database exists:**

    ```bash
    psql -U postgres -l | grep agentic_cp
    ```

3. **Check port is available:**

    ```bash
    # Windows
    netstat -an | findstr 8899

    # Mac/Linux
    lsof -i :8899
    ```

### Extension can't connect to Control-Plane

1. **Verify Control-Plane is running:**

    ```bash
    curl http://127.0.0.1:8899/versions
    ```

2. **Check the root path setting:**

    - Must be absolute path
    - Must point to the `agentic-code` repository root
    - On Windows, use forward slashes or double backslashes

3. **Check VS Code settings:**
    - Open Settings (Ctrl+,)
    - Search for "roo.controlPlane.rootPath"
    - Verify it's set correctly

### Safety checks failing

1. **Check commands are correct:**

    - Commands run from the workspace root
    - Use relative paths or absolute paths as needed

2. **Check Git worktree:**
    - Control-Plane creates isolated Git worktrees
    - Each sub-transaction has its own worktree
    - Commands run in the worktree directory

### Database migration errors

If you see database errors, reset the database:

```bash
psql -U postgres
DROP DATABASE agentic_cp;
CREATE DATABASE agentic_cp;
\q
```

Then restart the Control-Plane - it will recreate all tables.

## 📚 Additional Resources

- **OpenAPI Documentation**: `http://127.0.0.1:8899/docs` (when Control-Plane is running)
- **GitHub Repository**: https://github.com/krishbadri/agentic-code
- **Control-Plane README**: `apps/control-plane/README.md`
- **System Specification**: `IDEAL_SYSTEM_SPEC.md`
- **Verification Report**: `SPEC_VERIFICATION.md`

## 🆘 Getting Help

If you encounter issues:

1. Check the troubleshooting section above
2. Review the Control-Plane logs (printed to console)
3. Check VS Code Developer Console (Help → Toggle Developer Tools)
4. Open an issue on GitHub: https://github.com/krishbadri/agentic-code/issues

## 🎉 You're Ready!

Once everything is set up, you can:

- Use natural language to request code changes
- Let the multi-agent planner break down complex tasks
- Rely on safety checks to prevent bad commits
- Rollback to any checkpoint if something goes wrong
- View full audit trails of all changes

Happy coding! 🚀
