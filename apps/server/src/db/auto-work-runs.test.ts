/**
 * Unit tests for the auto-work-runs DB layer (T-62). Boots a fresh
 * on-disk SQLite database under `os.tmpdir()` per test so migrations run
 * end-to-end, same pattern as `auto-work.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./index.ts";
import {
	completeAutoWorkRun,
	getAutoWorkCostEstimate,
	listAutoWorkRuns,
	startAutoWorkRun,
} from "./auto-work-runs.ts";

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
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-runs-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

describe("auto-work runs", () => {
	test("startAutoWorkRun records an open row immediately", () => {
		bootDb();
		const runId = startAutoWorkRun({
			taskId: "task-1",
			taskPriority: "P2",
			sessionId: "session-1",
			worktreePath: "/tmp/wt-1",
		});
		expect(runId).toBeTruthy();

		const [run] = listAutoWorkRuns({ taskId: "task-1" });
		expect(run).toBeDefined();
		expect(run!.id).toBe(runId);
		expect(run!.status).toBe("running");
		expect(run!.completedAt).toBeNull();
		expect(run!.taskPriority).toBe("P2");
		expect(run!.sessionId).toBe("session-1");
		expect(run!.worktreePath).toBe("/tmp/wt-1");
		expect(run!.inputTokens).toBeNull();
		expect(run!.outputTokens).toBeNull();
		expect(run!.pctConsumed).toBeNull();
		expect(run!.failureReason).toBeNull();
	});

	test("completeAutoWorkRun closes the row with tokens, pct, and status", () => {
		bootDb();
		const runId = startAutoWorkRun({
			taskId: "task-2",
			taskPriority: "P1",
			sessionId: "session-2",
			worktreePath: "/tmp/wt-2",
		});
		completeAutoWorkRun(runId, {
			status: "completed",
			inputTokens: 1000,
			outputTokens: 500,
			pctConsumed: 2.5,
		});

		const [run] = listAutoWorkRuns({ taskId: "task-2" });
		expect(run!.status).toBe("completed");
		expect(run!.completedAt).not.toBeNull();
		expect(run!.inputTokens).toBe(1000);
		expect(run!.outputTokens).toBe(500);
		expect(run!.pctConsumed).toBe(2.5);
		expect(run!.failureReason).toBeNull();
	});

	test("completeAutoWorkRun records a failure reason on failed status", () => {
		bootDb();
		const runId = startAutoWorkRun({
			taskId: "task-3",
			taskPriority: "P0",
			sessionId: "session-3",
			worktreePath: "/tmp/wt-3",
		});
		completeAutoWorkRun(runId, { status: "failed", failureReason: "agent crashed" });

		const [run] = listAutoWorkRuns({ taskId: "task-3" });
		expect(run!.status).toBe("failed");
		expect(run!.failureReason).toBe("agent crashed");
	});

	test("listAutoWorkRuns filters by taskId, priority, and status, most recent first", () => {
		bootDb();
		const a = startAutoWorkRun({ taskId: "t-a", taskPriority: "P2", sessionId: "s-a", worktreePath: "/tmp/a" });
		completeAutoWorkRun(a, { status: "completed", pctConsumed: 1 });
		const b = startAutoWorkRun({ taskId: "t-b", taskPriority: "P3", sessionId: "s-b", worktreePath: "/tmp/b" });
		completeAutoWorkRun(b, { status: "failed", failureReason: "oops" });
		startAutoWorkRun({ taskId: "t-c", taskPriority: "P2", sessionId: "s-c", worktreePath: "/tmp/c" });

		expect(listAutoWorkRuns({}).length).toBe(3);
		expect(listAutoWorkRuns({ taskId: "t-a" }).map((r) => r.id)).toEqual([a]);
		expect(listAutoWorkRuns({ priority: "P2" }).length).toBe(2);
		expect(listAutoWorkRuns({ status: "failed" }).map((r) => r.id)).toEqual([b]);
	});

	test("listAutoWorkRuns respects limit", () => {
		bootDb();
		for (let i = 0; i < 5; i++) {
			startAutoWorkRun({ taskId: `t-${i}`, taskPriority: "P4", sessionId: `s-${i}`, worktreePath: `/tmp/${i}` });
		}
		expect(listAutoWorkRuns({ limit: 2 }).length).toBe(2);
		expect(listAutoWorkRuns({}).length).toBe(5);
	});

	test("getAutoWorkCostEstimate returns null average with zero sample size when no history exists", () => {
		bootDb();
		expect(getAutoWorkCostEstimate("P2")).toEqual({ avgPctConsumed: null, sampleSize: 0 });
	});

	test("getAutoWorkCostEstimate averages the last 10 completed runs at a priority", () => {
		bootDb();
		// 12 completed P2 runs with pct 1..12; only the most recent 10 (3..12) should count.
		for (let i = 1; i <= 12; i++) {
			const runId = startAutoWorkRun({
				taskId: `p2-${i}`,
				taskPriority: "P2",
				sessionId: `s-${i}`,
				worktreePath: `/tmp/${i}`,
			});
			completeAutoWorkRun(runId, { status: "completed", pctConsumed: i });
		}
		// A still-running run and a failed run at the same priority must not count.
		startAutoWorkRun({ taskId: "p2-running", taskPriority: "P2", sessionId: "s-r", worktreePath: "/tmp/r" });
		const failedId = startAutoWorkRun({
			taskId: "p2-failed",
			taskPriority: "P2",
			sessionId: "s-f",
			worktreePath: "/tmp/f",
		});
		completeAutoWorkRun(failedId, { status: "failed", failureReason: "boom" });
		// A completed run at a different priority must not count.
		const otherId = startAutoWorkRun({
			taskId: "p3-1",
			taskPriority: "P3",
			sessionId: "s-o",
			worktreePath: "/tmp/o",
		});
		completeAutoWorkRun(otherId, { status: "completed", pctConsumed: 999 });

		const estimate = getAutoWorkCostEstimate("P2");
		expect(estimate.sampleSize).toBe(10);
		// last 10 completed runs (started most recently) are pct 3..12 -> average 7.5
		expect(estimate.avgPctConsumed).toBe(7.5);
	});

	test("getAutoWorkCostEstimate includes completed_pr_failed runs in the rolling average", () => {
		bootDb();
		// 3 completed P2 runs (pct 10, 20, 30) plus 1 completed_pr_failed P2 run (pct 40).
		for (const pct of [10, 20, 30]) {
			const runId = startAutoWorkRun({
				taskId: `p2-completed-${pct}`,
				taskPriority: "P2",
				sessionId: `s-${pct}`,
				worktreePath: `/tmp/${pct}`,
			});
			completeAutoWorkRun(runId, { status: "completed", pctConsumed: pct });
		}
		const prFailedId = startAutoWorkRun({
			taskId: "p2-pr-failed",
			taskPriority: "P2",
			sessionId: "s-pr-failed",
			worktreePath: "/tmp/pr-failed",
		});
		completeAutoWorkRun(prFailedId, { status: "completed_pr_failed", pctConsumed: 40 });

		const estimate = getAutoWorkCostEstimate("P2");
		// If completed_pr_failed rows were excluded, sampleSize would be 3 and the
		// average would be 20 instead of 25 -> this fails against `status = 'completed'` only.
		expect(estimate.sampleSize).toBe(4);
		expect(estimate.avgPctConsumed).toBe(25);
	});
});
