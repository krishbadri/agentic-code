import EventEmitter from "events"
import * as vscode from "vscode"
import { CheckpointDiff, CheckpointEventMap, CheckpointResult } from "./types"

export class ControlPlaneCheckpointService extends EventEmitter {
	constructor(
		private readonly baseUrl: string,
		private readonly txId: string,
		private readonly log: (m: string) => void,
	) {
		super()
	}

	public async saveCheckpoint(
		message: string,
		options?: { allowEmpty?: boolean; suppressMessage?: boolean },
	): Promise<CheckpointResult | undefined> {
		try {
			const res = await fetch(`${this.baseUrl}/tx/${this.txId}/checkpoint`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Actor-Id": "human" },
				body: JSON.stringify({ reason: "human", trailers: { Message: message } }),
			})
			if (!res.ok) throw new Error(await res.text())
			const data = await res.json()
			this.emit("checkpoint", {
				type: "checkpoint",
				fromHash: "",
				toHash: data.commit_sha,
				duration: 0,
				suppressMessage: !!options?.suppressMessage,
			})
			return { commit: data.commit_sha, summary: "" } as any
		} catch (e) {
			this.emit("error", { type: "error", error: e as Error })
			throw e
		}
	}

	public async getDiff({ from, to }: { from?: string; to?: string }): Promise<CheckpointDiff[]> {
		// Minimal: fetch status and reconstruct; for now return empty to unblock integration
		return []
	}

	public async restoreCheckpoint(commitHash: string) {
		try {
			const res = await fetch(`${this.baseUrl}/tx/${this.txId}/rollback`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Actor-Id": "human" },
				body: JSON.stringify({ to: `commit:${commitHash}` }),
			})
			if (!res.ok) throw new Error(await res.text())
			const data = await res.json()
			await vscode.commands.executeCommand("setContext", "roo.current_tx_id", data.new_tx_id)
			await vscode.commands.executeCommand("workbench.action.reloadWindow")
			this.emit("restore", { type: "restore", commitHash, duration: 0 })
		} catch (e) {
			this.emit("error", { type: "error", error: e as Error })
			throw e
		}
	}
}
