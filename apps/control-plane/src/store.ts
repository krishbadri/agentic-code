import type { Pool } from "pg"
import type { DbPool } from "./db-adapter.js"
import { randomUUID } from "node:crypto"

// Type alias: DbPool is Pool-compatible, so we can use it interchangeably
type Db = Pool | DbPool

export async function getOrCreateRepo(pool: Db, root_path: string) {
	const q1 = await pool.query("SELECT repo_id FROM repo WHERE root_path = $1", [root_path])
	if (q1.rowCount) return q1.rows[0].repo_id as string
	const repo_id = randomUUID()
	await pool.query("INSERT INTO repo (repo_id, root_path) VALUES ($1, $2)", [repo_id, root_path])
	return repo_id
}

export type TxRow = {
	tx_id: string
	repo_id: string
	actor_id: string
	agent_id: string
	isolation_policy: string
	base_commit: string
}

export async function insertTransaction(pool: Db, row: TxRow) {
	await pool.query(
		`INSERT INTO "transaction" (tx_id, repo_id, actor_id, agent_id, isolation_policy, base_commit) VALUES ($1,$2,$3,$4,$5,$6)`,
		[row.tx_id, row.repo_id, row.actor_id, row.agent_id, row.isolation_policy, row.base_commit],
	)
}

export async function updateTransactionHead(pool: Db, tx_id: string, head_commit: string) {
	await pool.query(`UPDATE "transaction" SET head_commit = $2 WHERE tx_id = $1`, [tx_id, head_commit])
}

export async function finalizeTransaction(pool: Db, tx_id: string, state: "committed" | "rolled_back" | "aborted") {
	await pool.query(`UPDATE "transaction" SET state = $2, ended_at = now() WHERE tx_id = $1`, [tx_id, state])
}

export async function insertVersion(
	pool: Db,
	repo_id: string,
	commit_sha: string,
	tag: string,
	created_by: string,
	meta: any = {},
) {
	const version_id = randomUUID()
	await pool.query(
		`INSERT INTO version (version_id, repo_id, commit_sha, tag, created_by, meta) VALUES ($1,$2,$3,$4,$5,$6)`,
		[version_id, repo_id, commit_sha, tag, created_by, meta],
	)
	return version_id
}

export async function listVersions(pool: Db, repo_id: string, limit = 50, after?: string) {
	if (after) {
		const q = await pool.query(
			`SELECT version_id, commit_sha, tag, created_at, created_by FROM version WHERE repo_id=$1 AND created_at < (SELECT created_at FROM version WHERE version_id=$2) ORDER BY created_at DESC LIMIT $3`,
			[repo_id, after, limit],
		)
		return q.rows
	}
	const q = await pool.query(
		`SELECT version_id, commit_sha, tag, created_at, created_by FROM version WHERE repo_id=$1 ORDER BY created_at DESC LIMIT $2`,
		[repo_id, limit],
	)
	return q.rows
}

export async function getTransaction(pool: Db, tx_id: string): Promise<TxRow | null> {
	const q = await pool.query(
		`SELECT tx_id, repo_id, actor_id, agent_id, isolation_policy, base_commit FROM "transaction" WHERE tx_id = $1`,
		[tx_id],
	)
	return q.rowCount ? (q.rows[0] as TxRow) : null
}

// ============================================================================
// Sub-Transaction CRUD Operations
// ============================================================================

export type SubTxRow = {
	sub_tx_id: string
	tx_id: string
	title?: string
	description?: string
	agent_type?: string
	prompt?: string
	depends_on?: string[]
	safety_checks?: string[]
	base_commit?: string
	end_commit?: string
	status: "PENDING" | "RUNNING" | "COMMITTED" | "ABORTED"
	worktree_path?: string
	failure_kind?: string
	failure_message?: string
	created_at: Date
	started_at?: Date
	ended_at?: Date
}

export type SafetyCheckResultRow = {
	cmd: string
	exit_code: number
	duration_ms: number
	stdout_tail?: string
	stderr_tail?: string
	passed: boolean
}

export type SafetyGateRow = {
	ok: boolean
	failed_at?: string
	results: SafetyCheckResultRow[]
}

