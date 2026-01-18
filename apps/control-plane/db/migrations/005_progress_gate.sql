-- Progress Gate: Track passing test count for monotonicity enforcement
-- R33: Progress metric - # passing tests is monotonically non-decreasing

CREATE TABLE IF NOT EXISTS progress_baseline (
  tx_id UUID PRIMARY KEY REFERENCES transaction(tx_id) ON DELETE CASCADE,
  passing_count INT NOT NULL,
  total_count INT NOT NULL,
  test_command TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Track progress at each checkpoint
CREATE TABLE IF NOT EXISTS progress_checkpoint (
  id BIGSERIAL PRIMARY KEY,
  tx_id UUID NOT NULL REFERENCES transaction(tx_id) ON DELETE CASCADE,
  checkpoint_sha CHAR(40) NOT NULL,
  passing_count INT NOT NULL,
  total_count INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_progress_checkpoint_tx ON progress_checkpoint(tx_id);
