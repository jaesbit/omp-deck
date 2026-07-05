/**
 * Auto Work execution engine (T-64) — the core loop that selects the next
 * eligible task, checks budgets and the time window, creates a worktree,
 * launches an agent session, and waits for it to reach a terminal state.
 *
 * Design: the decision logic (`checkAutoWorkPreflight`, `selectNextAutoWorkTask`,
 * `costFitsAutoWorkBudget`) is pure — it takes already-fetched data as plain
 * arguments and never touches the DB, the filesystem, or the bridge. This
 * makes it unit-testable without a live database or agent session. The only
 * side-effecting piece is the `runAutoWorkCycle` orchestrator, which fetches
 * the data, calls the pure functions, and — only once they agree a task
 * should run — creates the worktree, calls `bridge.createSession()`, and
 * drives the DB writes (`moveTask`, `startAutoWorkRun`, `completeAutoWorkRun`).
 *
 * "Terminal state" detection reuses the exact mechanism the idle-session
 * reaper uses internally (see `bridge/in-process.ts`): subscribe to the
 * session's event stream and watch for a `turn_start` → `turn_end`/`agent_end`
 * pair. There is no separate "auto-work done" event type — turn completion
 * *is* terminal state for a one-shot session.
 *
 * Explicitly out of scope here (later tickets in the stack):
 *  - T-65: resuming a run after a server restart. We do record `sessionId` /
 *    `worktreePath` on the `auto_work_runs` row from the moment execution
 *    starts, so T-65 has something to resume from.
 *  - T-66: PR creation + moving the task to `validate` on success. A
 *    successful run leaves the task in `active` with the run row closed
 *    `status: "completed"` — T-66 picks up from there.
 *  - T-67: notifications. Lifecycle transitions are logged at info/warn so a
 *    notifier can hook the log stream later.
 */

import * as path from "node:path";

import type {
	AutoWorkConfig,
	AutoWorkCycleResult,
	AutoWorkRun,
	ModelRef,
	Task,
	TaskPriority,
} from "@omp-deck/protocol";

import type { AgentBridge, SessionHandle } from "../bridge/types.ts";
import { getAutoWorkConfig } from "../db/auto-work.ts";
import { completeAutoWorkRun, listAutoWorkRuns, startAutoWorkRun } from "../db/auto-work-runs.ts";
import { findStateByName, listTasks, moveTask, updateTask } from "../db/tasks.ts";
import { getWorkspacePreference } from "../db/workspace-preferences.ts";
import { logger } from "../log.ts";
import { getSubscriptionUsage } from "../usage-subscription.ts";
import { estimateTaskCostPct } from "./estimate.ts";

const log = logger("auto-work:engine");

const PRIORITY_ORDER: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

// ─── Pure decision logic ────────────────────────────────────────────────────

export interface AutoWorkPreflightInput {
	config: AutoWorkConfig;
	/** Wall-clock time to evaluate the time window against (server-local hour). */
	now: Date;
	/** Subscription usage % consumed so far this week, or `null` when unavailable. */
	subscriptionPctUsed: number | null;
	/** Auto-work runs already scoped to this workspace (any status — the check filters for `running`). */
	activeRuns: AutoWorkRun[];
}

export type AutoWorkPreflightResult = { ok: true } | { ok: false; reason: string };

/**
 * Pre-flight checks, in order: workspace enabled, within the configured time
 * window, subscription usage below `weeklyPctLimit`, and no other run
 * currently active for this workspace (mutex via `auto_work_runs`).
 */
