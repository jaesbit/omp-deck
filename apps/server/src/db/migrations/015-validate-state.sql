-- 015-validate-state.sql
--
-- T-66: seeds the "validate" kanban column that the auto-work completion
-- flow moves a task into on a successful run (never straight to "done" —
-- every auto-work result is human-reviewed). Positioned between "active"
-- (200) and "blocked"/"done" (300/400) so a fresh install's default column
-- order reads backlog -> active -> validate -> blocked -> done.
--
-- `findStateByName("validate")` (see `apps/server/src/db/tasks.ts`) resolves
-- this row's id at runtime — nothing in code hardcodes the id this migration
-- assigns.

INSERT OR IGNORE INTO task_states (id, name, color, position, is_default) VALUES
    ('s_validate', 'validate', '#1d4ed8', 250, 0);
