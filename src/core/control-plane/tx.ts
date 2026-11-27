import type { Clause } from "@roo-code/types"

import { cpRequest, type CpResponse } from "./client"

/**
 * Typed wrappers for every Control-Plane route the extension uses.
 *
 * All functions resolve with `{status, ok, data}` for any HTTP response and
 * throw `ControlPlaneUnavailableError` only on network failure / timeout.
 */

const enc = encodeURIComponent

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface CpHealth {
	status: string
	version?: string
	api?: number
	capabilities?: string[]
	db?: unknown
	test_command_configured?: boolean
}

export interface BeginTxBody {
	isolation: "fail-fast" | "rebase" | "hybrid"
	base: string
	target_branch?: string
	test_command?: string
	compile_command?: string
}

export interface BeginTxResponse {
	tx_id: string
	base_commit: string
	branch: string
	target_branch?: string
	worktree_path: string
	[key: string]: unknown
}

export interface TxInfo {
	status: "active" | "committed" | "aborted"
	worktree_path: string
	base_commit: string
	target_branch?: string
}

export interface CommitResponse {
	merged_sha?: string
	liveness?: { ran: boolean; passed?: boolean; reason?: string }
	code?: string
	message?: string
	rollback_to?: string
	files?: string[]
	[key: string]: unknown
}

export interface CheckpointResponse {
	commit_sha?: string
	code?: string
	message?: string
	rollback_to?: string
	current_count?: number
	last_checkpoint_count?: number
	[key: string]: unknown
}

export interface ActionSafetyArgs {
	path?: string
	paths?: string[]
	command?: string
	cwd_rel?: string
}

export interface ActionSafetyResponse {
	allowed?: boolean
	code?: string
	reason?: string
	rule?: string
	message?: string
}

export interface ShellExecBody {
	command: string
	shell: string
	cwd_rel: string
	timeout_ms: number
	env?: Record<string, string>
}

export interface ShellExecResponse {
	exit_code?: number
	stdout?: string
	stderr?: string
	stdout_base64?: string
	stderr_base64?: string
	code?: string
	message?: string
	[key: string]: unknown
}

export interface SubTxBeginBody {
	base: string
	title?: string
	description?: string
	agentType?: string
	prompt?: string
	dependsOn?: string[]
	safetyChecks?: string[]
}

export interface SubTxBeginResponse {
	worktree_path?: string
	sub_tx_id?: string
	relative_id?: string
	parent_tx_id?: string
	[key: string]: unknown
}

export interface SafetyGateResponse {
	ok: boolean
	results: unknown[]
	failedAt?: string
	reason?: string
	error?: string
	[key: string]: unknown
}

export interface MergePipelineResult {
	subTxId?: string
	sub_tx_id?: string
	status?: "merged" | "rolled_back" | "failed"
	merged?: boolean
	rollback?: boolean
	reason?: string
	error?: string
	conflicts_with?: string[] | string
	conflict_type?: string
	files?: string[]
	merge_commit?: string
}

export interface MergePipelineResponse {
	success: boolean
	total?: number
	merged?: number
	failed?: number
	rolled_back?: number
	merged_ids?: string[]
	rolled_back_ids?: string[]
	failed_ids?: string[]
	order?: string[]
	conflicts?: unknown[]
	dismissed_by_ast?: unknown[]
	results: MergePipelineResult[]
	code?: string
	message?: string
}

