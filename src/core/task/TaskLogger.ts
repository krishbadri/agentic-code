import { CompactLogger } from "../../utils/logging/CompactLogger"
import { CompactTransport } from "../../utils/logging/CompactTransport"

/**
 * Per-run task logger that writes JSON-lines to a file in the workspace's .roo-logs directory.
 * Captures key lifecycle events: task start/end, tool calls, sub-transactions, safety gates, checkpoints.
 */
export class TaskLogger {
	private logger: CompactLogger
	private startTime: number

	constructor(logFilePath: string) {
		const transport = new CompactTransport({
			fileOutput: {
				enabled: true,
				path: logFilePath,
			},
		})
		this.logger = new CompactLogger(transport)
		this.startTime = Date.now()
	}

	logTaskStart(taskId: string, model: string, provider: string, mode: string, prompt: string): void {
		this.logger.info("task started", {
			ctx: "task",
			taskId,
			model,
			provider,
			mode,
			prompt: prompt.slice(0, 200),
		})
	}

	logToolCall(name: string, success: boolean): void {
		this.logger.info("tool called", {
			ctx: "tool",
			name,
			success,
		})
	}

	logSubTxCreated(id: string, baseCommit: string): void {
		this.logger.info("sub-tx created", {
			ctx: "subtx",
			id,
			baseCommit,
		})
	}

	logSafetyGate(id: string, passed: boolean, checks: string[]): void {
		this.logger.info("safety gate", {
			ctx: "subtx",
			id,
			passed,
			checks,
		})
	}

	logSubTxEvent(id: string, status: "committed" | "aborted", endCommit?: string): void {
		this.logger.info(`sub-tx ${status}`, {
			ctx: "subtx",
			id,
			status,
			...(endCommit ? { endCommit } : {}),
		})
	}

	logCheckpoint(subTxId: string, sha: string): void {
		this.logger.info("checkpoint saved", {
			ctx: "checkpoint",
			subTxId,
			sha,
		})
	}

	logTaskEnd(
		status: "success" | "aborted",
		tokenUsage?: Record<string, number>,
		toolUsage?: Record<string, number>,
	): void {
		const durationMs = Date.now() - this.startTime
		this.logger.info("task complete", {
			ctx: "task",
			status,
			durationMs,
			...(tokenUsage ? { tokenUsage } : {}),
			...(toolUsage ? { toolUsage } : {}),
		})
	}

	close(): void {
		this.logger.close()
	}
}
