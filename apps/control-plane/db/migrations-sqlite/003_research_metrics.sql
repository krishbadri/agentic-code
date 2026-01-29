-- Research Metrics Migration (SQLite-compatible)

-- Add sub_tx_id and checkpoint_before to tool_call if not exists
-- SQLite doesn't support DO blocks, so we check manually
-- Note: This should be run after initial schema, so columns may already exist

-- Add sub_tx_id column if not exists
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use a workaround
-- We'll check in code before adding

-- Add checkpoint_before column if not exists
-- (Same workaround as above)

-- NOTE: The index on sub_tx_id is created in code after the ALTER TABLE adds the column
-- See migrateSqlite() in db.ts

-- Model Call table
CREATE TABLE IF NOT EXISTS model_call (
    call_id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id TEXT REFERENCES "transaction"(tx_id),
    sub_tx_id TEXT REFERENCES sub_transaction(sub_tx_id),
    model_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,  -- SHA256 hash
    message_count INTEGER NOT NULL,
    temperature REAL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_model_call_tx ON model_call(tx_id);
CREATE INDEX IF NOT EXISTS idx_model_call_sub_tx ON model_call(sub_tx_id);
CREATE INDEX IF NOT EXISTS idx_model_call_model ON model_call(model_id);

-- Rollback Metrics table
CREATE TABLE IF NOT EXISTS metric_rollback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id TEXT REFERENCES "transaction"(tx_id),
    sub_tx_id TEXT REFERENCES sub_transaction(sub_tx_id),
    duration_ms INTEGER NOT NULL,
    files_affected INTEGER,
    bytes_rolled_back INTEGER,
    rollback_type TEXT NOT NULL CHECK(rollback_type IN ('transaction', 'sub_transaction', 'checkpoint')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_metric_rollback_tx ON metric_rollback(tx_id);
CREATE INDEX IF NOT EXISTS idx_metric_rollback_type ON metric_rollback(rollback_type);

-- Execution Metrics table
CREATE TABLE IF NOT EXISTS metric_execution (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id TEXT REFERENCES "transaction"(tx_id),
    execution_mode TEXT NOT NULL CHECK(execution_mode IN ('parallel', 'serial')),
    sub_tx_count INTEGER NOT NULL,
    total_duration_ms INTEGER NOT NULL,
    wall_clock_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_metric_execution_tx ON metric_execution(tx_id);
CREATE INDEX IF NOT EXISTS idx_metric_execution_mode ON metric_execution(execution_mode);

-- Replay Log table
CREATE TABLE IF NOT EXISTS replay_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id TEXT REFERENCES "transaction"(tx_id),
    from_checkpoint TEXT NOT NULL,
    to_checkpoint TEXT,
    tool_calls_replayed INTEGER NOT NULL,
    success INTEGER NOT NULL,  -- SQLite BOOLEAN as INTEGER
    error_message TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_replay_log_tx ON replay_log(tx_id);
