-- Research Metrics Migration
-- Adds tables for P3 Replay support and Section 11 Evaluation Metrics

-- ============================================================================
-- Extend tool_call table with sub_tx_id and checkpoint_before
-- ============================================================================

-- Add sub_tx_id column to existing tool_call table if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'tool_call' AND column_name = 'sub_tx_id') THEN
        ALTER TABLE tool_call ADD COLUMN sub_tx_id UUID REFERENCES sub_transaction(sub_tx_id);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'tool_call' AND column_name = 'checkpoint_before') THEN
        ALTER TABLE tool_call ADD COLUMN checkpoint_before CHAR(40);
    END IF;
END $$;

-- Index for sub-transaction queries
CREATE INDEX IF NOT EXISTS idx_tool_call_sub_tx ON tool_call(sub_tx_id);

-- ============================================================================
-- Model Call table (P3 Reproducibility)
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_call (
    call_id BIGSERIAL PRIMARY KEY,
    tx_id UUID REFERENCES transaction(tx_id),
    sub_tx_id UUID REFERENCES sub_transaction(sub_tx_id),
    model_id TEXT NOT NULL,
    prompt_hash CHAR(64) NOT NULL,  -- SHA256 hash
    message_count INT NOT NULL,
    temperature FLOAT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INT
);

CREATE INDEX IF NOT EXISTS idx_model_call_tx ON model_call(tx_id);
CREATE INDEX IF NOT EXISTS idx_model_call_sub_tx ON model_call(sub_tx_id);
CREATE INDEX IF NOT EXISTS idx_model_call_model ON model_call(model_id);

-- ============================================================================
-- Rollback Metrics table (Section 11 Evaluation)
-- ============================================================================

CREATE TYPE rollback_type AS ENUM ('transaction', 'sub_transaction', 'checkpoint');

CREATE TABLE IF NOT EXISTS metric_rollback (
    id BIGSERIAL PRIMARY KEY,
    tx_id UUID REFERENCES transaction(tx_id),
    sub_tx_id UUID REFERENCES sub_transaction(sub_tx_id),
    duration_ms INT NOT NULL,
    files_affected INT,
    bytes_rolled_back BIGINT,
    rollback_type rollback_type NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metric_rollback_tx ON metric_rollback(tx_id);
CREATE INDEX IF NOT EXISTS idx_metric_rollback_type ON metric_rollback(rollback_type);

-- ============================================================================
-- Execution Metrics table (Parallel Speedup Tracking)
-- ============================================================================

CREATE TYPE execution_mode AS ENUM ('parallel', 'serial');

CREATE TABLE IF NOT EXISTS metric_execution (
    id BIGSERIAL PRIMARY KEY,
    tx_id UUID REFERENCES transaction(tx_id),
    execution_mode execution_mode NOT NULL,
    sub_tx_count INT NOT NULL,
    total_duration_ms INT NOT NULL,  -- Sum of all sub-tx durations
    wall_clock_ms INT NOT NULL,      -- Actual wall clock time
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metric_execution_tx ON metric_execution(tx_id);
CREATE INDEX IF NOT EXISTS idx_metric_execution_mode ON metric_execution(execution_mode);

-- ============================================================================
-- Replay Log table (for deterministic replay)
-- ============================================================================

CREATE TABLE IF NOT EXISTS replay_log (
    id BIGSERIAL PRIMARY KEY,
    tx_id UUID REFERENCES transaction(tx_id),
    from_checkpoint CHAR(40) NOT NULL,
    to_checkpoint CHAR(40),
    tool_calls_replayed INT NOT NULL,
    success BOOLEAN NOT NULL,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INT
);

CREATE INDEX IF NOT EXISTS idx_replay_log_tx ON replay_log(tx_id);


