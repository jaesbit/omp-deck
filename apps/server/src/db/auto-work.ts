/**
 * Auto Work configuration — per-workspace enable flag, per-priority model
 * overrides, execution time windows, and consumption limits (T-60). This is
 * the DB layer only; validation of incoming values lives in
 * `routes-auto-work.ts` so a bad request never reaches SQLite.
 *
 * Rows are optional: a workspace with no row is simply "unconfigured" and
 * `getAutoWorkConfig` returns `DEFAULT_AUTO_WORK_CONFIG` merged with its
 * `workspaceCwd`/`updatedAt` rather than inserting one eagerly. Later
 * tickets (T-62/63/64/66/67) that read this config for scheduling should
 * call `getAutoWorkConfig` too, never assume a row exists.
 */

import type { AutoWorkConfig, AutoWorkModelByPriority, AutoWorkTimeWindow, ModelRef, TaskPriority } from "@omp-deck/protocol";

import { getDb, nowIso } from "./index.ts";

const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4", "P5"];

/** Disabled, no model overrides, full-day window, unrestricted spend. */
export const DEFAULT_AUTO_WORK_VALUES: Omit<AutoWorkConfig, "workspaceCwd" | "updatedAt"> = {
	enabled: false,
	modelByPriority: Object.fromEntries(TASK_PRIORITIES.map((p) => [p, null])) as AutoWorkModelByPriority,
	timeWindows: [{ start: 0, end: 24 }],
	sessionPctLimit: 100,
	weeklyPctLimit: 100,
};

interface Row {
	workspace_cwd: string;
	enabled: number;
	model_by_priority: string;
	time_windows: string; // JSON: AutoWorkTimeWindow[]
	session_pct_limit: number;
	weekly_pct_limit: number;
	updated_at: string;
}

function parseTimeWindows(raw: string): AutoWorkTimeWindow[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return DEFAULT_AUTO_WORK_VALUES.timeWindows;
		const windows: AutoWorkTimeWindow[] = [];
		for (const item of parsed) {
			if (
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).start === "number" &&
				typeof (item as Record<string, unknown>).end === "number"
			) {
				windows.push({ start: (item as AutoWorkTimeWindow).start, end: (item as AutoWorkTimeWindow).end });
			}
		}
		return windows.length > 0 ? windows : DEFAULT_AUTO_WORK_VALUES.timeWindows;
	} catch {
		return DEFAULT_AUTO_WORK_VALUES.timeWindows;
	}
}

function rowToConfig(r: Row): AutoWorkConfig {
	let modelByPriority: AutoWorkModelByPriority;
	try {
		const parsed = JSON.parse(r.model_by_priority) as Partial<Record<TaskPriority, ModelRef | null>>;
		modelByPriority = Object.fromEntries(
			TASK_PRIORITIES.map((p) => [p, parsed[p] ?? null]),
		) as AutoWorkModelByPriority;
	} catch {
		modelByPriority = DEFAULT_AUTO_WORK_VALUES.modelByPriority;
	}
	return {
		workspaceCwd: r.workspace_cwd,
		enabled: r.enabled !== 0,
		modelByPriority,
		timeWindows: parseTimeWindows(r.time_windows),
		sessionPctLimit: r.session_pct_limit,
		weeklyPctLimit: r.weekly_pct_limit,
		updatedAt: r.updated_at,
	};
}

/** Always resolvable — returns computed defaults when no row exists for `cwd`. */
export function getAutoWorkConfig(cwd: string): AutoWorkConfig {
	const row = getDb()
		.query<Row, [string]>(
			`SELECT workspace_cwd, enabled, model_by_priority, time_windows,
			        session_pct_limit, weekly_pct_limit, updated_at
			 FROM auto_work_config WHERE workspace_cwd = ?`,
		)
		.get(cwd) as Row | null;
	if (row) return rowToConfig(row);
	return { workspaceCwd: cwd, updatedAt: nowIso(), ...DEFAULT_AUTO_WORK_VALUES };
}

/** Upserts the full config for `cwd`. Caller (`routes-auto-work.ts`) validates first. */
export function setAutoWorkConfig(
	cwd: string,
	values: Omit<AutoWorkConfig, "workspaceCwd" | "updatedAt">,
): AutoWorkConfig {
	const db = getDb();
	const now = nowIso();
	db.prepare<unknown, [string, number, string, string, number, number, string]>(
		`INSERT INTO auto_work_config
		   (workspace_cwd, enabled, model_by_priority, time_windows,
		    session_pct_limit, weekly_pct_limit, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(workspace_cwd) DO UPDATE SET
		   enabled = excluded.enabled,
		   model_by_priority = excluded.model_by_priority,
		   time_windows = excluded.time_windows,
		   session_pct_limit = excluded.session_pct_limit,
		   weekly_pct_limit = excluded.weekly_pct_limit,
		   updated_at = excluded.updated_at`,
	).run(
		cwd,
		values.enabled ? 1 : 0,
		JSON.stringify(values.modelByPriority),
		JSON.stringify(values.timeWindows),
		values.sessionPctLimit,
		values.weeklyPctLimit,
		now,
	);
	return getAutoWorkConfig(cwd);
}
