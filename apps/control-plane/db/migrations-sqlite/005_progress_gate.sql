-- Progress Gate: Track passing test count (SQLite-compatible)
-- R33: Progress metric - # passing tests is monotonically non-decreasing

CREATE TABLE IF NOT EXISTS progress_baseline (
  tx_id TEXT PRIMARY KEY REFERENCES "transaction"(tx_id) ON DELETE CASCADE,
  passing_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  test_command TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Track progress at each checkpoint
CREATE TABLE IF NOT EXISTS progress_checkpoint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id TEXT NOT NULL REFERENCES "transaction"(tx_id) ON DELETE CASCADE,
  checkpoint_sha TEXT NOT NULL,
  passing_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_progress_checkpoint_tx ON progress_checkpoint(tx_id);