export async function insertSubTransaction(
	pool: Db,
	subTx: {
		sub_tx_id: string
		tx_id: string
		title?: string
		description?: string
		agent_type?: string
		prompt?: string
		depends_on?: string[]
		safety_checks?: string[]
		base_commit?: string
		status?: "PENDING" | "RUNNING" | "COMMITTED" | "ABORTED"
		worktree_path?: string
	},
) {
	// SQLite can only bind numbers, strings, bigints, buffers, and null
	// Arrays and Date objects must be serialized
	const dependsOnJson = subTx.depends_on ? JSON.stringify(subTx.depends_on) : null
	const safetyChecksJson = subTx.safety_checks ? JSON.stringify(subTx.safety_checks) : null
	const startedAt = subTx.status === "RUNNING" ? new Date().toISOString() : null

	// Use INSERT OR REPLACE to handle reruns gracefully (idempotency)
	// This ensures that if a sub_tx_id already exists, we update it instead of failing
	await pool.query(
		`INSERT OR REPLACE INTO sub_transaction 
		 (sub_tx_id, tx_id, title, description, agent_type, prompt, depends_on, safety_checks, 
		  base_commit, status, worktree_path, started_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		[
			subTx.sub_tx_id,
			subTx.tx_id,
			subTx.title ?? null,
			subTx.description ?? null,
			subTx.agent_type ?? null,
			subTx.prompt ?? null,
			dependsOnJson,
			safetyChecksJson,
			subTx.base_commit ?? null,
			subTx.status ?? "RUNNING",
			subTx.worktree_path ?? null,
			startedAt,
		],
	)
}

export async function updateSubTransactionStatus(
	pool: Db,
	sub_tx_id: string,
	status: "PENDING" | "RUNNING" | "COMMITTED" | "ABORTED",
	end_commit?: string,
	failure?: { kind: string; message: string },
) {
	await pool.query(
		`UPDATE sub_transaction 
		 SET status = $2, end_commit = $3, failure_kind = $4, failure_message = $5, ended_at = now()
		 WHERE sub_tx_id = $1`,
		[sub_tx_id, status, end_commit ?? null, failure?.kind ?? null, failure?.message ?? null],
	)
}

export async function getSubTransaction(pool: Db, sub_tx_id: string): Promise<SubTxRow | null> {
	const q = await pool.query(`SELECT * FROM sub_transaction WHERE sub_tx_id = $1`, [sub_tx_id])
	return q.rowCount ? (q.rows[0] as SubTxRow) : null
}

export async function getSubTransactionsForTx(pool: Db, tx_id: string): Promise<SubTxRow[]> {
	const q = await pool.query(`SELECT * FROM sub_transaction WHERE tx_id = $1 ORDER BY created_at`, [tx_id])
	return q.rows as SubTxRow[]
}

export async function insertSafetyCheckResult(pool: Db, sub_tx_id: string, result: SafetyCheckResultRow) {
	// SQLite stores booleans as integers (0 or 1)
	const passedInt = result.passed ? 1 : 0

	await pool.query(
		`INSERT INTO safety_check_result (sub_tx_id, cmd, exit_code, duration_ms, stdout_tail, stderr_tail, passed)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[
			sub_tx_id,
			result.cmd,
			result.exit_code,
			result.duration_ms,
			result.stdout_tail ?? null,
			result.stderr_tail ?? null,
			passedInt,
		],
	)
}

export async function insertSafetyCheckResults(pool: Db, sub_tx_id: string, results: SafetyCheckResultRow[]) {
	for (const r of results) {
		await insertSafetyCheckResult(pool, sub_tx_id, r)
	}
}

export async function insertSafetyGate(pool: Db, sub_tx_id: string, gate: { ok: boolean; failed_at?: string }) {
	// SQLite stores booleans as integers (0 or 1)
	const okInt = gate.ok ? 1 : 0

	await pool.query(`INSERT INTO safety_gate (sub_tx_id, ok, failed_at) VALUES ($1, $2, $3)`, [
		sub_tx_id,
		okInt,
		gate.failed_at ?? null,
	])
}

export async function getSafetyCheckResults(pool: Db, sub_tx_id: string): Promise<SafetyCheckResultRow[]> {
	const q = await pool.query(
		`SELECT cmd, exit_code, duration_ms, stdout_tail, stderr_tail, passed 
		 FROM safety_check_result WHERE sub_tx_id = $1 ORDER BY id`,
		[sub_tx_id],
	)
	return q.rows as SafetyCheckResultRow[]
}

