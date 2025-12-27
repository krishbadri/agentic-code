-- Sub-transaction state enum
CREATE TYPE sub_tx_status AS ENUM ('PENDING', 'RUNNING', 'COMMITTED', 'ABORTED');

-- Sub-transaction table (nested transactions within a parent transaction)
CREATE TABLE IF NOT EXISTS sub_transaction (
	sub_tx_id UUID PRIMARY KEY,
	tx_id UUID REFERENCES transaction(tx_id),

	-- Planning info (from planner)
	title TEXT,
	description TEXT,
	agent_type TEXT,
	prompt TEXT,
	depends_on UUID[],
	safety_checks TEXT[],

	-- Execution info (filled at runtime)
	base_commit CHAR(40),
	end_commit CHAR(40),
	status sub_tx_status NOT NULL DEFAULT 'PENDING',
	worktree_path TEXT,

	-- Failure info
	failure_kind TEXT,
	failure_message TEXT,

	-- Timestamps
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	started_at TIMESTAMPTZ,
	ended_at TIMESTAMPTZ
);

-- Safety check results table (captures results of running safety checks)
CREATE TABLE IF NOT EXISTS safety_check_result (
	id BIGSERIAL PRIMARY KEY,
	sub_tx_id UUID REFERENCES sub_transaction(sub_tx_id),
	cmd TEXT NOT NULL,
	exit_code INT NOT NULL,
	duration_ms INT NOT NULL,
	stdout_tail TEXT,
	stderr_tail TEXT,
	passed BOOLEAN NOT NULL DEFAULT false,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safety gate summary (aggregate result for a sub-transaction's safety checks)
CREATE TABLE IF NOT EXISTS safety_gate (
	id BIGSERIAL PRIMARY KEY,
	sub_tx_id UUID REFERENCES sub_transaction(sub_tx_id),
	ok BOOLEAN NOT NULL,
	failed_at TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retry policy tracking
CREATE TABLE IF NOT EXISTS sub_tx_retry (
	id BIGSERIAL PRIMARY KEY,
	sub_tx_id UUID REFERENCES sub_transaction(sub_tx_id),
	retry_policy TEXT NOT NULL,
	attempt_number INT NOT NULL DEFAULT 1,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for sub-transaction queries
CREATE INDEX IF NOT EXISTS idx_sub_tx_tx ON sub_transaction(tx_id);
CREATE INDEX IF NOT EXISTS idx_sub_tx_status ON sub_transaction(status);
CREATE INDEX IF NOT EXISTS idx_sub_tx_agent ON sub_transaction(agent_type);
CREATE INDEX IF NOT EXISTS idx_safety_sub_tx ON safety_check_result(sub_tx_id);
CREATE INDEX IF NOT EXISTS idx_safety_gate_sub_tx ON safety_gate(sub_tx_id);
CREATE INDEX IF NOT EXISTS idx_sub_tx_retry ON sub_tx_retry(sub_tx_id);

