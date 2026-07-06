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

import type { AutoWorkConfig, ModelInfo, SessionSummary, Task, TaskPriority } from "@omp-deck/protocol";

import type { AgentBridge, EventListener, SessionHandle } from "../bridge/types.ts";
import { DEFAULT_AUTO_WORK_VALUES, setAutoWorkConfig } from "../db/auto-work.ts";
import { getAutoWorkCostEstimate, listAutoWorkRuns, startAutoWorkRun } from "../db/auto-work-runs.ts";
import { closeDb, openDb } from "../db/index.ts";
import { createTask, getTask, moveTask } from "../db/tasks.ts";
import type { AutoWorkNotificationEvent } from "./notify.ts";
import {
	checkAutoWorkPreflight,
	classifyRunningAutoWorkRun,
	costFitsAutoWorkBudget,
	resolveAutoWorkModel,
	resolveAutoWorkTimeoutMinutes,
	runAutoWorkCycle,
	runGlobalAutoWorkCycle,
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

describe("classifyRunningAutoWorkRun", () => {
	const baseRun = {
		id: "awrun_1",
		taskId: "t_1",
		taskPriority: "P0" as const,
		sessionId: "sess_1",
		worktreePath: "/tmp/wt",
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: null,
		status: "running" as const,
		inputTokens: null,
		outputTokens: null,
		pctConsumed: null,
		failureReason: null,
	};

	test("resumes when the session and its worktree both still exist", () => {
		expect(classifyRunningAutoWorkRun(baseRun, true, true)).toBe("resume");
	});

	test("reconnects when the session exists but the worktree is gone", () => {
		expect(classifyRunningAutoWorkRun(baseRun, true, false)).toBe("reconnect");
	});

	test("is stale when the session is gone, regardless of the worktree", () => {
		expect(classifyRunningAutoWorkRun(baseRun, false, true)).toBe("stale");
		expect(classifyRunningAutoWorkRun(baseRun, false, false)).toBe("stale");
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

function fakeBridge(
	handle: FakeSessionHandle,
	opts: {
		models?: ModelInfo[];
		/** Live in-process handles, keyed by sessionId — what `bridge.getSession` finds without a restart. */
		liveSessions?: Map<string, FakeSessionHandle>;
		/** Persisted (on-disk) session summaries `bridge.listSessions`/`resumeSession` can see across a restart. */
		persistedSessions?: SessionSummary[];
	} = {},
): AgentBridge {
	const models = opts.models ?? [AVAILABLE_MODEL];
	return {
		async listModels() {
			return models;
		},
		async createSession() {
			return handle as unknown as SessionHandle;
		},
		getSession(sessionId: string) {
			return opts.liveSessions?.get(sessionId) as unknown as SessionHandle | undefined;
		},
		async listSessions(listOpts: { cwd?: string }) {
			const all = opts.persistedSessions ?? [];
			return listOpts.cwd ? all.filter((s) => s.cwd === listOpts.cwd) : all;
		},
		async resumeSession(resumeOpts: { sessionPath: string }) {
			const match = opts.persistedSessions?.find((s) => s.path === resumeOpts.sessionPath);
			if (!match) throw new Error(`no persisted session at ${resumeOpts.sessionPath}`);
			const resumedHandle = opts.liveSessions?.get(match.id);
			if (!resumedHandle) throw new Error(`no fake handle registered for persisted session ${match.id}`);
			return resumedHandle as unknown as SessionHandle;
		},
	} as unknown as AgentBridge;
}

// Stubs `gh pr create` for every `runAutoWorkCycle` test that reaches the
// success path (T-66) — a test must NEVER let the real default run, since
// that would shell out to `gh` and attempt to open an actual GitHub PR.
async function stubCreatePullRequest(): Promise<{ url: string; number: number }> {
	return { url: "https://github.com/jaesbit/omp-deck/pull/321", number: 321 };
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
			getDeckBaseUrl: () => "https://deck.example.com",
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(task.id);
		expect(result.sessionId).toBe("sess_1");
		expect(fs.existsSync(result.worktreePath)).toBe(true);
		expect(result.worktreePath).toContain(`aw-T${task.displayId}`);

		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_validate");
		expect(updated?.body).toContain("**Auto Work**");
		expect(updated?.body).toContain("[session sess_1](https://deck.example.com/c/sess_1)");
		expect(updated?.body).toContain("PR #321");

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
		let prCreateCalls = 0;
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: async () => {
				prCreateCalls += 1;
				return stubCreatePullRequest();
			},
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

		// A timed-out/failed run never opens a PR — nothing to review (T-66).
		expect(prCreateCalls).toBe(0);
	});

	test("on PR creation failure, still moves the completed task to validate with a fallback note (T-66)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "PR step fails", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_pr_fail", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			getDeckBaseUrl: () => "https://deck.example.com",
			createPullRequest: async () => {
				throw new Error("gh pr create failed (exit 1): no git remotes found");
			},
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");

		// The agent's work did complete — losing the PR step shouldn't silently
		// discard that behind an unrelated `gh` error, so the task still moves
		// to validate with a note that the PR needs to be opened by hand.
		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_validate");
		expect(updated?.body).toContain("[session sess_pr_](https://deck.example.com/c/sess_pr_fail)");
		expect(updated?.body).toContain("PR creation failed");

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]?.status).toBe("completed");
	});

	test("resumes the active run instead of starting new work when another run is already active for the workspace (mutex)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const activeTask = createTask({ title: "Already running", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(activeTask.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-mutex");
		fs.mkdirSync(worktreePath, { recursive: true });
		const priorRunId = startAutoWorkRun({
			taskId: activeTask.id,
			taskPriority: "P5",
			sessionId: "already-running",
			worktreePath,
		});

		// A second, unrelated backlog task that must NOT be picked up while the
		// first run is still (genuinely) active.
		const queuedTask = createTask({ title: "Queued", cwd: repoCwd, priority: "P5", autoWork: true });

		const liveHandle = new FakeSessionHandle("already-running", 10);
		const decoyHandle = new FakeSessionHandle("sess_2", 10);
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(decoyHandle, { liveSessions: new Map([["already-running", liveHandle]]) }),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(activeTask.id);
		expect(result.runId).toBe(priorRunId);
		expect(result.sessionId).toBe("already-running");

		// The unrelated queued task must not have been touched or started —
		// the mutex still holds for a genuinely live running row.
		expect(getTask(queuedTask.id)?.stateId).toBe("s_backlog");
		expect(listAutoWorkRuns({ taskId: queuedTask.id })).toHaveLength(0);
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

describe("runGlobalAutoWorkCycle", () => {
	test("does not call the selector when no workspace has a candidate", async () => {
		let selectorCalls = 0;

		const result = await runGlobalAutoWorkCycle(fakeBridge(new FakeSessionHandle("unused", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			selectTask: async () => {
				selectorCalls += 1;
				return undefined;
			},
		});

		expect(result).toEqual({ outcome: "skipped", reason: "no workspace has auto-work enabled" });
		expect(selectorCalls).toBe(0);
	});

	test("uses the selector's candidate ID instead of deterministic priority", async () => {
		const otherRepoCwd = path.join(homeDir, "other-workspace");
		fs.mkdirSync(otherRepoCwd, { recursive: true });
		runGit(["init", "-q"], otherRepoCwd);
		runGit(["config", "user.email", "test@example.com"], otherRepoCwd);
		runGit(["config", "user.name", "Test"], otherRepoCwd);
		fs.writeFileSync(path.join(otherRepoCwd, "README.md"), "other\n");
		runGit(["add", "."], otherRepoCwd);
		runGit(["commit", "-q", "-m", "init"], otherRepoCwd);

		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		setAutoWorkConfig(otherRepoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const deterministicWinner = createTask({ title: "P0 fallback", cwd: repoCwd, priority: "P0", autoWork: true });
		const selectorWinner = createTask({ title: "Selector winner", cwd: otherRepoCwd, priority: "P5", autoWork: true });
		let selectorCandidates: string[] | undefined;

		const result = await runGlobalAutoWorkCycle(fakeBridge(new FakeSessionHandle("global-selector", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			selectTask: async (candidates) => {
				selectorCandidates = candidates.map((candidate) => candidate.task.id);
				return selectorWinner.id;
			},
		});

		expect(selectorCandidates).toEqual([deterministicWinner.id, selectorWinner.id]);
		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(selectorWinner.id);
		expect(getTask(selectorWinner.id)?.stateId).toBe("s_validate");
		expect(getTask(deterministicWinner.id)?.stateId).toBe("s_backlog");
	});
});

describe("runAutoWorkCycle session continuation (T-65)", () => {
	test("resumes an interrupted run via its live session handle — no new worktree or session is created", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Interrupted mid-run", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);

		const worktreePath = path.join(repoCwd, ".worktrees", "aw-resume");
		fs.mkdirSync(worktreePath, { recursive: true });
		const priorRunId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_prev",
			worktreePath,
		});

		const liveHandle = new FakeSessionHandle("sess_prev", 10);
		// A distinct decoy: if the engine wrongly restarted the task instead of
		// resuming, `createSession` would return this handle and the assertions
		// on sessionId/runId below would fail.
		const decoyHandle = new FakeSessionHandle("sess_fresh", 10);
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(decoyHandle, { liveSessions: new Map([["sess_prev", liveHandle]]) }),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.sessionId).toBe("sess_prev");
		expect(result.runId).toBe(priorRunId);
		expect(result.worktreePath).toBe(worktreePath);

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("completed");

		// No duplicate worktree was created for the same task.
		const worktreeDirs = fs.readdirSync(path.join(repoCwd, ".worktrees"));
		expect(worktreeDirs).toEqual(["aw-resume"]);
	});

	test("reconnects to a live session when its worktree directory is gone, without creating a new worktree", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Reconnect target", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);

		// Never created on disk — simulates the worktree having been deleted
		// out from under a still-running session.
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-vanished");
		startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_alive",
			worktreePath,
		});

		const liveHandle = new FakeSessionHandle("sess_alive", 10);
		const decoyHandle = new FakeSessionHandle("sess_fresh", 10);
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(decoyHandle, { liveSessions: new Map([["sess_alive", liveHandle]]) }),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.sessionId).toBe("sess_alive");
		expect(result.worktreePath).toBe(worktreePath);
		// Nothing was ever created under .worktrees for this run.
		expect(fs.existsSync(path.join(repoCwd, ".worktrees"))).toBe(false);
	});

	test("marks a lost run stale: task returns to backlog, worktree is removed, run is failed", async () => {
		// enabled: false isolates the stale-cleanup path from a subsequent
		// task-selection cycle re-picking up the now-backlogged task.
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: false });
		const task = createTask({ title: "Orphaned", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);

		const worktreePath = path.join(repoCwd, ".worktrees", "aw-stale");
		runGit(["worktree", "add", "-b", "auto-work/stale-test", worktreePath], repoCwd);
		expect(fs.existsSync(worktreePath)).toBe(true);

		startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_gone",
			worktreePath,
		});

		const handle = new FakeSessionHandle("sess_never_used", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result).toEqual({ outcome: "skipped", reason: expect.stringContaining("disabled") });

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("failed");
		expect(runs[0]?.failureReason).toBe("session_lost");

		expect(getTask(task.id)?.stateId).toBe("s_backlog");
		expect(fs.existsSync(worktreePath)).toBe(false);
	});

	test("does not treat a stale run as a mutex block — a fresh eligible task is picked up in the same cycle", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const staleTask = createTask({ title: "Was active, now orphaned", cwd: repoCwd, priority: "P1", autoWork: true });
		moveTask(staleTask.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-stale-2");
		runGit(["worktree", "add", "-b", "auto-work/stale-test-2", worktreePath], repoCwd);
		startAutoWorkRun({
			taskId: staleTask.id,
			taskPriority: "P1",
			sessionId: "sess_gone_2",
			worktreePath,
		});

		const freshTask = createTask({ title: "Fresh backlog task", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_new", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(freshTask.id);
		expect(result.sessionId).toBe("sess_new");

		expect(getTask(staleTask.id)?.stateId).toBe("s_backlog");
		expect(fs.existsSync(worktreePath)).toBe(false);
	});
});

