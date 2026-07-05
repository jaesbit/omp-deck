/**
 * Unit tests for `estimateTaskCostPct` (T-63). Boots a fresh on-disk
 * SQLite database per test — same pattern as `db/auto-work-runs.test.ts` —
 * since the estimate reads run history directly via `getAutoWorkCostEstimate`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AutoWorkConfig, TaskPriority } from "@omp-deck/protocol";

import { closeDb, openDb } from "../db/index.ts";
import { completeAutoWorkRun, startAutoWorkRun } from "../db/auto-work-runs.ts";
import { DEFAULT_AUTO_WORK_VALUES, DEFAULT_ESTIMATE_PCT_BY_PRIORITY } from "../db/auto-work.ts";
import { estimateTaskCostPct } from "./estimate.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-estimate-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

function makeConfig(overrides: Partial<AutoWorkConfig> = {}): AutoWorkConfig {
	return {
		workspaceCwd: "/tmp/project",
		updatedAt: new Date().toISOString(),
		...DEFAULT_AUTO_WORK_VALUES,
		...overrides,
	};
}

function seedCompletedRun(priority: TaskPriority, pctConsumed: number): void {
	const runId = startAutoWorkRun({
		taskId: `task-${priority}-${pctConsumed}`,
		taskPriority: priority,
		sessionId: "session",
		worktreePath: "/tmp/wt",
	});
	completeAutoWorkRun(runId, { status: "completed", pctConsumed });
}

describe("estimateTaskCostPct", () => {
	test("falls back to the configured default (not zero) when no history exists", () => {
		bootDb();
		const config = makeConfig();
		const estimate = estimateTaskCostPct("P2", config);
		expect(estimate).toBeCloseTo(DEFAULT_ESTIMATE_PCT_BY_PRIORITY.P2 * config.estimationBuffer, 10);
		expect(estimate).toBeGreaterThan(0);
	});

	test("uses the rolling historical average once history exists, ignoring the default", () => {
		bootDb();
		seedCompletedRun("P1", 40);
		seedCompletedRun("P1", 20);
		const config = makeConfig();
		// avg = 30, unrelated to DEFAULT_ESTIMATE_PCT_BY_PRIORITY.P1 (15)
		const estimate = estimateTaskCostPct("P1", config);
		expect(estimate).toBeCloseTo(30 * config.estimationBuffer, 10);
	});

	test("applies the configured buffer, not a silent 1.0", () => {
		bootDb();
		seedCompletedRun("P3", 10);
		const bufferedConfig = makeConfig({ estimationBuffer: 2 });
		const unbufferedEstimate = 10;
		const bufferedEstimate = estimateTaskCostPct("P3", bufferedConfig);
		expect(bufferedEstimate).toBe(unbufferedEstimate * 2);
		expect(bufferedEstimate).not.toBe(unbufferedEstimate);
	});

	test("all six priorities have distinct configured defaults", () => {
		bootDb();
		const config = makeConfig();
		const estimates: number[] = (["P0", "P1", "P2", "P3", "P4", "P5"] as const).map((p) =>
			estimateTaskCostPct(p, config),
		);
		expect(new Set(estimates).size).toBe(6);
		// Sanity: higher priority (P0) costs more than lower priority (P5) by default.
		expect(estimates[0]!).toBeGreaterThan(estimates[5]!);
	});
});
