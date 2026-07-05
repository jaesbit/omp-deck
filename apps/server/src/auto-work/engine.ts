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
 * On a successful run (T-66), `finalizeAutoWorkRun` opens a PR from the
 * worktree branch, appends a session-link + PR-reference note to the task
 * body, and moves the task to `validate` (never `done` — every auto-work
 * result is human-reviewed) before closing the run row `status: "completed"`.
 *
 * Explicitly out of scope here (later tickets in the stack):
 *  - T-67: notifications. Lifecycle transitions are logged at info/warn so a
 *    notifier can hook the log stream later.
 */

import * as fs from "node:fs";
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
import { loadConfig } from "../config.ts";
import { buildSessionUrl } from "../deck-links.ts";
import { getAutoWorkConfig } from "../db/auto-work.ts";
import { completeAutoWorkRun, listAutoWorkRuns, startAutoWorkRun } from "../db/auto-work-runs.ts";
import { getDeckBaseUrl as getServerDeckBaseUrl } from "../db/server-settings.ts";
import { findStateByName, getTask, listTasks, moveTask, updateTask } from "../db/tasks.ts";
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

export type RunningAutoWorkRunClassification = "resume" | "reconnect" | "stale";

/**
 * Classifies a `status: "running"` `auto_work_runs` row found at the start
 * of a cycle (T-65). `sessionExists`/`worktreeExists` are resolved by the
 * caller — this stays pure so the three outcomes are unit-testable without
 * a bridge or filesystem:
 *
 *  - session alive, worktree present → `"resume"`: pick the run back up and
 *    wait for it to reach a terminal state; skip task selection entirely.
 *  - session alive, worktree gone → `"reconnect"`: same as resume, but the
 *    directory the agent was writing to disappeared out from under it (e.g.
 *    manual cleanup). Let the agent finish in whatever state it's in.
 *  - session gone (no live handle and nothing persisted to `resumeSession`
 *    from) → `"stale"`: unrecoverable. Caller fails the run, returns the
 *    task to backlog, and removes the worktree before falling through to
 *    normal task selection.
 */
export function classifyRunningAutoWorkRun(
	_run: AutoWorkRun,
	sessionExists: boolean,
	worktreeExists: boolean,
): RunningAutoWorkRunClassification {
	if (!sessionExists) return "stale";
	return worktreeExists ? "resume" : "reconnect";
}

// ─── Orchestrator (IO) ──────────────────────────────────────────────────────

export interface RunAutoWorkCycleOptions {
	/** Injectable for tests — defaults to the real cached subscription-usage lookup. */
	getSubscriptionUsage?: () => Promise<{ available: boolean; weeklyPct?: number }>;
	/** Injectable clock for tests — defaults to `new Date()`. */
	now?: () => Date;
	/**
	 * Resolves the deck base URL used to build the session link appended to a
	 * completed task's body (T-66). Defaults to the real T-61 setting via
	 * `getDeckBaseUrl(loadConfig())`. Injectable for tests so they don't need
	 * a real `Config`/on-disk `server_settings` row.
	 */
	getDeckBaseUrl?: () => string;
	/**
	 * Opens the PR for a successfully completed run (T-66). Defaults to a
	 * real `gh pr create` invocation via `Bun.spawn`. Injectable for tests —
	 * a test must NEVER let the real default run, since that would shell out
	 * to `gh` and attempt to open an actual GitHub PR.
	 */
	createPullRequest?: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
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
	const resolveDeckBaseUrl = options.getDeckBaseUrl ?? (() => getServerDeckBaseUrl(loadConfig()).deckBaseUrl);
	const createPullRequest = options.createPullRequest ?? createPullRequestViaGh;

	const allTasks = listTasks();
	const workspaceTasks = allTasks.filter((t) => t.cwd === cwd);
	const workspaceTaskIds = new Set(workspaceTasks.map((t) => t.id));
	let activeRuns = listAutoWorkRuns({ status: "running" }).filter((r) => workspaceTaskIds.has(r.taskId));

	// A `running`-status row that survived a server restart needs to be
	// resumed (or retired), not silently treated as a mutex block — see
	// `classifyRunningAutoWorkRun` (T-65).
	const runningRun = activeRuns.find((r) => r.status === "running");
	if (runningRun) {
		const resumed = await resumeOrRetireAutoWorkRun(cwd, bridge, runningRun, config, {
			resolveDeckBaseUrl,
			createPullRequest,
		});
		if (resumed) return resumed;
		activeRuns = activeRuns.filter((r) => r.id !== runningRun.id);
	}

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
	return finalizeAutoWorkRun({ runId, task, session, worktreePath, timeoutMinutes, resolveDeckBaseUrl, createPullRequest });
}

// ─── Small IO helpers ───────────────────────────────────────────────────────

