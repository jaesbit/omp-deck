/**
 * Workspace preferences — per-cwd default model + thinking override (T-42, T-73).
 *
 * Sits between explicit per-session model selection and the SDK/OMP_MODEL
 * global default in the session-creation precedence chain (see
 * `routes.ts`'s `POST /sessions`). No secrets stored here — only a
 * `{provider, id}` model pointer and an optional thinking level string.
 */

import type { ModelRef, WorkspacePreference } from "@omp-deck/protocol";

import { getDb, nowIso } from "./index.ts";

interface Row {
	cwd: string;
	model_provider: string | null;
	model_id: string | null;
	thinking: string | null;
	updated_at: string;
}

function rowToPreference(r: Row): WorkspacePreference {
	const out: WorkspacePreference = { cwd: r.cwd, updatedAt: r.updated_at };
	if (r.model_provider !== null && r.model_id !== null) {
		out.model = { provider: r.model_provider, id: r.model_id };
	}
	if (r.thinking !== null) {
		out.thinking = r.thinking;
	}
	return out;
}

export function listWorkspacePreferences(): WorkspacePreference[] {
	const rows = getDb()
		.query<Row, []>(
			"SELECT cwd, model_provider, model_id, thinking, updated_at FROM workspace_preferences ORDER BY cwd ASC",
		)
		.all() as Row[];
	return rows.map(rowToPreference);
}

export function getWorkspacePreference(cwd: string): WorkspacePreference | undefined {
	const row = getDb()
		.query<Row, [string]>(
			"SELECT cwd, model_provider, model_id, thinking, updated_at FROM workspace_preferences WHERE cwd = ?",
		)
		.get(cwd) as Row | null;
	return row ? rowToPreference(row) : undefined;
}

/**
 * Upsert (or delete) the workspace preference for `cwd`.
 *
 * - `model: null` clears the model override.
 * - `thinking: null` clears the thinking override (pass undefined to leave it unchanged).
 * - When both resolved values are null/absent after the update, the row is deleted.
 *
 * This lets callers update model and thinking independently.
 */
export function setWorkspacePreference(
	cwd: string,
	model: ModelRef | null,
	thinking?: string | null,
): WorkspacePreference {
	const db = getDb();
	const now = nowIso();

	// Read existing row so we can merge updates rather than overwrite.
	const existing = getDb()
		.query<Row, [string]>(
			"SELECT cwd, model_provider, model_id, thinking, updated_at FROM workspace_preferences WHERE cwd = ?",
		)
		.get(cwd) as Row | null;

	// Resolve the final values: explicit arg wins, otherwise keep existing.
	const newProvider = model !== null ? (model?.provider ?? null) : null;
	const newId = model !== null ? (model?.id ?? null) : null;
	const newThinking = thinking !== undefined ? (thinking ?? null) : (existing?.thinking ?? null);

	// Nothing to store — clean up the row if it exists.
	if (newProvider === null && newId === null && newThinking === null) {
		db.prepare<unknown, [string]>("DELETE FROM workspace_preferences WHERE cwd = ?").run(cwd);
		return { cwd, updatedAt: now };
	}

	db.prepare<unknown, [string, string | null, string | null, string | null, string]>(
		`INSERT INTO workspace_preferences (cwd, model_provider, model_id, thinking, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(cwd) DO UPDATE SET
		   model_provider = excluded.model_provider,
		   model_id       = excluded.model_id,
		   thinking       = excluded.thinking,
		   updated_at     = excluded.updated_at`,
	).run(cwd, newProvider, newId, newThinking, now);

	const out = getWorkspacePreference(cwd);
	if (!out) throw new Error("setWorkspacePreference failed");
	return out;
}
