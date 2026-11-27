import * as path from "path"

import type { ToolUse } from "../../shared/tools"
import type { Task } from "../task/Task"

import { cpErrorMessage, getCpPort } from "./client"
import * as cpTx from "./tx"

/**
 * R9 action-safety: before a mutating tool runs, ask the Control-Plane whether
 * the action is allowed. Tools are posted under their REAL Roo tool names.
 *
 * Policy:
 *  - no transaction                       → allow (nothing to protect)
 *  - tx open, CP says allowed             → allow
 *  - tx open, CP says 403 ACTION_BLOCKED  → block with the CP's reason
 *  - tx open, CP unreachable / 4xx / 5xx  → block (fail closed)
 */

export const ACTION_SAFETY_TOOLS = new Set<string>([
	"write_to_file",
	"apply_diff",
	"insert_content",
	"search_and_replace",
	"execute_command",
	"generate_image",
])

export type ActionSafetyVerdict = { allowed: true } | { allowed: false; reason: string; rule?: string }

/** All file paths named by a multi-file apply_diff `args` XML block. */
export function extractArgsXmlPaths(argsXml: string | undefined): string[] {
	if (!argsXml) return []
	const paths: string[] = []
	const re = /<file>.*?<path>([^<]+)<\/path>/gs
	let m: RegExpExecArray | null
	while ((m = re.exec(argsXml)) !== null) {
		const p = m[1].trim()
		if (p && !paths.includes(p)) paths.push(p)
	}
	return paths
}

export function buildActionSafetyArgs(task: Pick<Task, "cwd">, block: ToolUse): cpTx.ActionSafetyArgs {
	const params = (block.params ?? {}) as Record<string, string | undefined>
	const args: cpTx.ActionSafetyArgs = {}

	if (block.name === "execute_command") {
		args.command = params.command ?? ""
		args.cwd_rel = toCwdRel(task.cwd, params.cwd)
		return args
	}

	if (params.path) args.path = params.path
	if (block.name === "apply_diff") {
		const paths = extractArgsXmlPaths(params.args)
		if (paths.length > 0) {
			args.paths = paths
			if (!args.path) args.path = paths[0]
		}
	}
	return args
}

/** Path of `customCwd` relative to the task's cwd ("" for the cwd itself). */
export function toCwdRel(base: string, customCwd: string | undefined): string {
	if (!customCwd) return ""
	const abs = path.isAbsolute(customCwd) ? customCwd : path.resolve(base, customCwd)
	const rel = path.relative(base, abs)
	return rel.split(path.sep).join("/")
}

export async function checkActionSafety(task: Task, block: ToolUse): Promise<ActionSafetyVerdict> {
	if (!ACTION_SAFETY_TOOLS.has(block.name)) return { allowed: true }

	const txId = task.rootTxId
	if (!txId) return { allowed: true }

	const provider = task.providerRef.deref()
	const port = getCpPort(provider?.context)
	if (!port) {
		return {
			allowed: false,
			reason: "the Control-Plane is unavailable, so the action cannot be safety-checked (fail-closed)",
		}
	}

	try {
		const res = await cpTx.actionSafety(port, txId, {
			action: block.name,
			args: buildActionSafetyArgs(task, block),
			...(task.subTransactionId ? { sub_tx_id: task.subTransactionId } : {}),
		})
		if (res.ok && res.data?.allowed !== false) return { allowed: true }
		const reason =
			(typeof res.data?.reason === "string" && res.data.reason) ||
			(res.ok ? "action not allowed" : cpErrorMessage(res))
		provider?.log(`[ActionSafety] BLOCKED ${block.name} (HTTP ${res.status}): ${reason}`)
		return { allowed: false, reason, rule: res.data?.rule }
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		provider?.log(`[ActionSafety] Check failed for ${block.name}, blocking (fail-closed): ${msg}`)
		return { allowed: false, reason: `action-safety check failed (${msg}); blocked (fail-closed)` }
	}
}

/**
 * R30: reserve a NEW file path across the whole task tree before creating it,
 * so two concurrent sub-agents cannot both create the same file. Uses the root
 * transaction (siblings share it) and the sub-tx id as the claimer.
 * No transaction → ok. CP unreachable / 409 / other error → not ok.
 */
export async function reserveNewFile(
	task: Task,
	relPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const txId = task.rootTxId
	if (!txId) return { ok: true }
	const provider = task.providerRef.deref()
	const port = getCpPort(provider?.context)
	if (!port) {
		return {
			ok: false,
			reason: "the Control-Plane is unavailable, so the new file cannot be reserved (fail-closed)",
		}
	}
	const claimerId = task.subTransactionId ?? task.taskId
	try {
		const res = await cpTx.reserveFile(port, txId, { file_path: relPath, claimer_id: claimerId })
		if (res.ok) return { ok: true }
		const d = (res.data ?? {}) as Record<string, any>
		if (res.status === 409) {
			const by = d.by ?? d.claimer_id ?? d.claimed_by
			return {
				ok: false,
				reason:
					d.code === "FILE_EXISTS"
						? `"${relPath}" already exists in this transaction; edit it instead of creating it`
						: `another agent${by ? ` (${by})` : ""} already claimed "${relPath}" in this transaction; choose a different file path`,
			}
		}
		return { ok: false, reason: `could not reserve "${relPath}": ${cpErrorMessage(res)}` }
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		return { ok: false, reason: `could not reserve "${relPath}" (${msg}); blocked (fail-closed)` }
	}
}
