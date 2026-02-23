import { ToolArgs } from "./types"

export function getRollbackToCheckpointDescription(args: ToolArgs): string | undefined {
	return `## rollback_to_checkpoint
Description: Restores the repo to a prior checkpoint. REQUIRED for Stage 2 rollback drill. Do NOT use git reset, git restore, or manual file deletion - use this tool. After rollback, ROLLBACK_SENTINEL.txt and any changes after the checkpoint are reverted.
Parameters:
- commit_hash: (optional) Full or short Git commit hash from a previous save_checkpoint result
- checkpoint_name: (optional) Checkpoint name, e.g. C1_tests - resolves to the matching checkpoint
Usage (by name):
<rollback_to_checkpoint>
<checkpoint_name>C1_tests</checkpoint_name>
</rollback_to_checkpoint>

Usage (by hash):
<rollback_to_checkpoint>
<commit_hash>abc1234</commit_hash>
</rollback_to_checkpoint>`
}