/**
 * Shared tail of the "a session is actively running" path — waits for
 * terminal state (or timeout) and closes out the DB rows accordingly. Used
 * by both a freshly-started run and a `"resume"`/`"reconnect"` pickup of a
 * pre-existing one (T-65), so a resumed run gets exactly the same
 * timeout/blocked/completed handling a fresh one does.
 *
 * The success branch (T-66) opens a PR from the worktree branch, appends a
 * session-link + PR-reference note to the task body, and moves the task to
 * `validate` (never `done` — every auto-work result is human-reviewed). A PR
 * creation failure does not fail the run: the agent's work did complete, so
 * the task still moves to `validate` with a note that the PR needs to be
 * opened by hand — surfacing that loudly in the body and the logs beats
 * silently discarding a completed session behind an unrelated `gh` error.
 */
async function finalizeAutoWorkRun(params: {
	runId: string;
	task: Task;
	session: SessionHandle;
	worktreePath: string;
	timeoutMinutes: number;
	resolveDeckBaseUrl: () => string;
	createPullRequest: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
}): Promise<AutoWorkCycleResult> {
	const { runId, task, session, worktreePath, timeoutMinutes, resolveDeckBaseUrl, createPullRequest } = params;
	const terminal = await waitForAutoWorkSessionTerminal(session, timeoutMinutes * 60_000);

	if (terminal === "timed_out") {
		const failureReason = `exceeded ${timeoutMinutes}min timeout for priority ${task.priority}`;
		completeAutoWorkRun(runId, { status: "timed_out", failureReason });
		const blockedState = findStateByName("blocked");
		if (blockedState) moveTask(task.id, blockedState.id, 0);
		updateTask(task.id, {
			body: `${task.body}\n\n---\n**Auto Work timeout** — run \`${runId}\` ${failureReason}. Session: \`${session.sessionId}\`, worktree: \`${worktreePath}\`.`,
		});
		log.warn(`run ${runId} timed out; T-${task.displayId} moved to blocked (${failureReason})`);
		return { outcome: "timed_out", taskId: task.id, runId, sessionId: session.sessionId, worktreePath };
	}

	const deckBaseUrl = resolveDeckBaseUrl();
	const sessionUrl = buildSessionUrl(deckBaseUrl, session.sessionId);
	const shortSessionId = session.sessionId.slice(0, 8);

	let prNote: string;
	try {
		const pr = await createPullRequest({
			cwd: worktreePath,
			title: `feat: T-${task.displayId} ${task.title}`,
			body: `Auto Work completed T-${task.displayId}: ${task.title}\n\nSession: ${sessionUrl}`,
		});
		prNote = `PR #${pr.number}`;
		log.info(`run ${runId}: opened PR #${pr.number} (${pr.url}) for T-${task.displayId}`);
	} catch (err) {
		prNote = "PR creation failed — open manually";
		log.error(`run ${runId}: gh pr create failed for T-${task.displayId}`, err);
	}

	updateTask(task.id, {
		body: `${task.body}\n\n---\n**Auto Work** — [session ${shortSessionId}](${sessionUrl}) · ${prNote}`,
	});

	const validateState = findStateByName("validate");
	if (validateState) moveTask(task.id, validateState.id, 0);
	else log.error(`run ${runId}: "validate" task state not found — T-${task.displayId} left in its current state`);

	completeAutoWorkRun(runId, { status: "completed" });
	log.info(`run ${runId} completed for T-${task.displayId} — moved to validate`);
	return { outcome: "completed", taskId: task.id, runId, sessionId: session.sessionId, worktreePath };
}

/**
 * Resolves a live handle for `run.sessionId`: the in-process bridge may
 * still hold it (nothing was interrupted, or the same process is calling
 * `runAutoWorkCycle` again while the prior call's session is still going),
 * or it may only exist as a persisted `.jsonl` the bridge can
 * `resumeSession()` from (server restarted since the run started, dropping
 * every in-memory handle). Returns `undefined` when neither exists — that
 * is the "stale" case `classifyRunningAutoWorkRun` fails the run on.
 */
async function resolveRunningSessionHandle(
	bridge: AgentBridge,
	run: AutoWorkRun,
): Promise<SessionHandle | undefined> {
	const live = bridge.getSession(run.sessionId);
	if (live) return live;

	const persisted = await findPersistedAutoWorkSession(bridge, run);
	if (!persisted) return undefined;
	return bridge.resumeSession({ sessionPath: persisted.path });
}

/**
 * Looks up `run.sessionId` in the bridge's persisted-session listing.
 * Scoped to `run.worktreePath` first (the common case, and cheap for
 * implementations that index by cwd); falls back to the unscoped listing
 * because the worktree directory itself may be gone (T-65's "reconnect"
 * case) even though the underlying `.jsonl` still exists under
 * `~/.omp/agent/sessions`.
 */
async function findPersistedAutoWorkSession(bridge: AgentBridge, run: AutoWorkRun) {
	const scoped = await bridge.listSessions({ cwd: run.worktreePath });
	const inScope = scoped.find((s) => s.id === run.sessionId);
	if (inScope) return inScope;
	const all = await bridge.listSessions({});
	return all.find((s) => s.id === run.sessionId);
}

