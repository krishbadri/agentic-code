import EventEmitter from "events"

import { cpErrorMessage } from "../../core/control-plane/client"
import * as cpTx from "../../core/control-plane/tx"
import { CheckpointDiff, CheckpointResult } from "./types"

export interface CpCheckpointResult extends CheckpointResult {
	/** Set when the CP progress gate (tests/compile) rejected the checkpoint and rolled back. */
	progressViolation?: {
		kind?: string
		rollbackTo?: string
		currentCount?: number
		lastCount?: number
		message: string
	}
}

/**
 * Checkpoints for a task that runs inside a Control-Plane transaction. All
 * operations address the task's own worktree (`txId` is the parent tx id or a
 * `<parent>_sub_<rel>` composite id for planner children).
 */
export class ControlPlaneCheckpointService extends EventEmitter {
	public readonly isInitialized = true
	public baseHash?: string

	constructor(
		private readonly port: number,
		public readonly txId: string,
		private readonly log: (m: string) => void,
	) {
		super()
	}

	/**
	 * Returns `{commit}` on success, `{commit: "", progressViolation}` when the
	 * CP progress gate rejected the checkpoint (403 PROGRESS_VIOLATION — the CP
	 * has already rolled the worktree back). Throws on any other failure.
	 */
	public async saveCheckpoint(
		message: string,
		options?: { allowEmpty?: boolean; suppressMessage?: boolean },
	): Promise<CpCheckpointResult | undefined> {
		try {
			const res = await cpTx.checkpoint(this.port, this.txId, { reason: "human", trailers: { Message: message } })
			if (res.status === 403 && res.data?.code === "PROGRESS_VIOLATION") {
				const d = res.data
				const violation = {
					kind: typeof d.kind === "string" ? d.kind : undefined,
					rollbackTo: d.rollback_to,
					currentCount: d.current_count,
					lastCount: d.last_checkpoint_count,
					message: cpErrorMessage(res),
				}
				this.log(`[ControlPlaneCheckpointService] PROGRESS_VIOLATION on ${this.txId}: ${violation.message}`)
				return { commit: "", summary: undefined as any, progressViolation: violation } as CpCheckpointResult
			}
			if (!res.ok || !res.data?.commit_sha) throw new Error(cpErrorMessage(res))
			const sha = res.data.commit_sha
			this.emit("checkpoint", {
				type: "checkpoint",
				fromHash: "",
				toHash: sha,
				duration: 0,
				suppressMessage: !!options?.suppressMessage,
			})
			return { commit: sha } as CpCheckpointResult
		} catch (e) {
			this.emit("error", { type: "error", error: e as Error })
			throw e
		}
	}

	public async getDiff(_args: { from?: string; to?: string }): Promise<CheckpointDiff[]> {
		// Not supported through the CP yet.
		return []
	}

	/** Exactly one CP `/rollback` call on this task's worktree. */
	public async restoreCheckpoint(commitHash: string) {
		try {
			const res = await cpTx.rollback(this.port, this.txId, commitHash)
			if (!res.ok) throw new Error(cpErrorMessage(res))
			const data = res.data ?? {}
			this.log(
				`[ControlPlaneCheckpointService#restoreCheckpoint] Rolled back ${this.txId} to ${data.rolled_back_to || commitHash}` +
					(data.backup_ref ? ` (backup ${data.backup_ref})` : ""),
			)
			this.emit("restore", { type: "restore", commitHash, duration: data.duration_ms ?? 0 })
		} catch (e) {
			this.emit("error", { type: "error", error: e as Error })
			throw e
		}
	}
}