export async function getSafetyGate(pool: Db, sub_tx_id: string): Promise<SafetyGateRow | null> {
	const gateQ = await pool.query(
		`SELECT ok, failed_at FROM safety_gate WHERE sub_tx_id = $1 ORDER BY id DESC LIMIT 1`,
		[sub_tx_id],
	)
	if (!gateQ.rowCount) return null

	const results = await getSafetyCheckResults(pool, sub_tx_id)
	return {
		ok: gateQ.rows[0].ok,
		failed_at: gateQ.rows[0].failed_at,
		results,
	}
}

export async function insertSubTxRetry(pool: Db, sub_tx_id: string, retry_policy: string, attempt_number: number) {
	await pool.query(`INSERT INTO sub_tx_retry (sub_tx_id, retry_policy, attempt_number) VALUES ($1, $2, $3)`, [
		sub_tx_id,
		retry_policy,
		attempt_number,
	])
}

// ============================================================================
// Tool Call CRUD Operations (P3 Replay Support)
// ============================================================================

export type ToolCallRow = {
	call_id: number
	tx_id: string
	sub_tx_id?: string
	tool_name: string
	args_json: Record<string, unknown>
	checkpoint_before?: string
	started_at: Date
	duration_ms?: number
	exit_code?: number
	result_digest?: string
}

export async function insertToolCall(
	pool: Db,
	toolCall: {
		tx_id: string
		sub_tx_id?: string
		tool_name: string
		args_json: Record<string, unknown>
		checkpoint_before?: string
		duration_ms?: number
		exit_code?: number
		result_digest?: string
	},
): Promise<number> {
	const q = await pool.query(
		`INSERT INTO tool_call 
		 (tx_id, sub_tx_id, tool_name, args_json, checkpoint_before, duration_ms, exit_code, result_digest)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING call_id`,
		[
			toolCall.tx_id,
			toolCall.sub_tx_id ?? null,
			toolCall.tool_name,
			toolCall.args_json,
			toolCall.checkpoint_before ?? null,
			toolCall.duration_ms ?? null,
			toolCall.exit_code ?? null,
			toolCall.result_digest ?? null,
		],
	)
	return q.rows[0].call_id as number
}

export async function getToolCallsForTx(pool: Db, tx_id: string): Promise<ToolCallRow[]> {
	const q = await pool.query(
		`SELECT call_id, tx_id, sub_tx_id, tool_name, args_json, checkpoint_before, started_at, duration_ms, exit_code, result_digest
		 FROM tool_call WHERE tx_id = $1 ORDER BY started_at`,
		[tx_id],
	)
	return q.rows as ToolCallRow[]
}

export async function getToolCallsForSubTx(pool: Db, sub_tx_id: string): Promise<ToolCallRow[]> {
	const q = await pool.query(
		`SELECT call_id, tx_id, sub_tx_id, tool_name, args_json, checkpoint_before, started_at, duration_ms, exit_code, result_digest
		 FROM tool_call WHERE sub_tx_id = $1 ORDER BY started_at`,
		[sub_tx_id],
	)
	return q.rows as ToolCallRow[]
}

// ============================================================================
// Model Call CRUD Operations (P3 Reproducibility)
// ============================================================================

export type ModelCallRow = {
	call_id: number
	tx_id: string
	sub_tx_id?: string
	model_id: string
	prompt_hash: string
	message_count: number
	temperature?: number
	started_at: Date
	duration_ms?: number
}

export async function insertModelCall(
	pool: Db,
	modelCall: {
		tx_id: string
		sub_tx_id?: string
		model_id: string
		prompt_hash: string
		message_count: number
		temperature?: number
		duration_ms?: number
	},
): Promise<number> {
	const q = await pool.query(
		`INSERT INTO model_call 
		 (tx_id, sub_tx_id, model_id, prompt_hash, message_count, temperature, duration_ms)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING call_id`,
		[
			modelCall.tx_id,
			modelCall.sub_tx_id ?? null,
			modelCall.model_id,
			modelCall.prompt_hash,
			modelCall.message_count,
			modelCall.temperature ?? null,
			modelCall.duration_ms ?? null,
		],
	)
	return q.rows[0].call_id as number
}

