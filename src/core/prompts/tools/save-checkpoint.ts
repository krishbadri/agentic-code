import { ToolArgs } from "./types"

export function getSaveCheckpointDescription(args: ToolArgs): string | undefined {
	return `## save_checkpoint
Description: Creates a named checkpoint of the current repo state. Use this when following a checkpoint protocol (e.g. Stage 2) that requires explicit checkpoints like C1_tests, C2_impl. Do NOT use git commit - use this tool.
Parameters:
- name: (required) Checkpoint name, e.g. C1_tests, C2_impl, C3_docs
Usage:
<save_checkpoint>
<name>C1_tests</name>
</save_checkpoint>`
}