/**
 * `git worktree remove --force`, run from `repoCwd`. Idempotent: a
 * worktree directory that's already gone is a no-op, not an error — this
 * is called from the "stale run" cleanup path where the directory's
 * presence is exactly what's in question.
 */
async function removeAutoWorkWorktree(repoCwd: string, worktreePath: string): Promise<void> {
	if (!fs.existsSync(worktreePath)) return;
	const proc = Bun.spawn(["git", "worktree", "remove", "--force", worktreePath], {
		cwd: repoCwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) {
		log.warn(`git worktree remove --force ${worktreePath} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
}

/**
 * The pre-flight step that distinguishes "another run is genuinely active"
 * from "a running-status row is stale because the process that owned it
 * died or restarted" (T-65). Called once per cycle, before the mutex check,
 * for a workspace's sole `status: "running"` row (there is at most one —
 * the mutex enforces that on the way in).
 *
 * Returns the finished `AutoWorkCycleResult` when the run was resumed or
 * reconnected (caller should return it as-is, skipping task selection).
 * Returns `undefined` when the run turned out to be stale — the caller
 * falls through to normal pre-flight + task selection in that case, since
 * `resumeOrRetireAutoWorkRun` has already closed the row, moved the task
 * back to backlog, and removed the worktree.
 */
async function resumeOrRetireAutoWorkRun(
	cwd: string,
	bridge: AgentBridge,
	run: AutoWorkRun,
	config: AutoWorkConfig,
	completion: {
		resolveDeckBaseUrl: () => string;
		createPullRequest: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
	},
): Promise<AutoWorkCycleResult | undefined> {
	const handle = await resolveRunningSessionHandle(bridge, run);
	const worktreeExists = fs.existsSync(run.worktreePath);
	const classification = classifyRunningAutoWorkRun(run, handle !== undefined, worktreeExists);

	if (classification === "stale" || !handle) {
		log.warn(
			`run ${run.id} (session ${run.sessionId}) has no live or persisted session to resume — marking failed and returning the task to backlog`,
		);
		completeAutoWorkRun(run.id, { status: "failed", failureReason: "session_lost" });
		const backlogState = findStateByName("backlog");
		if (backlogState) moveTask(run.taskId, backlogState.id, 0);
		await removeAutoWorkWorktree(cwd, run.worktreePath);
		return undefined;
	}

	const task = getTask(run.taskId);
	if (!task) {
		log.warn(`run ${run.id}: task ${run.taskId} no longer exists — closing the run as failed`);
		completeAutoWorkRun(run.id, { status: "failed", failureReason: "session_lost" });
		await removeAutoWorkWorktree(cwd, run.worktreePath);
		return undefined;
	}

	log.info(
		`${classification === "resume" ? "resuming" : "reconnecting to"} run ${run.id} for T-${task.displayId}, ` +
			`session ${run.sessionId}${worktreeExists ? "" : " (worktree missing)"}`,
	);

	const timeoutMinutes = resolveAutoWorkTimeoutMinutes(run.taskPriority, config);
	return finalizeAutoWorkRun({
		runId: run.id,
		task,
		session: handle,
		worktreePath: run.worktreePath,
		timeoutMinutes,
		resolveDeckBaseUrl: completion.resolveDeckBaseUrl,
		createPullRequest: completion.createPullRequest,
	});
}

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

export interface CreatePullRequestParams {
	/** The worktree directory the PR is opened from — its checked-out branch becomes the PR head. */
	cwd: string;
	title: string;
	body: string;
}

export interface CreatePullRequestResult {
	url: string;
	number: number;
}

/** Base branch auto-work PRs target. No per-workspace override exists yet (T-66 scope: `origin/main`). */
const AUTO_WORK_PR_BASE_BRANCH = "main";

/**
 * `gh pr create --base main --title <title> --body <body>`, run from the
 * worktree directory so `gh` infers the PR head from the branch already
 * checked out there (see `createAutoWorkWorktree`). Follows the same
 * `Bun.spawn` convention as `createAutoWorkWorktree`/`removeAutoWorkWorktree`
 * rather than `node:child_process`. Parses the PR number out of the URL
 * `gh pr create` prints on stdout (e.g. `https://github.com/o/r/pull/123`).
 */
async function createPullRequestViaGh(params: CreatePullRequestParams): Promise<CreatePullRequestResult> {
	const proc = Bun.spawn(
		["gh", "pr", "create", "--base", AUTO_WORK_PR_BASE_BRANCH, "--title", params.title, "--body", params.body],
		{ cwd: params.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`gh pr create failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	const url = stdout.trim().split("\n").pop() ?? "";
	const match = url.match(/\/pull\/(\d+)\/?$/);
	if (!match) {
		throw new Error(`gh pr create succeeded but its output didn't contain a PR URL: ${stdout.trim()}`);
	}
	return { url, number: Number(match[1]) };
}
