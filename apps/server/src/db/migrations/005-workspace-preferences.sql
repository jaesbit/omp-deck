-- 005-workspace-preferences.sql
--
-- T-42: per-workspace (exact cwd match) default model override. Sits between
-- explicit per-session model selection and the SDK/OMP_MODEL global default
-- in the session-creation precedence chain. No secrets stored here — only a
-- {provider, id} pointer into the SDK's own ModelRegistry/auth storage.

CREATE TABLE IF NOT EXISTS workspace_preferences (
    cwd            TEXT PRIMARY KEY,
    model_provider TEXT,
    model_id       TEXT,
    updated_at     TEXT NOT NULL
);