export async function getModelCallsForTx(pool: Db, tx_id: string): Promise<ModelCallRow[]> {
	const q = await pool.query(
		`SELECT call_id, tx_id, sub_tx_id, model_id, prompt_hash, message_count, temperature, started_at, duration_ms
		 FROM model_call WHERE tx_id = $1 ORDER BY started_at`,
		[tx_id],
	)
	return q.rows as ModelCallRow[]
}

// ============================================================================
// Rollback Metrics CRUD Operations (Section 11 Evaluation)
// ============================================================================

export type MetricRollbackRow = {
	id: number
	tx_id?: string
	sub_tx_id?: string
	duration_ms: number
	files_affected?: number
	bytes_rolled_back?: number
	rollback_type: "transaction" | "sub_transaction" | "checkpoint"
	created_at: Date
}

export async function insertMetricRollback(
	pool: Db,
	metric: {
		tx_id?: string
		sub_tx_id?: string
		duration_ms: number
		files_affected?: number
		bytes_rolled_back?: number
		rollback_type: "transaction" | "sub_transaction" | "checkpoint"
	},
): Promise<number> {
	const q = await pool.query(
		`INSERT INTO metric_rollback 
		 (tx_id, sub_tx_id, duration_ms, files_affected, bytes_rolled_back, rollback_type)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id`,
		[
			metric.tx_id ?? null,
			metric.sub_tx_id ?? null,
			metric.duration_ms,
			metric.files_affected ?? null,
			metric.bytes_rolled_back ?? null,
			metric.rollback_type,
		],
	)
	return q.rows[0].id as number
}

export async function getMetricRollbackStats(
	pool: Db,
	tx_id?: string,
): Promise<{
	total_rollbacks: number
	avg_duration_ms: number
	total_files_affected: number
	total_bytes_rolled_back: number
}> {
	const whereClause = tx_id ? "WHERE tx_id = $1" : ""
	const params = tx_id ? [tx_id] : []
	const q = await pool.query(
		`SELECT 
		   COUNT(*)::int as total_rollbacks,
		   COALESCE(AVG(duration_ms), 0)::int as avg_duration_ms,
		   COALESCE(SUM(files_affected), 0)::int as total_files_affected,
		   COALESCE(SUM(bytes_rolled_back), 0)::bigint as total_bytes_rolled_back
		 FROM metric_rollback ${whereClause}`,
		params,
	)
	return q.rows[0]
}

// ============================================================================
// Execution Metrics CRUD Operations (Parallel Speedup Tracking)
// ============================================================================

export type MetricExecutionRow = {
	id: number
	tx_id: string
	execution_mode: "parallel" | "serial"
	sub_tx_count: number
	total_duration_ms: number
	wall_clock_ms: number
	created_at: Date
}

