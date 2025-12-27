-- Migration 004: Persist generated plans for auditability
-- P1 FIX: Plans must survive restarts and be queryable

CREATE TABLE IF NOT EXISTS plan (
  plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id UUID REFERENCES transaction(tx_id),
  
  -- Plan metadata
  title TEXT,
  summary TEXT,
  user_prompt TEXT,
  
  -- Full plan JSON (for exact reproducibility)
  plan_json JSONB NOT NULL,
  
  -- Plan statistics
  sub_tx_count INT NOT NULL DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for querying plans by transaction
CREATE INDEX IF NOT EXISTS idx_plan_tx ON plan(tx_id);

-- Index for querying plans by creation time
CREATE INDEX IF NOT EXISTS idx_plan_created ON plan(created_at DESC);

