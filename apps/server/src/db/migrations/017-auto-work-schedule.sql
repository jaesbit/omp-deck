-- Global Auto Work scheduler config (single row, id=1 enforced).
-- schedule_enabled:          whether the polling loop runs at all.
-- schedule_interval_minutes: how often (minutes) the loop fires.
-- task_selection_model:      JSON-encoded ModelRef | NULL = server default.
--
-- This is intentionally separate from per-workspace auto_work_config so
-- the interval and model selection are set once, globally, not per project.
CREATE TABLE IF NOT EXISTS auto_work_global_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_interval_minutes INTEGER NOT NULL DEFAULT 5,
  task_selection_model TEXT,
  updated_at TEXT NOT NULL DEFAULT ''
);
