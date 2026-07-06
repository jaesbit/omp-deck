-- 010-auto-work-time-windows.sql
--
-- T-60 follow-up: replace the single (time_window_start, time_window_end)
-- pair with a JSON array of windows so users can configure multiple
-- non-contiguous execution slots (e.g. 0–6, 13–15, 20–24).

ALTER TABLE auto_work_config ADD COLUMN time_windows TEXT NOT NULL DEFAULT '[]';

-- Migrate existing rows: convert the old scalar pair into a one-element array.
UPDATE auto_work_config
   SET time_windows = '[{"start":' || time_window_start || ',"end":' || time_window_end || '}]'
 WHERE time_windows = '[]';
