-- Repairs databases that recorded 017-auto-work-schedule.sql before
-- auto_work_global_config was created. Keep this separate from 017 because
-- applied migrations are tracked by filename and are intentionally never rerun.
CREATE TABLE IF NOT EXISTS auto_work_global_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_interval_minutes INTEGER NOT NULL DEFAULT 5,
  task_selection_model TEXT,
  updated_at TEXT NOT NULL DEFAULT ''
);
