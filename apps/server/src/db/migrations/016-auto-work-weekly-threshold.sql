-- 016-auto-work-weekly-threshold.sql
--
-- T-67: adds the weekly-usage percentage at which a one-per-calendar-day
-- Telegram "budget warning" notification fires. Independent of the existing
-- `weekly_pct_limit` (which hard-blocks new runs) — this is a softer
-- heads-up. Existing rows backfill to 80%, matching `DEFAULT_AUTO_WORK_VALUES`
-- in code, so a config saved before this migration keeps behaving
-- identically until edited.

ALTER TABLE auto_work_config
    ADD COLUMN weekly_pct_threshold REAL NOT NULL DEFAULT 80;
