-- 019-workspace-preferences-thinking.sql
--
-- T-73: per-workspace default thinking level, stored alongside the default
-- model. NULL means "no override" — the SDK's own default applies.

ALTER TABLE workspace_preferences ADD COLUMN thinking TEXT;
