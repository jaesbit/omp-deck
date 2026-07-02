-- 006-task-priority.sql
--
-- T-38: native P0-P5 priority field on tasks, replacing the temporary
-- "[P0] ..." title prefix convention. P0 is highest priority, P5 lowest;
-- unmarked cards default to P5.
--
-- Backfill: extract priority from a literal "[PN]" title prefix (the
-- convention used before this field existed), then strip that now-redundant
-- prefix from the title. Cards without the prefix keep the column default.

ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'P5';

UPDATE tasks SET priority = 'P0' WHERE title LIKE '[P0]%';
UPDATE tasks SET priority = 'P1' WHERE title LIKE '[P1]%';
UPDATE tasks SET priority = 'P2' WHERE title LIKE '[P2]%';
UPDATE tasks SET priority = 'P3' WHERE title LIKE '[P3]%';
UPDATE tasks SET priority = 'P4' WHERE title LIKE '[P4]%';
UPDATE tasks SET priority = 'P5' WHERE title LIKE '[P5]%';

-- SUBSTR(title, 5) drops the 4-char "[PN]" prefix; TRIM drops the space after it.
UPDATE tasks SET title = TRIM(SUBSTR(title, 5)) WHERE title LIKE '[P_]%';

CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
