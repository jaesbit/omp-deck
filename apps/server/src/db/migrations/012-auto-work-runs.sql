-- 011-auto-work-runs.sql
--
-- T-62: Auto Work run history and cost tracking. A row is inserted with
-- status='running' the instant a run starts and closed out (completed_at,
-- status, tokens, pct_consumed) when it finishes. task_priority is
-- denormalized from the task at run-start time so the cost-estimate query
-- (last N completed runs at a given priority) never needs to join tasks.

CREATE TABLE IF NOT EXISTS auto_work_runs (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    task_priority   TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    worktree_path   TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    status          TEXT NOT NULL DEFAULT 'running',
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    pct_consumed    REAL,
    failure_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_auto_work_runs_task_id ON auto_work_runs (task_id);
CREATE INDEX IF NOT EXISTS idx_auto_work_runs_priority_status_started
    ON auto_work_runs (task_priority, status, started_at DESC);
