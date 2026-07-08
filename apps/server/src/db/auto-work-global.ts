/**
 * Global Auto Work config — single row in `auto_work_global_config`.
 * Owns the polling schedule (enabled + interval) and the optional model
 * used to pick the next task when multiple workspaces have eligible work.
 *
 * All fields have safe defaults so callers never have to handle a null row:
 * `getAutoWorkGlobalConfig()` returns those defaults when the row is absent.
 */

import type { AutoWorkGlobalConfig, ModelRef } from "@omp-deck/protocol";

import { getDb, nowIso } from "./index.ts";

export const DEFAULT_AUTO_WORK_GLOBAL: Omit<AutoWorkGlobalConfig, "updatedAt"> = {
	scheduleEnabled: false,
	scheduleIntervalMinutes: 5,
	taskSelectionModel: null,
	squeezeEnabled: false,
};

interface Row {
	id: number;
	schedule_enabled: number;
	schedule_interval_minutes: number;
	task_selection_model: string | null;
	squeeze_enabled: number;
	updated_at: string;
}

function rowToConfig(r: Row): AutoWorkGlobalConfig {
	let taskSelectionModel: ModelRef | null = null;
	if (r.task_selection_model) {
		try {
			taskSelectionModel = JSON.parse(r.task_selection_model) as ModelRef;
		} catch {
			taskSelectionModel = null;
		}
	}
	return {
		scheduleEnabled: r.schedule_enabled !== 0,
		scheduleIntervalMinutes: r.schedule_interval_minutes,
		taskSelectionModel,
		squeezeEnabled: r.squeeze_enabled !== 0,
		updatedAt: r.updated_at,
	};
}

/** Always returns a value — falls back to defaults when no row exists yet. */
export function getAutoWorkGlobalConfig(): AutoWorkGlobalConfig {
	const row = getDb()
		.query<Row, []>(
			`SELECT id, schedule_enabled, schedule_interval_minutes, task_selection_model, squeeze_enabled, updated_at
			 FROM auto_work_global_config LIMIT 1`,
		)
		.get() as Row | null;
	if (row) return rowToConfig(row);
	return { updatedAt: nowIso(), ...DEFAULT_AUTO_WORK_GLOBAL };
}

/** Upserts the single global row. Caller validates before calling. */
export function setAutoWorkGlobalConfig(
	values: Omit<AutoWorkGlobalConfig, "updatedAt">,
): AutoWorkGlobalConfig {
	const db = getDb();
	const now = nowIso();
	db.prepare<unknown, [number, number, string | null, number, string]>(
		`INSERT INTO auto_work_global_config (id, schedule_enabled, schedule_interval_minutes, task_selection_model, squeeze_enabled, updated_at)
		 VALUES (1, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   schedule_enabled = excluded.schedule_enabled,
		   schedule_interval_minutes = excluded.schedule_interval_minutes,
		   task_selection_model = excluded.task_selection_model,
		   squeeze_enabled = excluded.squeeze_enabled,
		   updated_at = excluded.updated_at`,
	).run(
		values.scheduleEnabled ? 1 : 0,
		values.scheduleIntervalMinutes,
		values.taskSelectionModel ? JSON.stringify(values.taskSelectionModel) : null,
		values.squeezeEnabled ? 1 : 0,
		now,
	);
	return getAutoWorkGlobalConfig();
}
