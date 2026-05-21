-- 003-routines-v1.sql
--
-- Lay the data-model foundation for multi-step routines (V1). V0 routines
-- (spec_version=0) continue to work unchanged: the existing `cron`,
-- `action_kind`, `action_body`, `action_cwd` columns stay, and the V0 runner
-- path keeps reading them. V1 routines (spec_version=1) carry their full
-- multi-step pipeline in `spec_yaml`; the V1 runner parses it on each
-- invocation.
--
-- ### routines: V1 metadata columns
--   spec_yaml      — full YAML source-of-truth for V1 routines (NULL for V0)
--   concurrency    — skip | queue | cancel-previous | parallel
--   budget_json    — JSON-serialized RoutineBudget (max_duration_secs, etc.)
--   tags           — comma-separated tag list, for filter UI
--   timezone       — IANA tz name for cron evaluation (NULL = system default)
--   spec_version   — 0 = V0 single-action, 1 = V1 multi-step
--
-- ### routine_runs: V1 aggregates
--   trigger_payload         — JSON of webhook body / manual params / event payload
--   total_llm_tokens        — input+output sum across all agent steps
--   total_llm_cost_micros   — sum * model price, in USD micro-cents
--   aborted_at              — when the runner aborted, distinct from ended_at
--   abort_reason            — 'budget' | 'timeout' | 'cancelled' | 'failure' | 'signature_invalid' | 'concurrency_skipped'
--   step_count_total        — count of routine_step_runs rows for this run
--   step_count_failed       — count of step runs ending in status='failed' or 'aborted'
--
-- The `trigger` column's V0 CHECK constraint allowed only 'cron'|'manual'.
-- V1 needs 'webhook' and 'event' too. SQLite doesn't support ALTER CHECK,
-- so we rebuild the table with a relaxed CHECK. We do NOT add a separate
-- `trigger_kind` column (the plan's task body called for one but it would
-- duplicate `trigger`; pragmatic deviation documented here).
--
-- ### New tables
--   routine_step_runs        — per-step execution record for V1 routines
--   routine_webhook_secrets  — Argon2id-hashed HMAC keys for webhook triggers
--   routine_state            — cross-run state (set_state step persists here)
--
-- ### NOT added (deferred to V1.5)
--   mcp_servers / integrations — MCP install state lives in the omp SDK's
--   MCP client (~/.omp/agent/mcp.json). V1.5 adds a deck-side table if richer
--   dashboard state is needed.

-- ─── routines: extend ─────────────────────────────────────────────────────

ALTER TABLE routines ADD COLUMN spec_yaml    TEXT;
ALTER TABLE routines ADD COLUMN concurrency  TEXT NOT NULL DEFAULT 'skip'
    CHECK (concurrency IN ('skip','queue','cancel-previous','parallel'));
ALTER TABLE routines ADD COLUMN budget_json  TEXT;
ALTER TABLE routines ADD COLUMN tags         TEXT;
ALTER TABLE routines ADD COLUMN timezone     TEXT;
ALTER TABLE routines ADD COLUMN spec_version INTEGER NOT NULL DEFAULT 0;

-- ─── routine_runs: rebuild with relaxed trigger CHECK + V1 columns ────────
--
-- SQLite ALTER CHECK requires a full table rebuild. We do it in one
-- transaction-safe sequence: temp table copy, drop, recreate, repopulate,
-- restore indexes.

CREATE TABLE routine_runs__new (
    id               TEXT PRIMARY KEY,
    routine_id       TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,
    exit_code        INTEGER,
    stdout_excerpt   TEXT NOT NULL DEFAULT '',
    stderr_excerpt   TEXT NOT NULL DEFAULT '',
    error            TEXT,
    trigger          TEXT NOT NULL CHECK (trigger IN ('cron','manual','webhook','event')),
    -- V1 columns
    trigger_payload         TEXT,
    total_llm_tokens        INTEGER NOT NULL DEFAULT 0,
    total_llm_cost_micros   INTEGER NOT NULL DEFAULT 0,
    aborted_at              TEXT,
    abort_reason            TEXT,
    step_count_total        INTEGER NOT NULL DEFAULT 0,
    step_count_failed       INTEGER NOT NULL DEFAULT 0
);

INSERT INTO routine_runs__new (
    id, routine_id, started_at, ended_at, exit_code,
    stdout_excerpt, stderr_excerpt, error, trigger
)
SELECT
    id, routine_id, started_at, ended_at, exit_code,
    stdout_excerpt, stderr_excerpt, error, trigger
FROM routine_runs;

DROP TABLE routine_runs;
ALTER TABLE routine_runs__new RENAME TO routine_runs;

CREATE INDEX IF NOT EXISTS idx_runs_routine_started
    ON routine_runs(routine_id, started_at DESC);

-- ─── routine_step_runs ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS routine_step_runs (
    id               TEXT PRIMARY KEY,
    run_id           TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE CASCADE,
    step_id          TEXT NOT NULL,
    step_index       INTEGER NOT NULL,
    step_type        TEXT NOT NULL,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,
    status           TEXT NOT NULL CHECK (status IN ('pending','running','success','skipped','failed','aborted')),
    stdout_excerpt   TEXT NOT NULL DEFAULT '',
    stderr_excerpt   TEXT NOT NULL DEFAULT '',
    output_json      TEXT,
    error            TEXT,
    model            TEXT,
    llm_tokens_in    INTEGER,
    llm_tokens_out   INTEGER,
    llm_cost_micros  INTEGER,
    duration_ms      INTEGER,
    attempt          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_step_runs_run
    ON routine_step_runs(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_step_runs_step
    ON routine_step_runs(step_id, started_at DESC);

-- ─── routine_webhook_secrets ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS routine_webhook_secrets (
    routine_id    TEXT PRIMARY KEY REFERENCES routines(id) ON DELETE CASCADE,
    path          TEXT NOT NULL UNIQUE,
    secret_hash   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT
);

-- ─── routine_state ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS routine_state (
    routine_id   TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    key          TEXT NOT NULL,
    value_json   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (routine_id, key)
);