export function checkAutoWorkPreflight(input: AutoWorkPreflightInput): AutoWorkPreflightResult {
	const { config, now, subscriptionPctUsed, activeRuns } = input;

	if (!config.enabled) {
		return { ok: false, reason: "auto-work is disabled for this workspace" };
	}

	const hour = now.getHours();
	const inWindow = config.timeWindows.some((w) => hour >= w.start && hour < w.end);
	if (!inWindow) {
		const windows = config.timeWindows.map((w) => `${w.start}-${w.end}`).join(", ");
		return {
			ok: false,
			reason: `current hour (${hour}) is outside the configured run window(s) ${windows}`,
		};
	}

	if (subscriptionPctUsed === null) {
		return { ok: false, reason: "subscription usage is unavailable — refusing to run blind" };
	}
	if (subscriptionPctUsed >= config.weeklyPctLimit) {
		return {
			ok: false,
			reason: `subscription usage (${subscriptionPctUsed.toFixed(1)}%) is at or above the weekly limit (${config.weeklyPctLimit}%)`,
		};
	}

	if (activeRuns.some((r) => r.status === "running")) {
		return { ok: false, reason: "another auto-work run is already active for this workspace" };
	}

	return { ok: true };
}

/**
 * Does an estimated cost fit the remaining budget? Two independent caps:
 * the estimate alone must not exceed the per-run `sessionPctLimit`, and
 * adding it to what's already been consumed this week must not cross
 * `weeklyPctLimit`.
 */
export function costFitsAutoWorkBudget(
	estimatedPct: number,
	currentPctUsed: number,
	config: AutoWorkConfig,
): boolean {
	return estimatedPct <= config.sessionPctLimit && currentPctUsed + estimatedPct <= config.weeklyPctLimit;
}

export interface TaskSelectionInput {
	/** Tasks already scoped to the workspace being considered. */
	tasks: Task[];
	config: AutoWorkConfig;
	/** Subscription usage % consumed so far this week (0 when unavailable — preflight already gates that case). */
	currentPctUsed: number;
	backlogStateId: string;
	doneStateId: string;
	/** Injected rather than calling `estimateTaskCostPct` directly, so this stays DB-free and pure. */
	estimateCostPct: (priority: TaskPriority) => number;
}

export type TaskSelectionResult =
	| { kind: "selected"; task: Task; estimatedCostPct: number }
	| { kind: "none_eligible" }
	| { kind: "none_fit"; consideredCount: number };

/**
 * `autoWork=true` AND `stateId=backlog` AND every `dependsOn` task is
 * `done` → sorted by priority (P0 first) then `orderInState`. Walks the
 * sorted list and returns the first task whose estimated cost fits the
 * budget; skips (does not just stop at) tasks that don't fit, since a lower
 * priority task further down the list may still be affordable.
 */
export function selectNextAutoWorkTask(input: TaskSelectionInput): TaskSelectionResult {
	const { tasks, config, currentPctUsed, backlogStateId, doneStateId, estimateCostPct } = input;
	const tasksById = new Map(tasks.map((t) => [t.id, t]));

	const eligible = tasks
		.filter((t) => t.autoWork && t.stateId === backlogStateId)
		.filter((t) => t.dependsOn.every((depId) => tasksById.get(depId)?.stateId === doneStateId))
		.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.orderInState - b.orderInState);

	if (eligible.length === 0) return { kind: "none_eligible" };

	for (const task of eligible) {
		const estimatedCostPct = estimateCostPct(task.priority);
		if (costFitsAutoWorkBudget(estimatedCostPct, currentPctUsed, config)) {
			return { kind: "selected", task, estimatedCostPct };
		}
	}

	return { kind: "none_fit", consideredCount: eligible.length };
}

/** Per-priority timeout lookup (minutes), configurable via `AutoWorkConfig.timeoutMinutesByPriority`. */
export function resolveAutoWorkTimeoutMinutes(priority: TaskPriority, config: AutoWorkConfig): number {
	return config.timeoutMinutesByPriority[priority];
}

/**
 * Model resolution order: per-priority override (T-60 config) → per-workspace
 * default (T-42's `WorkspacePreference`) → `undefined`, which leaves the
 * `model` field off `CreateSessionOpts` entirely so the bridge/SDK picks its
 * own global default (same fallback chain `POST /sessions` uses).
 */
export function resolveAutoWorkModel(
	priority: TaskPriority,
	config: AutoWorkConfig,
	workspaceDefaultModel: ModelRef | null,
): ModelRef | undefined {
	return config.modelByPriority[priority] ?? workspaceDefaultModel ?? undefined;
}

// ─── Orchestrator (IO) ──────────────────────────────────────────────────────

