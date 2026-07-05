-- 014-auto-work-timeout.sql
--
-- T-64: adds the per-priority execution timeout the auto-work engine
-- enforces while waiting for an agent session to reach a terminal state.
-- Existing rows backfill to the same defaults `DEFAULT_AUTO_WORK_VALUES`
-- uses in code (P0=120min, P1=90min, P2=60min, P3-P5=45min), so a config
-- saved before this migration keeps behaving identically until edited.

ALTER TABLE auto_work_config
    ADD COLUMN timeout_minutes_by_priority TEXT NOT NULL DEFAULT '{"P0":120,"P1":90,"P2":60,"P3":45,"P4":45,"P5":45}';
