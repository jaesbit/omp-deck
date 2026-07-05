-- 007-task-dependencies.sql
--
-- T-57: task dependency graph. A row means "task_id is blocked on
-- depends_on_task_id". Modeled as a join table (not a JSON column) so FK
-- constraints keep it consistent automatically when either task is deleted,
-- and so lookups in either direction (what does X depend on / what depends
-- on X) stay index-backed instead of requiring a JSON scan.
--
-- Auto-work (T-64) will read this to decide whether a task is queueable;
-- this migration only adds the data model, no scheduling logic.

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at          TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id != depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_task_id);