export interface RunAutoWorkCycleOptions {
	/** Injectable for tests — defaults to the real cached subscription-usage lookup. */
	getSubscriptionUsage?: () => Promise<{ available: boolean; weeklyPct?: number }>;
	/** Injectable clock for tests — defaults to `new Date()`. */
	now?: () => Date;
}

/**
 * Runs exactly one auto-work cycle for `cwd`: pre-flight checks, task
 * selection, worktree + session creation, and waiting for the session to
 * reach a terminal state (or the per-priority timeout to fire). Safe to call
 * repeatedly/concurrently for the same workspace — the mutex pre-flight
 * check refuses to start a second run while one is `status: "running"`.
 */
export async function runAutoWorkCycle(
	cwd: string,
	bridge: AgentBridge,
	options: RunAutoWorkCycleOptions = {},
): Promise<AutoWorkCycleResult> {
	const config = getAutoWorkConfig(cwd);
	const now = (options.now ?? (() => new Date()))();
	const usageLookup = options.getSubscriptionUsage ?? (() => getSubscriptionUsage());
	const usage = await usageLookup();
	const subscriptionPctUsed = usage.available && typeof usage.weeklyPct === "number" ? usage.weeklyPct : null;

	const allTasks = listTasks();
	const workspaceTasks = allTasks.filter((t) => t.cwd === cwd);
	const workspaceTaskIds = new Set(workspaceTasks.map((t) => t.id));
	const activeRuns = listAutoWorkRuns({ status: "running" }).filter((r) => workspaceTaskIds.has(r.taskId));

	const preflight = checkAutoWorkPreflight({ config, now, subscriptionPctUsed, activeRuns });
	if (!preflight.ok) {
		log.info(`cycle skipped for ${cwd}: ${preflight.reason}`);
		return { outcome: "skipped", reason: preflight.reason };
	}

	const backlogState = findStateByName("backlog");
	const doneState = findStateByName("done");
	const activeState = findStateByName("active");
	const blockedState = findStateByName("blocked");
	if (!backlogState || !doneState || !activeState || !blockedState) {
		const reason = "backlog/done/active/blocked task states are missing — cannot run auto-work";
		log.error(reason);
		return { outcome: "skipped", reason };
	}

	const selection = selectNextAutoWorkTask({
		tasks: workspaceTasks,
		config,
		currentPctUsed: subscriptionPctUsed ?? 0,
		backlogStateId: backlogState.id,
		doneStateId: doneState.id,
		estimateCostPct: (priority) => estimateTaskCostPct(priority, config),
	});

	if (selection.kind !== "selected") {
		const reason =
			selection.kind === "none_eligible"
				? "no eligible auto-work tasks in backlog (autoWork flag, dependencies, or state)"
				: `${selection.consideredCount} eligible task(s) considered but none fit the current cost/budget limits`;
		log.info(`cycle for ${cwd}: ${reason}`);
		return { outcome: "skipped", reason };
	}

	const { task, estimatedCostPct } = selection;
	log.info(
		`selected T-${task.displayId} "${task.title}" (${task.priority}), estimated cost ${estimatedCostPct.toFixed(1)}%`,
	);

	const workspacePreference = getWorkspacePreference(cwd);
	const model = resolveAutoWorkModel(task.priority, config, workspacePreference?.model ?? null);
	if (model) {
		const invalid = await validateModelRef(bridge, model);
		if (invalid) {
			const reason = `configured model for ${task.priority} is invalid: ${invalid}`;
			log.error(reason);
			return { outcome: "skipped", reason };
		}
	}

	const worktreePath = await createAutoWorkWorktree(cwd, task);

	const session = await bridge.createSession({
		cwd: worktreePath,
		...(model ? { model } : {}),
	});

	moveTask(task.id, activeState.id, 0);
	const runId = startAutoWorkRun({
		taskId: task.id,
		taskPriority: task.priority,
		sessionId: session.sessionId,
		worktreePath,
	});
	log.info(`run ${runId} started for T-${task.displayId}, session ${session.sessionId}, worktree ${worktreePath}`);

	const prompt = `Trabaja en T-${task.displayId}: ${task.title}\n\n(contexto completo disponible via GET /api/tasks/${task.id})`;
	await session.prompt(prompt);

	const timeoutMinutes = resolveAutoWorkTimeoutMinutes(task.priority, config);
	const terminal = await waitForAutoWorkSessionTerminal(session, timeoutMinutes * 60_000);

	if (terminal === "timed_out") {
		const failureReason = `exceeded ${timeoutMinutes}min timeout for priority ${task.priority}`;
		completeAutoWorkRun(runId, { status: "timed_out", failureReason });
		moveTask(task.id, blockedState.id, 0);
		updateTask(task.id, {
			body: `${task.body}\n\n---\n**Auto Work timeout** — run \`${runId}\` ${failureReason}. Session: \`${session.sessionId}\`, worktree: \`${worktreePath}\`.`,
		});
		log.warn(`run ${runId} timed out; T-${task.displayId} moved to blocked (${failureReason})`);
		return { outcome: "timed_out", taskId: task.id, runId, sessionId: session.sessionId, worktreePath };
	}

	completeAutoWorkRun(runId, { status: "completed" });
	log.info(`run ${runId} completed for T-${task.displayId} — awaiting T-66 (PR + validate)`);
	return { outcome: "completed", taskId: task.id, runId, sessionId: session.sessionId, worktreePath };
}

