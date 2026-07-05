-- 013-auto-work-cost-estimation.sql
--
-- T-63: adds the two config fields the cost-estimation function
-- (`apps/server/src/auto-work/estimate.ts`) needs from `auto_work_config` —
-- per-priority default estimate (used when no run history exists yet for
-- a priority) and the safety-buffer multiplier applied to every estimate.
-- Existing rows backfill to the same defaults `DEFAULT_AUTO_WORK_VALUES`
-- uses in code, so a config saved before this migration keeps behaving
-- identically until edited.

ALTER TABLE auto_work_config
    ADD COLUMN default_estimate_pct_by_priority TEXT NOT NULL DEFAULT '{"P0":20,"P1":15,"P2":10,"P3":8,"P4":5,"P5":3}';

ALTER TABLE auto_work_config
    ADD COLUMN estimation_buffer REAL NOT NULL DEFAULT 1.3;
