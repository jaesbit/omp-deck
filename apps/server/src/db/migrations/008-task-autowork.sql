-- 008-task-autowork.sql
--
-- T-58: per-task opt-in flag for the auto-work engine (T-64+). Not every
-- kanban task should be eligible for unattended automation, so this is an
-- explicit boolean the user sets per task rather than an inferred default.
-- Defaults to 0 (false) so every pre-existing task stays opted out.

ALTER TABLE tasks ADD COLUMN auto_work INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tasks_auto_work ON tasks(auto_work);
