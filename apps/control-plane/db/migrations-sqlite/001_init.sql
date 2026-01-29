-- Core schema (SQLite-compatible)
-- Note: SQLite doesn't support ENUM, JSONB, UUID, BIGSERIAL natively
-- We use TEXT, INTEGER, and TEXT with constraints instead

CREATE TABLE IF NOT EXISTS repo (
	repo_id TEXT PRIMARY KEY,
	root_path TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document (
	doc_id TEXT PRIMARY KEY,
	repo_id TEXT REFERENCES repo(repo_id),
	path TEXT NOT NULL,
	UNIQUE (repo_id, path)
);

-- SQLite doesn't support ENUM, use TEXT with CHECK constraint
-- Note: "transaction" is a reserved word in SQLite, must be quoted
CREATE TABLE IF NOT EXISTS "transaction" (
	tx_id TEXT PRIMARY KEY,
	repo_id TEXT REFERENCES repo(repo_id),
	actor_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	isolation_policy TEXT NOT NULL,
	base_commit TEXT NOT NULL,
	head_commit TEXT,
	state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'committed', 'rolled_back', 'aborted')),
	begun_at TEXT NOT NULL DEFAULT (datetime('now')),
	ended_at TEXT
);

CREATE TABLE IF NOT EXISTS version (
	version_id TEXT PRIMARY KEY,
	repo_id TEXT REFERENCES repo(repo_id),
	commit_sha TEXT NOT NULL,
	tag TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	created_by TEXT NOT NULL,
	meta TEXT NOT NULL DEFAULT '{}'  -- JSON stored as TEXT
);

CREATE TABLE IF NOT EXISTS op (
	op_id INTEGER PRIMARY KEY AUTOINCREMENT,
	tx_id TEXT REFERENCES "transaction"(tx_id),
	file_path TEXT NOT NULL,
	patch TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_call (
	call_id INTEGER PRIMARY KEY AUTOINCREMENT,
	tx_id TEXT REFERENCES "transaction"(tx_id),
	tool_name TEXT NOT NULL,
	args_json TEXT NOT NULL,  -- JSON stored as TEXT
	started_at TEXT NOT NULL DEFAULT (datetime('now')),
	duration_ms INTEGER,
	exit_code INTEGER,
	result_digest TEXT
);

CREATE TABLE IF NOT EXISTS metric_commit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	tx_id TEXT REFERENCES "transaction"(tx_id),
	patches INTEGER,
	patch_bytes INTEGER,
	files_touched INTEGER,
	commit_latency_ms INTEGER,
	conflict INTEGER,  -- SQLite uses INTEGER for BOOLEAN (0/1)
	rebase_attempted INTEGER,
	committed INTEGER,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_version_repo ON version(repo_id);
CREATE INDEX IF NOT EXISTS idx_tx_repo ON "transaction"(repo_id);
CREATE INDEX IF NOT EXISTS idx_ops_tx ON op(tx_id);
CREATE INDEX IF NOT EXISTS idx_tool_tx ON tool_call(tx_id);
CREATE INDEX IF NOT EXISTS idx_tx_state ON "transaction"(state);
CREATE INDEX IF NOT EXISTS idx_tc_tool ON tool_call(tool_name);