export interface ExecutionMetricBody {
	execution_mode: "parallel" | "serial"
	sub_tx_count: number
	total_duration_ms: number
	wall_clock_ms: number
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const health = (port: number, timeoutMs = 2_000): Promise<CpResponse<CpHealth>> =>
	cpRequest(port, "GET", "/health", undefined, { timeoutMs })

export const begin = (port: number, body: BeginTxBody): Promise<CpResponse<BeginTxResponse>> =>
	// Begin may run the baseline test command — allow it time.
	cpRequest(port, "POST", "/tx/begin", body, { timeoutMs: 300_000 })

export const getTx = (port: number, txId: string): Promise<CpResponse<TxInfo>> =>
	cpRequest(port, "GET", `/tx/${enc(txId)}`)

export const abort = (port: number, txId: string, reason: string): Promise<CpResponse<any>> =>
	cpRequest(port, "POST", `/tx/${enc(txId)}/abort`, { reason }, { timeoutMs: 60_000 })

export const commit = (
	port: number,
	txId: string,
	body: { strategy?: string } = {},
): Promise<CpResponse<CommitResponse>> =>
	// Liveness runs the test suite — allow it time.
	cpRequest(port, "POST", `/tx/${enc(txId)}/commit`, body, { timeoutMs: 600_000 })

export const checkpoint = (
	port: number,
	txId: string,
	body: { reason?: string; trailers?: Record<string, string> } = {},
): Promise<CpResponse<CheckpointResponse>> =>
	cpRequest(port, "POST", `/tx/${enc(txId)}/checkpoint`, body, { timeoutMs: 600_000 })

export const rollback = (port: number, txId: string, hash: string): Promise<CpResponse<any>> =>
	cpRequest(port, "POST", `/tx/${enc(txId)}/rollback`, { hash }, { timeoutMs: 60_000 })

export const actionSafety = (
	port: number,
	txId: string,
	body: { action: string; args: ActionSafetyArgs; sub_tx_id?: string },
): Promise<CpResponse<ActionSafetyResponse>> =>
	cpRequest(port, "POST", `/tx/${enc(txId)}/action-safety`, body, { timeoutMs: 10_000 })

export const reserveFile = (
	port: number,
	txId: string,
	body: { file_path: string; claimer_id: string },
): Promise<CpResponse<any>> => cpRequest(port, "POST", `/tx/${enc(txId)}/reserve-file`, body, { timeoutMs: 10_000 })

export const shellExec = (port: number, txId: string, body: ShellExecBody): Promise<CpResponse<ShellExecResponse>> =>
	cpRequest(port, "POST", `/shell/exec/${enc(txId)}`, body, {
		timeoutMs: Math.max(30_000, (body.timeout_ms || 0) + 30_000),
	})

export const subTxBegin = (
	port: number,
	txId: string,
	subTxId: string,
	body: SubTxBeginBody,
): Promise<CpResponse<SubTxBeginResponse>> =>
	cpRequest(port, "POST", `/tx/${enc(txId)}/sub-tx/${enc(subTxId)}/begin`, body, { timeoutMs: 60_000 })

export const subTxSafetyGate = (
	port: number,
	txId: string,
	subTxId: string,
	body: { checks?: string[]; clause?: Clause },
): Promise<CpResponse<SafetyGateResponse>> =>
	cpRequest(port, "POST", `/tx/${enc(txId)}/sub-tx/${enc(subTxId)}/safety-gate`, body, { timeoutMs: 600_000 })

export const subTxRollback = (
	port: number,
	txId: string,
	subTxId: string,
	body: { reason?: string; failureKind?: string } = {},
): Promise<CpResponse<any>> =>
	cpRequest(port, "POST", `/tx/${enc(txId)}/sub-tx/${enc(subTxId)}/rollback`, body, { timeoutMs: 60_000 })

export const mergePipeline = (
	port: number,
	txId: string,
	body: { sub_tx_ids: string[]; depends_on?: Record<string, string[]> },
): Promise<CpResponse<MergePipelineResponse>> =>
	cpRequest(port, "POST", `/tx/${enc(txId)}/merge-pipeline`, body, { timeoutMs: 600_000 })

export const metricExecution = (port: number, txId: string, body: ExecutionMetricBody): Promise<CpResponse<any>> =>
	cpRequest(port, "POST", `/tx/${enc(txId)}/metric/execution`, body)

export const persistPlan = (
	port: number,
	txId: string,
	body: { title?: string; summary?: string; plan_json: unknown; sub_tx_count: number },
): Promise<CpResponse<any>> => cpRequest(port, "POST", `/tx/${enc(txId)}/plan`, body)

export const toolCall = (
	port: number,
	txId: string,
	body: { sub_tx_id?: string; tool_name: string; args_json: unknown; checkpoint_before?: string },
): Promise<CpResponse<any>> => cpRequest(port, "POST", `/tx/${enc(txId)}/tool-call`, body, { timeoutMs: 5_000 })

export const modelCall = (
	port: number,
	txId: string,
	body: { sub_tx_id?: string; model_id: string; prompt_hash: string; message_count: number; duration_ms: number },
): Promise<CpResponse<any>> => cpRequest(port, "POST", `/tx/${enc(txId)}/model-call`, body, { timeoutMs: 5_000 })

export const suggestRollback = (port: number, txId: string, params: URLSearchParams): Promise<CpResponse<any>> =>
	cpRequest(port, "GET", `/tx/${enc(txId)}/suggest-rollback?${params.toString()}`)