// ─── Small IO helpers ───────────────────────────────────────────────────────

/**
 * Terminal-state detection reuses the same signal the idle-session reaper
 * tracks internally (`bridge/in-process.ts`'s `turnInFlight`): a `turn_end`
 * or `agent_end` event on the session's own stream marks the end of a turn.
 * For a one-shot auto-work session, that first turn completing *is* the
 * terminal state we're waiting for.
 */
export function waitForAutoWorkSessionTerminal(
	handle: SessionHandle,
	timeoutMs: number,
): Promise<"completed" | "timed_out"> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (outcome: "completed" | "timed_out") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(outcome);
		};
		const timer = setTimeout(() => finish("timed_out"), timeoutMs);
		(timer as unknown as { unref?: () => void }).unref?.();
		const unsubscribe = handle.subscribe((event) => {
			const type = (event as { type?: string } | undefined)?.type;
			if (type === "turn_end" || type === "agent_end") finish("completed");
		});
	});
}

/**
 * `git worktree add -b auto-work/T<displayId>-<slug> .worktrees/aw-T<displayId>-<slug>`,
 * run from `repoCwd` (the workspace root Auto Work is configured for).
 * Follows this repo's `Bun.spawn` convention (see `routes-fs.ts::runGitLsFiles`,
 * `build-info.ts`) rather than `node:child_process`. First programmatic
 * `git worktree add` call in the codebase — worktrees so far were all
 * created manually.
 */
async function createAutoWorkWorktree(repoCwd: string, task: Task): Promise<string> {
	const slug = slugifyTaskTitle(task.title);
	const dirName = `aw-T${task.displayId}-${slug}`;
	const worktreePath = path.join(repoCwd, ".worktrees", dirName);
	const branch = `auto-work/t${task.displayId}-${slug}`;

	const proc = Bun.spawn(["git", "worktree", "add", "-b", branch, worktreePath], {
		cwd: repoCwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) {
		throw new Error(`git worktree add failed (exit ${exitCode}) for T-${task.displayId}: ${stderr.trim()}`);
	}
	return worktreePath;
}

function slugifyTaskTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "task";
}

/**
 * Validate a `ModelRef` against the bridge's live model catalog. Mirrors
 * `routes.ts`'s and `routes-auto-work.ts`'s private `validateModelRef` —
 * duplicated rather than imported since neither is exported and this module
 * owns its own small set of private helpers per the repo's convention.
 */
async function validateModelRef(bridge: AgentBridge, ref: ModelRef): Promise<string | undefined> {
	const models = await bridge.listModels();
	const match = models.find((m) => m.provider === ref.provider && m.id === ref.id);
	if (!match) return `unknown model: ${ref.provider}/${ref.id}`;
	if (!match.isAvailable) return `no auth configured for ${ref.provider}/${ref.id}`;
	return undefined;
}
