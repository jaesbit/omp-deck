/**
 * Workspace preferences — per-cwd default model override (T-42).
 *
 * Sits between explicit per-session model selection and the SDK/OMP_MODEL
 * global default in the session-creation precedence chain (see
 * `routes.ts`'s `POST /sessions`). No secrets stored here — only a
 * `{provider, id}` pointer into the SDK's own ModelRegistry/auth storage.
 */

import type { ModelRef, WorkspacePreference } from "@omp-deck/protocol";

import { getDb, nowIso } from "./index.ts";

interface Row {
	cwd: string;
	model_provider: string | null;
	model_id: string | null;
	updated_at: string;
}

function rowToPreference(r: Row): WorkspacePreference {
	const out: WorkspacePreference = { cwd: r.cwd, updatedAt: r.updated_at };
	if (r.model_provider !== null && r.model_id !== null) {
		out.model = { provider: r.model_provider, id: r.model_id };
	}
	return out;
}

export function listWorkspacePreferences(): WorkspacePreference[] {
	const rows = getDb()
		.query<Row, []>(
			"SELECT cwd, model_provider, model_id, updated_at FROM workspace_preferences ORDER BY cwd ASC",
		)
		.all() as Row[];
	return rows.map(rowToPreference);
}

export function getWorkspacePreference(cwd: string): WorkspacePreference | undefined {
	const row = getDb()
		.query<Row, [string]>(
			"SELECT cwd, model_provider, model_id, updated_at FROM workspace_preferences WHERE cwd = ?",
		)
		.get(cwd) as Row | null;
	return row ? rowToPreference(row) : undefined;
}

/** `model: null` clears the override for `cwd` (row is deleted). */
export function setWorkspacePreference(cwd: string, model: ModelRef | null): WorkspacePreference {
	const db = getDb();
	const now = nowIso();
	if (model === null) {
		db.prepare<unknown, [string]>("DELETE FROM workspace_preferences WHERE cwd = ?").run(cwd);
		return { cwd, updatedAt: now };
	}
	db.prepare<unknown, [string, string, string, string]>(
		`INSERT INTO workspace_preferences (cwd, model_provider, model_id, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(cwd) DO UPDATE SET
		   model_provider = excluded.model_provider,
		   model_id = excluded.model_id,
		   updated_at = excluded.updated_at`,
	).run(cwd, model.provider, model.id, now);
	const out = getWorkspacePreference(cwd);
	if (!out) throw new Error("setWorkspacePreference failed");
	return out;
}
