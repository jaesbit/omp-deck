/**
 * Tests for the Auto Work execution engine (T-64).
 *
 * Two layers:
 *  - Pure decision logic (`checkAutoWorkPreflight`, `costFitsAutoWorkBudget`,
 *    `selectNextAutoWorkTask`, `resolveAutoWorkModel`,
 *    `resolveAutoWorkTimeoutMinutes`) — plain unit tests, no DB, no IO.
 *  - `runAutoWorkCycle` orchestrator — boots a real on-disk SQLite DB and a
 *    real git repo (so `git worktree add` actually runs) with a stub
 *    `AgentBridge` standing in for a live agent session. No real agent
 *    session is ever spun up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AutoWorkConfig, ModelInfo, Task, TaskPriority } from "@omp-deck/protocol";

import type { AgentBridge, EventListener, SessionHandle } from "../bridge/types.ts";
import { DEFAULT_AUTO_WORK_VALUES, setAutoWorkConfig } from "../db/auto-work.ts";
import { getAutoWorkCostEstimate, listAutoWorkRuns, startAutoWorkRun } from "../db/auto-work-runs.ts";
import { closeDb, openDb } from "../db/index.ts";
import { createTask, getTask } from "../db/tasks.ts";
import {
	checkAutoWorkPreflight,
	costFitsAutoWorkBudget,
	resolveAutoWorkModel,
	resolveAutoWorkTimeoutMinutes,
	runAutoWorkCycle,
	selectNextAutoWorkTask,
} from "./engine.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<AutoWorkConfig> = {}): AutoWorkConfig {
	return {
		workspaceCwd: "/tmp/ws",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...DEFAULT_AUTO_WORK_VALUES,
		enabled: true,
		sessionPctLimit: 30,
		weeklyPctLimit: 80,
		...overrides,
	};
}

let taskSeq = 0;
function baseTask(overrides: Partial<Task> = {}): Task {
	taskSeq += 1;
	return {
		id: `t_${taskSeq}`,
		displayId: taskSeq,
		title: `Task ${taskSeq}`,
		body: "",
		stateId: "s_backlog",
		orderInState: taskSeq * 1000,
		priority: "P5",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		stateEnteredAt: "2026-01-01T00:00:00.000Z",
		dependsOn: [],
		autoWork: true,
		...overrides,
	};
}

// ─── Pure decision logic ────────────────────────────────────────────────────

describe("checkAutoWorkPreflight", () => {
	test("rejects when auto-work is disabled", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig({ enabled: false }),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 10,
			activeRuns: [],
		});
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("disabled") });
	});

	test("rejects outside the configured time window", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig({ timeWindows: [{ start: 9, end: 17 }] }),
			now: new Date("2026-01-01T20:00:00"),
			subscriptionPctUsed: 10,
			activeRuns: [],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("outside the configured run window");
	});

	test("accepts at the window's opening hour and rejects at the closing hour (half-open interval)", () => {
		const config = baseConfig({ timeWindows: [{ start: 9, end: 17 }] });
		const atOpen = checkAutoWorkPreflight({
			config,
			now: new Date("2026-01-01T09:00:00"),
			subscriptionPctUsed: 10,
			activeRuns: [],
		});
		const atClose = checkAutoWorkPreflight({
			config,
			now: new Date("2026-01-01T17:00:00"),
			subscriptionPctUsed: 10,
			activeRuns: [],
		});
		expect(atOpen.ok).toBe(true);
		expect(atClose.ok).toBe(false);
	});

	test("rejects when subscription usage is unavailable", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig(),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: null,
			activeRuns: [],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("unavailable");
	});

	test("rejects when subscription usage is at or above the weekly limit", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig({ weeklyPctLimit: 80 }),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 80,
			activeRuns: [],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("weekly limit");
	});

	test("rejects when another run is already active for the workspace (mutex)", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig(),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 10,
			activeRuns: [
				{
					id: "awrun_1",
					taskId: "t_1",
					taskPriority: "P0",
					sessionId: "s1",
					worktreePath: "/x",
					startedAt: "2026-01-01T11:00:00.000Z",
					completedAt: null,
					status: "running",
					inputTokens: null,
					outputTokens: null,
					pctConsumed: null,
					failureReason: null,
				},
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("already active");
	});

	test("ignores non-running historical runs for the mutex check", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig(),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 10,
			activeRuns: [
				{
					id: "awrun_1",
					taskId: "t_1",
					taskPriority: "P0",
					sessionId: "s1",
					worktreePath: "/x",
					startedAt: "2026-01-01T11:00:00.000Z",
					completedAt: "2026-01-01T11:30:00.000Z",
					status: "completed",
					inputTokens: 1,
					outputTokens: 1,
					pctConsumed: 5,
					failureReason: null,
				},
			],
		});
		expect(result).toEqual({ ok: true });
	});

	test("passes every check", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig(),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 10,
			activeRuns: [],
		});
		expect(result).toEqual({ ok: true });
	});
});

describe("costFitsAutoWorkBudget", () => {
	test("rejects an estimate that alone exceeds sessionPctLimit", () => {
		const config = baseConfig({ sessionPctLimit: 20, weeklyPctLimit: 100 });
		expect(costFitsAutoWorkBudget(25, 0, config)).toBe(false);
	});

	test("rejects when adding the estimate to current usage crosses weeklyPctLimit", () => {
		const config = baseConfig({ sessionPctLimit: 100, weeklyPctLimit: 50 });
		expect(costFitsAutoWorkBudget(20, 40, config)).toBe(false);
	});

	test("accepts when both caps have room", () => {
		const config = baseConfig({ sessionPctLimit: 30, weeklyPctLimit: 80 });
		expect(costFitsAutoWorkBudget(20, 40, config)).toBe(true);
	});

	test("accepts exactly at either boundary", () => {
		const config = baseConfig({ sessionPctLimit: 20, weeklyPctLimit: 60 });
		expect(costFitsAutoWorkBudget(20, 40, config)).toBe(true);
	});
});

describe("selectNextAutoWorkTask", () => {
	const estimatesByPriority: Record<TaskPriority, number> = {
		P0: 25,
		P1: 15,
		P2: 10,
		P3: 5,
		P4: 5,
		P5: 5,
	};
	const estimateCostPct = (p: TaskPriority) => estimatesByPriority[p];

	test("returns none_eligible when nothing has autoWork set", () => {
		const tasks = [baseTask({ autoWork: false })];
		const result = selectNextAutoWorkTask({
			tasks,
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result).toEqual({ kind: "none_eligible" });
	});

	test("excludes a task whose dependency is not done", () => {
		const dep = baseTask({ id: "dep", stateId: "s_active" });
		const task = baseTask({ dependsOn: ["dep"] });
		const result = selectNextAutoWorkTask({
			tasks: [dep, task],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result).toEqual({ kind: "none_eligible" });
	});

	test("includes a task once its dependency is done", () => {
		const dep = baseTask({ id: "dep", stateId: "s_done" });
		const task = baseTask({ dependsOn: ["dep"] });
		const result = selectNextAutoWorkTask({
			tasks: [dep, task],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result.kind).toBe("selected");
		if (result.kind === "selected") expect(result.task.id).toBe(task.id);
	});

	test("sorts P0 before P1 regardless of orderInState", () => {
		const p1 = baseTask({ id: "p1", priority: "P1", orderInState: 1 });
		const p0 = baseTask({ id: "p0", priority: "P0", orderInState: 2 });
		// P0's own estimate (25) fits within default 30/80 limits.
		const result = selectNextAutoWorkTask({
			tasks: [p1, p0],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result.kind).toBe("selected");
		if (result.kind === "selected") expect(result.task.id).toBe("p0");
	});

	test("breaks priority ties by orderInState ascending", () => {
		const later = baseTask({ id: "later", priority: "P2", orderInState: 2000 });
		const earlier = baseTask({ id: "earlier", priority: "P2", orderInState: 1000 });
		const result = selectNextAutoWorkTask({
			tasks: [later, earlier],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result.kind).toBe("selected");
		if (result.kind === "selected") expect(result.task.id).toBe("earlier");
	});

	test("skips a P0 task that doesn't fit the budget and selects a P3 that does", () => {
		// sessionPctLimit=20 rejects P0's 25% estimate outright but accepts P3's 5%.
		const config = baseConfig({ sessionPctLimit: 20, weeklyPctLimit: 80 });
		const p0 = baseTask({ id: "p0", priority: "P0" });
		const p3 = baseTask({ id: "p3", priority: "P3" });
		const result = selectNextAutoWorkTask({
			tasks: [p0, p3],
			config,
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result.kind).toBe("selected");
		if (result.kind === "selected") expect(result.task.id).toBe("p3");
	});

	test("returns none_fit with the considered count when every eligible task exceeds budget", () => {
		const config = baseConfig({ sessionPctLimit: 1, weeklyPctLimit: 80 });
		const tasks = [baseTask({ priority: "P0" }), baseTask({ priority: "P3" })];
		const result = selectNextAutoWorkTask({
			tasks,
			config,
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result).toEqual({ kind: "none_fit", consideredCount: 2 });
	});

	test("ignores tasks outside the backlog column", () => {
		const tasks = [baseTask({ stateId: "s_active" })];
		const result = selectNextAutoWorkTask({
			tasks,
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result).toEqual({ kind: "none_eligible" });
	});
});

describe("resolveAutoWorkModel", () => {
	test("prefers the per-priority override", () => {
		const config = baseConfig({
			modelByPriority: {
				P0: { provider: "anthropic", id: "claude-p0" },
				P1: null,
				P2: null,
				P3: null,
				P4: null,
				P5: null,
			},
		});
		expect(resolveAutoWorkModel("P0", config, { provider: "anthropic", id: "claude-ws" })).toEqual({
			provider: "anthropic",
			id: "claude-p0",
		});
	});

	test("falls back to the workspace default when no override is configured", () => {
		const config = baseConfig();
		expect(resolveAutoWorkModel("P1", config, { provider: "anthropic", id: "claude-ws" })).toEqual({
			provider: "anthropic",
			id: "claude-ws",
		});
	});

	test("falls back to undefined (SDK global default) when neither is set", () => {
		const config = baseConfig();
		expect(resolveAutoWorkModel("P2", config, null)).toBeUndefined();
	});
});

describe("resolveAutoWorkTimeoutMinutes", () => {
	test("reads the configured per-priority value", () => {
		const config = baseConfig({
			timeoutMinutesByPriority: { P0: 200, P1: 90, P2: 60, P3: 45, P4: 45, P5: 45 },
		});
		expect(resolveAutoWorkTimeoutMinutes("P0", config)).toBe(200);
		expect(resolveAutoWorkTimeoutMinutes("P3", config)).toBe(45);
	});
});

// ─── Orchestrator (real DB + real git worktree + stub bridge) ──────────────

const AVAILABLE_MODEL: ModelInfo = {
	provider: "anthropic",
	id: "claude-good",
	label: "Claude Good",
	isAvailable: true,
};

class FakeSessionHandle {
	readonly sessionId: string;
	private listeners = new Set<EventListener>();

	constructor(
		sessionId: string,
		private readonly terminalDelayMs: number | null,
	) {
		this.sessionId = sessionId;
	}

	subscribe(listener: EventListener): () => void {
		this.listeners.add(listener);
		if (this.terminalDelayMs !== null) {
			setTimeout(() => listener({ type: "turn_end" } as never), this.terminalDelayMs);
		}
		return () => this.listeners.delete(listener);
	}

	async prompt(): Promise<void> {}
}

function fakeBridge(handle: FakeSessionHandle, models: ModelInfo[] = [AVAILABLE_MODEL]): AgentBridge {
	return {
		async listModels() {
			return models;
		},
		async createSession() {
			return handle as unknown as SessionHandle;
		},
	} as unknown as AgentBridge;
}

let dbDir: string;
let homeDir: string;
let repoCwd: string;
let originalHome: string | undefined;

function runGit(args: string[], cwd: string): void {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
}

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-engine-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });

	originalHome = process.env.HOME;
	homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-engine-home-"));
	process.env.HOME = homeDir;

	repoCwd = path.join(homeDir, "workspace");
	fs.mkdirSync(repoCwd, { recursive: true });
	runGit(["init", "-q"], repoCwd);
	runGit(["config", "user.email", "test@example.com"], repoCwd);
	runGit(["config", "user.name", "Test"], repoCwd);
	fs.writeFileSync(path.join(repoCwd, "README.md"), "hello\n");
	runGit(["add", "."], repoCwd);
	runGit(["commit", "-q", "-m", "init"], repoCwd);
});

afterEach(() => {
	closeDb();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	for (const dir of [dbDir, homeDir]) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("runAutoWorkCycle", () => {
	test("selects the task, creates a worktree, starts a session, and closes the run as completed", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Ship the thing", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_1", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(task.id);
		expect(result.sessionId).toBe("sess_1");
		expect(fs.existsSync(result.worktreePath)).toBe(true);
		expect(result.worktreePath).toContain(`aw-T${task.displayId}`);

		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_active");

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("completed");
		expect(runs[0]?.sessionId).toBe("sess_1");
		expect(runs[0]?.worktreePath).toBe(result.worktreePath);
	});

	test("moves the task to blocked with a reason and closes the run as timed_out on timeout", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			timeoutMinutesByPriority: { P0: 120, P1: 90, P2: 60, P3: 45, P4: 45, P5: 0.0005 }, // 30ms
		});
		const task = createTask({ title: "Slow task", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_timeout", null); // never emits turn_end
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("timed_out");
		if (result.outcome !== "timed_out") throw new Error("expected timed_out");

		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_blocked");
		expect(updated?.body).toContain("Auto Work timeout");
		expect(updated?.body).toContain(result.runId);

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]?.status).toBe("timed_out");
		expect(runs[0]?.failureReason).toContain("timeout");
	});

	test("skips when another run is already active for the workspace (mutex)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Queued", cwd: repoCwd, priority: "P5", autoWork: true });
		startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "already-running",
			worktreePath: "/tmp/whatever",
		});

		const handle = new FakeSessionHandle("sess_2", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain("already active");
		// The pre-existing task must not have been touched.
		expect(getTask(task.id)?.stateId).toBe("s_backlog");
	});

	test("skips when auto-work is disabled for the workspace", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: false });
		createTask({ title: "Disabled workspace", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_3", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result).toEqual({ outcome: "skipped", reason: expect.stringContaining("disabled") });
	});

	test("skips when no eligible task exists (unmet dependency)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const dep = createTask({ title: "Dependency", cwd: repoCwd, priority: "P5" });
		createTask({ title: "Blocked by dep", cwd: repoCwd, priority: "P5", autoWork: true, dependsOn: [dep.id] });

		const handle = new FakeSessionHandle("sess_4", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain("no eligible");
	});

	test("skips when the estimated cost doesn't fit even after the run-history sample builds up", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			sessionPctLimit: 1,
			weeklyPctLimit: 100,
		});
		createTask({ title: "Too expensive", cwd: repoCwd, priority: "P0", autoWork: true });
		expect(getAutoWorkCostEstimate("P0").sampleSize).toBe(0);

		const handle = new FakeSessionHandle("sess_5", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain("none fit");
	});
});
