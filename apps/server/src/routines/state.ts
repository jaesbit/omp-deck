/**
 * Cross-run state for V1 routines. Reads materialize as context.state.<key>
 * at run start; writes via the set_state step UPSERT into routine_state.
 *
 * Storage: SQLite `routine_state` table, keyed on (routine_id, key). Values
 * are JSON-serialized at write time and parsed at read time. Atomic per
 * UPSERT call (write happens in a single statement).
 */

import { getDb, nowIso } from "../db/index.ts";

interface StateRow {
	key: string;
	value_json: string;
}

/** Materialize all state keys for a routine into a {key: parsedValue} object. */
export function loadState(routineId: string): Record<string, unknown> {
	const rows = getDb()
		.query<StateRow, [string]>(
			"SELECT key, value_json FROM routine_state WHERE routine_id = ?",
		)
		.all(routineId) as StateRow[];
	const out: Record<string, unknown> = {};
	for (const row of rows) {
		try {
			out[row.key] = JSON.parse(row.value_json);
		} catch {
			// Malformed row — surface as undefined; don't fail the run.
			out[row.key] = null;
		}
	}
	return out;
}

/** UPSERT one or more state keys for a routine. Atomic. */
export function saveState(routineId: string, kv: Record<string, unknown>): void {
	const entries = Object.entries(kv);
	if (entries.length === 0) return;
	const db = getDb();
	const stmt = db.prepare<unknown, [string, string, string, string]>(
		`INSERT INTO routine_state (routine_id, key, value_json, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(routine_id, key) DO UPDATE SET
		   value_json = excluded.value_json,
		   updated_at = excluded.updated_at`,
	);
	const now = nowIso();
	db.transaction(() => {
		for (const [key, value] of entries) {
			stmt.run(routineId, key, JSON.stringify(value), now);
		}
	})();
}

/** Drop a single state key. */
export function clearStateKey(routineId: string, key: string): boolean {
	const r = getDb()
		.prepare<unknown, [string, string]>(
			"DELETE FROM routine_state WHERE routine_id = ? AND key = ?",
		)
		.run(routineId, key);
	return Number(r.changes ?? 0) > 0;
}

/** Drop all state for a routine. Useful on routine delete. */
export function clearAllState(routineId: string): void {
	getDb()
		.prepare<unknown, [string]>("DELETE FROM routine_state WHERE routine_id = ?")
		.run(routineId);
}
