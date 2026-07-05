-- 009-auto-work-config.sql
--
-- T-60: per-workspace Auto Work configuration — enable flag, per-priority
-- model overrides, execution time window, and consumption limits. Row
-- absence means "unconfigured"; the DB layer returns computed defaults for
-- any cwd without a row rather than inserting one eagerly.

CREATE TABLE IF NOT EXISTS auto_work_config (
    workspace_cwd      TEXT PRIMARY KEY,
    enabled             INTEGER NOT NULL DEFAULT 0,
    model_by_priority   TEXT NOT NULL DEFAULT '{}',
    time_window_start   INTEGER NOT NULL DEFAULT 0,
    time_window_end     INTEGER NOT NULL DEFAULT 24,
    session_pct_limit   REAL NOT NULL DEFAULT 100,
    weekly_pct_limit    REAL NOT NULL DEFAULT 100,
    updated_at          TEXT NOT NULL
);
