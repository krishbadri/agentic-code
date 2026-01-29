-- Sub-transaction schema (SQLite-compatible)

CREATE TABLE IF NOT EXISTS sub_transaction (
	sub_tx_id TEXT PRIMARY KEY,
	tx_id TEXT REFERENCES "transaction"(tx_id),

	-- Planning info (from planner)
	title TEXT,
	description TEXT,
	agent_type TEXT,
	prompt TEXT,
	depends_on TEXT,  -- JSON array stored as TEXT
	safety_checks TEXT,  -- JSON array stored as TEXT

	-- Execution info (filled at runtime)
	base_commit TEXT,
	end_commit TEXT,
	status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'RUNNING', 'COMMITTED', 'ABORTED')),
	worktree_path TEXT,

	-- Failure info
	failure_kind TEXT,
	failure_message TEXT,

	-- Timestamps
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	started_at TEXT,
	ended_at TEXT
);

-- Safety check results table
CREATE TABLE IF NOT EXISTS safety_check_result (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	sub_tx_id TEXT REFERENCES sub_transaction(sub_tx_id),
	cmd TEXT NOT NULL,
	exit_code INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	stdout_tail TEXT,
	stderr_tail TEXT,
	passed INTEGER NOT NULL DEFAULT 0,  -- SQLite BOOLEAN as INTEGER
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Safety gate summary
CREATE TABLE IF NOT EXISTS safety_gate (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	sub_tx_id TEXT REFERENCES sub_transaction(sub_tx_id),
	ok INTEGER NOT NULL,  -- SQLite BOOLEAN as INTEGER
	failed_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Retry policy tracking
CREATE TABLE IF NOT EXISTS sub_tx_retry (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	sub_tx_id TEXT REFERENCES sub_transaction(sub_tx_id),
	retry_policy TEXT NOT NULL,
	attempt_number INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sub_tx_tx ON sub_transaction(tx_id);
CREATE INDEX IF NOT EXISTS idx_sub_tx_status ON sub_transaction(status);
CREATE INDEX IF NOT EXISTS idx_sub_tx_agent ON sub_transaction(agent_type);
CREATE INDEX IF NOT EXISTS idx_safety_sub_tx ON safety_check_result(sub_tx_id);
CREATE INDEX IF NOT EXISTS idx_safety_gate_sub_tx ON safety_gate(sub_tx_id);
CREATE INDEX IF NOT EXISTS idx_sub_tx_retry ON sub_tx_retry(sub_tx_id);
