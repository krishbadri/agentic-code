-- Core schema
CREATE TABLE IF NOT EXISTS repo (
	repo_id UUID PRIMARY KEY,
	root_path TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document (
	doc_id UUID PRIMARY KEY,
	repo_id UUID REFERENCES repo(repo_id),
	path TEXT NOT NULL,
	UNIQUE (repo_id, path)
);

CREATE TYPE tx_state AS ENUM ('active','committed','rolled_back','aborted');

CREATE TABLE IF NOT EXISTS transaction (
	tx_id UUID PRIMARY KEY,
	repo_id UUID REFERENCES repo(repo_id),
	actor_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	isolation_policy TEXT NOT NULL,
	base_commit CHAR(40) NOT NULL,
	head_commit CHAR(40),
	state tx_state NOT NULL DEFAULT 'active',
	begun_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS version (
	version_id UUID PRIMARY KEY,
	repo_id UUID REFERENCES repo(repo_id),
	commit_sha CHAR(40) NOT NULL,
	tag TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_by TEXT NOT NULL,
	meta JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS op (
	op_id BIGSERIAL PRIMARY KEY,
	tx_id UUID REFERENCES transaction(tx_id),
	file_path TEXT NOT NULL,
	patch TEXT NOT NULL,
	bytes INT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_call (
	call_id BIGSERIAL PRIMARY KEY,
	tx_id UUID REFERENCES transaction(tx_id),
	tool_name TEXT NOT NULL,
	args_json JSONB NOT NULL,
	started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	duration_ms INT,
	exit_code INT,
	result_digest TEXT
);

CREATE TABLE IF NOT EXISTS metric_commit (
	id BIGSERIAL PRIMARY KEY,
	tx_id UUID REFERENCES transaction(tx_id),
	patches INT,
	patch_bytes BIGINT,
	files_touched INT,
	commit_latency_ms INT,
	conflict BOOLEAN,
	rebase_attempted BOOLEAN,
	committed BOOLEAN,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_version_repo ON version(repo_id);
CREATE INDEX IF NOT EXISTS idx_tx_repo ON transaction(repo_id);
CREATE INDEX IF NOT EXISTS idx_ops_tx ON op(tx_id);
CREATE INDEX IF NOT EXISTS idx_tool_tx ON tool_call(tx_id);
CREATE INDEX IF NOT EXISTS idx_tx_state ON transaction(state);
CREATE INDEX IF NOT EXISTS idx_tc_tool ON tool_call(tool_name);


