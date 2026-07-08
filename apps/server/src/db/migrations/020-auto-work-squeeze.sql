-- 020-auto-work-squeeze.sql
--
-- T-75: "squeeze" mode for the global Auto Work scheduler. When enabled,
-- the scheduler asks `task_selection_model` after each cycle whether to
-- start another one immediately instead of waiting for the next scheduled
-- tick, to avoid leaving unused subscription capacity on the table when a
-- usage window resets. Existing rows backfill to disabled, matching
-- `DEFAULT_AUTO_WORK_GLOBAL` in code, so a config saved before this
-- migration keeps behaving identically until edited.

ALTER TABLE auto_work_global_config
    ADD COLUMN squeeze_enabled INTEGER NOT NULL DEFAULT 0;
