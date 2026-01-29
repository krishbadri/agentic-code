-- Migration 004: Persist generated plans (SQLite-compatible)

CREATE TABLE IF NOT EXISTS plan (
  plan_id TEXT PRIMARY KEY,
  tx_id TEXT REFERENCES "transaction"(tx_id),
  
  -- Plan metadata
  title TEXT,
  summary TEXT,
  user_prompt TEXT,
  
  -- Full plan JSON (stored as TEXT in SQLite)
  plan_json TEXT NOT NULL,
  
  -- Plan statistics
  sub_tx_count INTEGER NOT NULL DEFAULT 0,
  
  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for querying plans by transaction
CREATE INDEX IF NOT EXISTS idx_plan_tx ON plan(tx_id);

-- Index for querying plans by creation time
CREATE INDEX IF NOT EXISTS idx_plan_created ON plan(created_at DESC);