export async function insertMetricExecution(
	pool: Db,
	metric: {
		tx_id: string
		execution_mode: "parallel" | "serial"
		sub_tx_count: number
		total_duration_ms: number
		wall_clock_ms: number
	},
): Promise<number> {
	const q = await pool.query(
		`INSERT INTO metric_execution 
		 (tx_id, execution_mode, sub_tx_count, total_duration_ms, wall_clock_ms)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[metric.tx_id, metric.execution_mode, metric.sub_tx_count, metric.total_duration_ms, metric.wall_clock_ms],
	)
	return q.rows[0].id as number
}

export async function getParallelSpeedupStats(pool: Db): Promise<{
	parallel_avg_wall_clock_ms: number
	serial_avg_wall_clock_ms: number
	speedup_ratio: number
}> {
	const q = await pool.query(
		`SELECT 
		   COALESCE(AVG(CASE WHEN execution_mode = 'parallel' THEN wall_clock_ms END), 0)::int as parallel_avg_wall_clock_ms,
		   COALESCE(AVG(CASE WHEN execution_mode = 'serial' THEN wall_clock_ms END), 0)::int as serial_avg_wall_clock_ms,
		   CASE 
		     WHEN COALESCE(AVG(CASE WHEN execution_mode = 'parallel' THEN wall_clock_ms END), 0) = 0 THEN 0
		     ELSE COALESCE(AVG(CASE WHEN execution_mode = 'serial' THEN wall_clock_ms END), 0) / 
		          NULLIF(AVG(CASE WHEN execution_mode = 'parallel' THEN wall_clock_ms END), 0)
		   END::float as speedup_ratio
		 FROM metric_execution`,
	)
	return q.rows[0]
}

// ============================================================================
// Plan CRUD Operations (P1 - Plan Persistence)
// ============================================================================

export type PlanRow = {
	plan_id: string
	tx_id: string
	title?: string
	summary?: string
	user_prompt?: string
	plan_json: Record<string, unknown>
	sub_tx_count: number
	created_at: Date
}

export async function insertPlan(
	pool: Db,
	plan: {
		tx_id: string
		title?: string
		summary?: string
		user_prompt?: string
		plan_json: Record<string, unknown>
		sub_tx_count: number
	},
): Promise<string> {
	// Generate plan_id before insert (SQLite doesn't support DEFAULT with functions in all cases)
	const plan_id = randomUUID()
	const q = await pool.query(
		`INSERT INTO plan 
		 (plan_id, tx_id, title, summary, user_prompt, plan_json, sub_tx_count)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING plan_id`,
		[
			plan_id,
			plan.tx_id,
			plan.title ?? null,
			plan.summary ?? null,
			plan.user_prompt ?? null,
			plan.plan_json,
			plan.sub_tx_count,
		],
	)
	return plan_id
}

export async function getPlan(pool: Db, tx_id: string): Promise<PlanRow | null> {
	const q = await pool.query(
		`SELECT plan_id, tx_id, title, summary, user_prompt, plan_json, sub_tx_count, created_at
		 FROM plan WHERE tx_id = $1 ORDER BY created_at DESC LIMIT 1`,
		[tx_id],
	)
	return q.rowCount ? (q.rows[0] as PlanRow) : null
}

export async function getPlanById(pool: Db, plan_id: string): Promise<PlanRow | null> {
	const q = await pool.query(
		`SELECT plan_id, tx_id, title, summary, user_prompt, plan_json, sub_tx_count, created_at
		 FROM plan WHERE plan_id = $1`,
		[plan_id],
	)
	return q.rowCount ? (q.rows[0] as PlanRow) : null
}

export async function listPlans(pool: Db, limit = 50): Promise<PlanRow[]> {
	const q = await pool.query(
		`SELECT plan_id, tx_id, title, summary, user_prompt, plan_json, sub_tx_count, created_at
		 FROM plan ORDER BY created_at DESC LIMIT $1`,
		[limit],
	)
	return q.rows as PlanRow[]
}

// ============================================================================
// Progress Gate (R33): Monotonic non-decreasing passing test count
// ============================================================================

export interface ProgressBaseline {
	tx_id: string
	passing_count: number
	total_count: number
	test_command: string
	created_at: Date
}

export async function setProgressBaseline(
	pool: Db,
	tx_id: string,
	passing_count: number,
	total_count: number,
	test_command: string,
): Promise<void> {
	await pool.query(
		`INSERT INTO progress_baseline (tx_id, passing_count, total_count, test_command)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (tx_id) DO UPDATE SET
		   passing_count = GREATEST(progress_baseline.passing_count, $2),
		   total_count = $3,
		   updated_at = now()`,
		[tx_id, passing_count, total_count, test_command],
	)
}

export async function getProgressBaseline(pool: Db, tx_id: string): Promise<ProgressBaseline | null> {
	const q = await pool.query(
		`SELECT tx_id, passing_count, total_count, test_command, created_at
		 FROM progress_baseline WHERE tx_id = $1`,
		[tx_id],
	)
	return q.rowCount ? (q.rows[0] as ProgressBaseline) : null
}

export async function recordProgressCheckpoint(
	pool: Db,
	tx_id: string,
	checkpoint_sha: string,
	passing_count: number,
	total_count: number,
): Promise<void> {
	await pool.query(
		`INSERT INTO progress_checkpoint (tx_id, checkpoint_sha, passing_count, total_count)
		 VALUES ($1, $2, $3, $4)`,
		[tx_id, checkpoint_sha, passing_count, total_count],
	)
}

export async function getLastProgressCheckpoint(
	pool: Db,
	tx_id: string,
): Promise<{ checkpoint_sha: string; passing_count: number } | null> {
	const q = await pool.query(
		`SELECT checkpoint_sha, passing_count FROM progress_checkpoint
		 WHERE tx_id = $1 ORDER BY created_at DESC LIMIT 1`,
		[tx_id],
	)
	return q.rowCount ? (q.rows[0] as { checkpoint_sha: string; passing_count: number }) : null
}
