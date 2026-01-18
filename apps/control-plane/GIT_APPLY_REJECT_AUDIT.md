# Git Apply --reject Audit

## Current Behavior

### Code Location
`apps/control-plane/src/git.ts:42-54` - `applyPatch()` method

### Current Implementation
```typescript
public async applyPatch(tx_id: string, filePath: string, patch: string) {
    const wt = this.worktreePath(tx_id)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-cp-"))
    const patchPath = path.join(tmpDir, "patch.diff")
    await fs.writeFile(patchPath, patch, "utf8")
    try {
        await this.git(["apply", "--whitespace=nowarn", "-p0", patchPath], wt)
        await this.git(["add", filePath], wt)
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
}
```

### Issues Identified

1. **❌ Missing `--reject` flag (R26 violation)**
   - Current: `git apply --whitespace=nowarn -p0`
   - Required: `git apply --reject --whitespace=nowarn -p0`
   - Spec R26: "Git operations MUST include `git apply --reject` for applying patches."

2. **❌ No .rej file detection**
   - When `git apply --reject` encounters a rejected hunk, it:
     - Creates a `.rej` file next to the target file
     - May still exit with non-zero code (depending on --check flag)
   - Current code: No check for .rej files after apply
   - **Gap**: Partial applies with .rej files are not detected as failures

3. **❌ No deterministic error/event for .rej files**
   - Current: Generic error from `pexec` if git apply fails
   - Required: Specific error code/event when .rej files are produced
   - **Gap**: Cannot distinguish between complete failure vs partial apply with .rej

4. **❌ No path safety for .rej files**
   - `git apply --reject` writes .rej files to the same directory as the target file
   - If `filePath` contains `../` or symlinks, .rej could be written outside worktree
   - **Security risk**: Path traversal could write .rej files outside isolated worktree
   - **Gap**: No validation that .rej files are within worktree boundaries

## Required Behavior (Per Spec R26)

1. **Use `--reject` flag**: `git apply --reject --whitespace=nowarn -p0`
2. **Detect .rej files**: After apply, scan for .rej files in worktree
3. **Treat .rej as failure**: If any .rej files exist, fail with deterministic error
4. **Path safety**: Ensure .rej files are within worktree (no symlink/path traversal)
5. **Surface error**: Return structured error with .rej file paths

## Proposed Fix

### Minimal Compliant Behavior

1. Add `--reject` flag to git apply command
2. After apply, scan worktree for .rej files
3. If .rej files found:
   - Validate all .rej paths are within worktree (resolve symlinks, check boundaries)
   - Throw structured error with .rej file list
   - Clean up .rej files (optional, but recommended)
4. Return deterministic error code: `PATCH_REJECTED` with .rej file paths