// ─── Notifications (T-67) ───────────────────────────────────────────────────

function recordingNotify(): {
	notify: (event: AutoWorkNotificationEvent) => Promise<void>;
	calls: AutoWorkNotificationEvent[];
} {
	const calls: AutoWorkNotificationEvent[] = [];
	return {
		calls,
		notify: async (event) => {
			calls.push(event);
		},
	};
}

describe("runAutoWorkCycle notifications (T-67)", () => {
	test("notifies task_started then task_completed with the PR number on a fresh successful run", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Ship the thing", cwd: repoCwd, priority: "P5", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_1", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			notify,
		});

		expect(result.outcome).toBe("completed");
		expect(calls).toEqual([
			{ kind: "task_started", displayId: task.displayId, title: task.title, model: "default" },
			{ kind: "task_completed", displayId: task.displayId, prNumber: 321 },
		]);
	});

	test("notifies task_failed with the timeout reason when a run times out", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			timeoutMinutesByPriority: { P0: 120, P1: 90, P2: 60, P3: 45, P4: 45, P5: 0.0005 },
		});
		const task = createTask({ title: "Slow task", cwd: repoCwd, priority: "P5", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_timeout", null);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			notify,
		});

		expect(result.outcome).toBe("timed_out");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ kind: "task_started", displayId: task.displayId, title: task.title, model: "default" });
		expect(calls[1]?.kind).toBe("task_failed");
		if (calls[1]?.kind === "task_failed") {
			expect(calls[1].displayId).toBe(task.displayId);
			expect(calls[1].reason).toContain("timeout");
		}
	});

	test("does not notify task_completed when PR creation fails (fallback note only)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({ title: "PR step fails", cwd: repoCwd, priority: "P5", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_pr_fail", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: async () => {
				throw new Error("gh pr create failed (exit 1): no git remotes found");
			},
			notify,
		});

		expect(result.outcome).toBe("completed");
		expect(calls.map((c) => c.kind)).toEqual(["task_started"]);
	});

	test("notifies weekly_threshold once usage crosses the configured threshold, even on a cycle that still starts a task", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true, weeklyPctThreshold: 70 });
		createTask({ title: "Under the hard limit", cwd: repoCwd, priority: "P5", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_weekly", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			// Below weeklyPctLimit (100, default) so the cycle proceeds, but above
			// the 70% weeklyPctThreshold configured above.
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 75 }),
			createPullRequest: stubCreatePullRequest,
			notify,
		});

		expect(result.outcome).toBe("completed");
		expect(calls[0]).toEqual({ kind: "weekly_threshold", cwd: repoCwd, pctUsed: 75, thresholdPct: 70 });
	});

	test("notifies session_limit when every eligible task is skipped for budget reasons", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			sessionPctLimit: 1,
			weeklyPctLimit: 100,
			weeklyPctThreshold: 100,
		});
		createTask({ title: "Too expensive", cwd: repoCwd, priority: "P0", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_session_limit", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			notify,
		});

		expect(result.outcome).toBe("skipped");
		expect(calls).toEqual([{ kind: "session_limit", sessionPctUsed: 5, sessionPctLimit: 1 }]);
	});

	test("prefers the weekly_threshold notification over session_limit when both conditions are true in the same cycle", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			sessionPctLimit: 1,
			weeklyPctLimit: 100,
			weeklyPctThreshold: 70,
		});
		createTask({ title: "Too expensive", cwd: repoCwd, priority: "P0", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_precedence", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			// Above both the 70% weekly threshold and (given sessionPctLimit=1)
			// enough to also make every eligible task fail to fit the budget.
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 80 }),
			notify,
		});

		expect(result.outcome).toBe("skipped");
		// Exactly one notification for the cycle — the weekly warning — never both.
		expect(calls).toEqual([{ kind: "weekly_threshold", cwd: repoCwd, pctUsed: 80, thresholdPct: 70 }]);
	});
});
