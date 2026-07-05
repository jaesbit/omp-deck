-- 010-server-settings.sql
--
-- T-61: generic global key/value settings table. First consumer is
-- `deckBaseUrl` (the configurable base URL used to build session deep
-- links), but the table is intentionally generic so future single-value,
-- non-per-workspace settings don't need their own migration + table.

CREATE TABLE IF NOT EXISTS server_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
