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
import { resolveKbRoot } from "../kb-service.ts";
import { BRANCH_NAMING_RULES_BODY } from "../kb-templates.ts";
import { completeAutoWorkRun, listAutoWorkRuns, startAutoWorkRun } from "../db/auto-work-runs.ts";
import { getDeckBaseUrl as getServerDeckBaseUrl } from "../db/server-settings.ts";
import { findStateByName, getTask, listTasks, moveTask, updateTask } from "../db/tasks.ts";
import { getWorkspacePreference } from "../db/workspace-preferences.ts";
import { logger } from "../log.ts";
import { notify as sendAutoWorkNotification } from "./notify.ts";
import type { AutoWorkNotificationEvent } from "./notify.ts";
import { getSubscriptionUsage } from "../usage-subscription.ts";
import { estimateTaskCostPct } from "./estimate.ts";
import { broadcastBus } from "../broadcast-bus.ts";
import { getModelCatalogOverlay } from "../model-catalog-overlay.ts";

const log = logger("auto-work:engine");

const PRIORITY_ORDER: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

/** Run ids with a live engine finalizer. They are never stale, even between terminal event delivery and DB completion. */
const activeRunIds = new Set<string>();
const STALE_RUN_GRACE_MS = 60_000;

// ─── Pure decision logic ────────────────────────────────────────────────────

export interface AutoWorkPreflightInput {
	config: AutoWorkConfig;
	/** Wall-clock time to evaluate the time window against (server-local hour). */
	now: Date;
	/** Subscription usage % consumed so far this week, or `null` when unavailable. */
	subscriptionPctUsed: number | null;
	/** Subscription usage % consumed in the shortest (session) window, or `null` when unavailable. */
	sessionPctUsed: number | null;
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
	const { config, now, subscriptionPctUsed, sessionPctUsed, activeRuns } = input;

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

	if (sessionPctUsed !== null && sessionPctUsed >= 100) {
		return {
			ok: false,
			reason: `session budget is fully exhausted (${sessionPctUsed.toFixed(1)}%) — waiting for session window to reset`,
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

export interface SqueezeGateInput {
	/** Wall-clock time to evaluate against. */
	now: Date;
	/** The normal polling cadence (minutes) — the horizon squeeze mode measures against. */
	scheduleIntervalMinutes: number;
	/** % consumed so far in the shortest (session) usage window, 0-100. */
	sessionPct: number;
	/** ISO-8601 reset time for the session window. */
	sessionResetAt: string;
	/** Workspaces with at least one eligible backlog task right now. */
	eligibleWorkspaceCount: number;
}

/** Below this session-window usage, unused capacity is still worth squeezing. */
const SQUEEZE_SESSION_PCT_CEILING = 70;
/** Ask only when the session window resets within this many normal polling ticks. */
const SQUEEZE_TICK_HORIZON = 2;

/**
 * Pure pre-filter for squeeze mode (T-75): is it even worth the cost of an
 * LLM call to ask whether Auto Work should start another cycle right now
 * instead of waiting for the next scheduled tick? Only true when the
 * session usage window is close enough to reset that the normal cadence
 * risks leaving real unused capacity on the table — resetting within under
 * `SQUEEZE_TICK_HORIZON` ticks while still under `SQUEEZE_SESSION_PCT_CEILING`%
 * consumed — AND there is eligible backlog work to spend it on.
 */
export function shouldConsiderSqueeze(input: SqueezeGateInput): boolean {
	if (input.eligibleWorkspaceCount <= 0) return false;
	if (input.sessionPct >= SQUEEZE_SESSION_PCT_CEILING) return false;
	const minutesToReset = (Date.parse(input.sessionResetAt) - input.now.getTime()) / 60_000;
	if (!Number.isFinite(minutesToReset) || minutesToReset <= 0) return false;
	const intervalMinutes = Math.max(1, input.scheduleIntervalMinutes);
	return minutesToReset < intervalMinutes * SQUEEZE_TICK_HORIZON;
}

// ─── Orchestrator (IO) ──────────────────────────────────────────────────────

export interface RunAutoWorkCycleOptions {
	/**
	 * Sends a lifecycle/budget notification (T-67). Defaults to the real
	 * Telegram-backed `notify()` in `./notify.ts`. Injectable for tests so
	 * they can assert calls without a bot token or real Telegram API calls.
	 */
	notify?: (event: AutoWorkNotificationEvent) => Promise<void>;
	/** Injectable for tests — defaults to the real cached subscription-usage lookup. */
	getSubscriptionUsage?: () => Promise<{ available: boolean; weeklyPct?: number; sessionPct?: number }>;
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
	/**
	 * Global auto-work model — reused for task selection, squeeze timing, and
	 * branch-name slug generation (T-77). `null`/unset = bridge/server default.
	 */
	taskSelectionModel?: ModelRef | null;
	/**
	 * Injectable seam for the branch-name slug generator (T-77). Defaults to
	 * the real LLM-backed `generateBranchSlugWithModel`, which spends an
	 * extra `bridge.createSession` call. Tests inject a deterministic stub
	 * to skip that call and keep worktree/branch names predictable.
	 */
	generateBranchSlug?: (task: Task) => Promise<string>;
}

/** Candidate supplied to the optional cross-workspace task selector. */
export interface GlobalAutoWorkCandidate {
	workspaceCwd: string;
	task: Task;
	estimatedCostPct: number;
}

/** Injectable decision seam for tests or a future non-LLM policy. */
export type GlobalTaskSelector = (candidates: GlobalAutoWorkCandidate[]) => Promise<string | undefined>;

/** Options specific to global scheduling; extends the ordinary per-workspace cycle options. */
export interface RunGlobalAutoWorkCycleOptions extends RunAutoWorkCycleOptions {
	/** Test seam or alternate policy. Return a candidate task ID, or undefined to use priority order. */
	selectTask?: GlobalTaskSelector;
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
	const sessionPctUsed = usage.available && typeof usage.sessionPct === "number" ? usage.sessionPct : null;
	const resolveDeckBaseUrl = options.getDeckBaseUrl ?? (() => getServerDeckBaseUrl(loadConfig()).deckBaseUrl);
	const createPullRequest = options.createPullRequest ?? createPullRequestViaGh;
	const notify = options.notify ?? sendAutoWorkNotification;

	// Weekly-usage budget warning (T-67) — a softer heads-up than
	// `weeklyPctLimit`'s hard block, so it can fire even on a cycle that goes
	// on to select and start a task. Evaluated once per cycle, independent of
	// the preflight/selection outcome below; `notify()` itself dedupes to at
	// most once per calendar day.
	const weeklyThresholdHit = subscriptionPctUsed !== null && subscriptionPctUsed >= config.weeklyPctThreshold;
	if (subscriptionPctUsed !== null && weeklyThresholdHit) {
		await notify({ kind: "weekly_threshold", cwd, pctUsed: subscriptionPctUsed, thresholdPct: config.weeklyPctThreshold });
	}

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
			notify,
			usageLookup,
		});
		if (resumed) return resumed;
		activeRuns = activeRuns.filter((r) => r.id !== runningRun.id);
	}

	const preflight = checkAutoWorkPreflight({ config, now, subscriptionPctUsed, sessionPctUsed, activeRuns });
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
		// Session-limit notification (T-67) — only for the "considered but none
		// fit" case (a genuine budget-driven pause), and only when the weekly
		// threshold warning above didn't already fire this cycle: sending both
		// for the same skipped cycle would be redundant noise, so the weekly
		// warning takes precedence (it is the broader, workspace-wide signal).
		if (selection.kind === "none_fit" && !weeklyThresholdHit) {
			await notify({
				kind: "session_limit",
				sessionPctUsed: subscriptionPctUsed ?? 0,
				sessionPctLimit: config.sessionPctLimit,
			});
		}
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

	// Default here is the plain synchronous slug (no model call): this keeps
	// `runAutoWorkCycle`'s own unit tests fast and deterministic without a
	// second `bridge.createSession` call. `runGlobalAutoWorkCycle` — the real
	// production entry point — injects the LLM-backed generator by default.
	const branchSlug = options.generateBranchSlug ? await options.generateBranchSlug(task) : slugifyTaskTitle(task.title);
	const worktreePath = await createAutoWorkWorktree(cwd, task, branchSlug);

	const session = await bridge.createSession({
		cwd,
		suppressAutoStart: true,
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
	broadcastBus.broadcast({ type: "auto_work_runs_changed" });
	await notify({
		kind: "task_started",
		displayId: task.displayId,
		title: task.title,
		model: model ? `${model.provider}/${model.id}` : "default",
	});

	const prompt = `Trabaja en T-${task.displayId}: ${task.title}\n\n(contexto completo disponible via GET /api/tasks/${task.id})\n\nEl worktree para esta tarea ya está configurado en \`${worktreePath}\` (rama \`auto-work/t${task.displayId}-${branchSlug}\`). Usa ese directorio para todos los commits y cambios de fichero.`;
	const timeoutMinutes = resolveAutoWorkTimeoutMinutes(task.priority, config);
	return await finalizeAutoWorkRun({
		runId,
		task,
		session,
		worktreePath,
		timeoutMinutes,
		startTurn: () => session.prompt(prompt),
		resolveDeckBaseUrl,
		createPullRequest,
		notify,
		usageLookup,
		startPct: subscriptionPctUsed,
	});
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
function failAutoWorkRun(runId: string, taskId: string, failureReason: string): void {
	completeAutoWorkRun(runId, { status: "failed", failureReason });
	const backlogState = findStateByName("backlog");
	if (backlogState) moveTask(taskId, backlogState.id, 0);
	broadcastBus.broadcast({ type: "tasks_changed" });
	broadcastBus.broadcast({ type: "auto_work_runs_changed" });
}

function finalizeAutoWorkRun(params: {
	runId: string;
	task: Task;
	session: SessionHandle;
	worktreePath: string;
	timeoutMinutes: number;
	/** Starts the agent turn (e.g. `session.prompt(...)`) AFTER the terminal
	 *  listener is subscribed. Omitted when reattaching to an already-streaming
	 *  session (T-65 resume of a live turn). */
	startTurn?: () => Promise<unknown>;
	resolveDeckBaseUrl: () => string;
	createPullRequest: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
	notify: (event: AutoWorkNotificationEvent) => Promise<void>;
	/** T-80: used to compute pctConsumed delta after the run closes. */
	usageLookup: () => Promise<{ available: boolean; weeklyPct?: number }>;
	/** T-80: subscription weeklyPct at the moment the run started; null when unavailable. */
	startPct: number | null;
}): Promise<AutoWorkCycleResult> {
	activeRunIds.add(params.runId);
	return settleAutoWorkRun(params).finally(() => activeRunIds.delete(params.runId));
}

async function settleAutoWorkRun(params: {
	runId: string;
	task: Task;
	session: SessionHandle;
	worktreePath: string;
	timeoutMinutes: number;
	startTurn?: () => Promise<unknown>;
	resolveDeckBaseUrl: () => string;
	createPullRequest: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
	notify: (event: AutoWorkNotificationEvent) => Promise<void>;
	usageLookup: () => Promise<{ available: boolean; weeklyPct?: number }>;
	startPct: number | null;
}): Promise<AutoWorkCycleResult> {
	const { runId, task, session, worktreePath, timeoutMinutes, startTurn, resolveDeckBaseUrl, createPullRequest, notify, usageLookup, startPct } =
		params;
	const terminal = await waitForAutoWorkSessionTerminalResult(session, timeoutMinutes * 60_000, startTurn);

	// Capture real token usage for this run (T-80). Both calls run concurrently;
	// failures are logged and default to null — missing usage is never fatal.
	const [snapshotResult, endUsageResult] = await Promise.allSettled([
		Promise.resolve(session.snapshot()),
		usageLookup(),
	]);
	if (snapshotResult.status === "rejected")
		log.warn(`run ${runId}: snapshot() failed, tokens will be null`, snapshotResult.reason);
	if (endUsageResult.status === "rejected")
		log.warn(`run ${runId}: usageLookup() failed, pctConsumed will be null`, endUsageResult.reason);
	const usageRollup = snapshotResult.status === "fulfilled" ? snapshotResult.value.usageRollup : undefined;
	const inputTokens: number | null = usageRollup?.input ?? null;
	const outputTokens: number | null = usageRollup?.output ?? null;
	const endPct =
		endUsageResult.status === "fulfilled" &&
		endUsageResult.value.available &&
		typeof endUsageResult.value.weeklyPct === "number"
			? endUsageResult.value.weeklyPct
			: null;
	const pctConsumed: number | null = startPct !== null && endPct !== null ? endPct - startPct : null;

	if (terminal.outcome !== "completed") {
		const timedOut = terminal.outcome === "timed_out";
		const failureReason =
			terminal.outcome === "timed_out"
				? `exceeded ${timeoutMinutes}min timeout for priority ${task.priority}`
				: terminal.failureReason;
		if (timedOut) {
			// Abort the still-running session so reality matches the record —
			// otherwise the agent keeps working (and spending) after the run
			// was already written off, and may even finish the task.
			await session.abort().catch((err) => log.warn(`run ${runId}: abort after timeout failed`, err));
			completeAutoWorkRun(runId, { status: "timed_out", failureReason, inputTokens, outputTokens, pctConsumed });
			broadcastBus.broadcast({ type: "auto_work_runs_changed" });
		} else {
			// Inline failAutoWorkRun so we can pass captured token usage (T-80).
			completeAutoWorkRun(runId, { status: "failed", failureReason, inputTokens, outputTokens, pctConsumed });
			const backlogState = findStateByName("backlog");
			if (backlogState) moveTask(task.id, backlogState.id, 0);
			broadcastBus.broadcast({ type: "tasks_changed" });
			broadcastBus.broadcast({ type: "auto_work_runs_changed" });
		}
		const terminalState = findStateByName(timedOut ? "blocked" : "backlog");
		if (terminalState) moveTask(task.id, terminalState.id, 0);
		updateTask(task.id, {
			body: `${task.body}\n\n---\n**Auto Work ${timedOut ? "timeout" : "failed"}** — run \`${runId}\` ${failureReason}. Session: \`${session.sessionId}\`, worktree: \`${worktreePath}\`.`,
		});
		broadcastBus.broadcast({ type: "tasks_changed" });
		log.warn(`run ${runId} ${timedOut ? "timed out" : "failed"}; T-${task.displayId} moved to ${timedOut ? "blocked" : "backlog"} (${failureReason})`);
		await notify({ kind: "task_failed", displayId: task.displayId, reason: failureReason });
		if (timedOut) return { outcome: "timed_out", taskId: task.id, runId, sessionId: session.sessionId, worktreePath };
		return { outcome: "failed", taskId: task.id, runId, sessionId: session.sessionId, worktreePath, failureReason };
	}
	const deckBaseUrl = resolveDeckBaseUrl();
	const sessionUrl = buildSessionUrl(deckBaseUrl, session.sessionId);
	const shortSessionId = session.sessionId.slice(0, 8);

	let prNote: string;
	let prNumber: number | undefined;
	try {
		const pr = await createPullRequest({
			cwd: worktreePath,
			title: `feat: T-${task.displayId} ${task.title}`,
			body: `Auto Work completed T-${task.displayId}: ${task.title}\n\nSession: ${sessionUrl}`,
		});
		prNote = `PR #${pr.number}`;
		prNumber = pr.number;
		log.info(`run ${runId}: opened PR #${pr.number} (${pr.url}) for T-${task.displayId}`);
	} catch (err) {
		const errMsg = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim().slice(0, 120);
		prNote = `PR creation failed — open manually (${errMsg})`;
		log.error(`run ${runId}: gh pr create failed for T-${task.displayId}`, err);
	}

	updateTask(task.id, {
		body: `${task.body}\n\n---\n**Auto Work** — [session ${shortSessionId}](${sessionUrl}) · ${prNote}`,
	});

	const validateState = findStateByName("validate");
	if (validateState) moveTask(task.id, validateState.id, 0);
	else log.error(`run ${runId}: "validate" task state not found — T-${task.displayId} left in its current state`);

	completeAutoWorkRun(runId, { status: "completed", inputTokens, outputTokens, pctConsumed });
	broadcastBus.broadcast({ type: "tasks_changed" });
	broadcastBus.broadcast({ type: "auto_work_runs_changed" });
	log.info(`run ${runId} completed for T-${task.displayId} — moved to validate`);
	// Only announces completion once a PR actually exists — a fallback
	// "open manually" note (PR creation failure, above) isn't a state the
	// user needs paged about; it's already surfaced loudly in the task body
	// and the logs.
	if (prNumber !== undefined) {
		await notify({ kind: "task_completed", displayId: task.displayId, prNumber });
	}
	return { outcome: "completed", taskId: task.id, runId, sessionId: session.sessionId, worktreePath };
}

/**
 * Retires persisted runs whose session is truly gone. The monitor calls this
 * before displaying history, so a killed session cannot look live forever.
 * A short grace avoids racing a just-created session before its first turn
 * starts. A run whose session still exists as a persisted `.jsonl` is left
 * alone — it is resumable, and the scheduler's next cycle owns picking it up
 * (`resumeOrRetireAutoWorkRun`); failing it here would race that resume, which
 * is exactly how completed runs used to end up `failed: session_not_running`.
 */
export async function reconcileInactiveAutoWorkRuns(bridge: AgentBridge, now = Date.now()): Promise<number> {
	let reconciled = 0;
	for (const run of listAutoWorkRuns({ status: "running" })) {
		if (activeRunIds.has(run.id) || now - Date.parse(run.startedAt) < STALE_RUN_GRACE_MS) continue;
		const handle = bridge.getSession(run.sessionId);
		if (handle && (await handle.isStreamingNow())) continue;
		if (await findPersistedAutoWorkSession(bridge, run)) continue;
		failAutoWorkRun(run.id, run.taskId, "session_not_running");
		log.warn(`run ${run.id} (session ${run.sessionId}) is no longer running; moved task back to backlog`);
		reconciled += 1;
	}
	return reconciled;
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
		notify: (event: AutoWorkNotificationEvent) => Promise<void>;
		usageLookup: () => Promise<{ available: boolean; weeklyPct?: number }>;
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
		broadcastBus.broadcast({ type: "auto_work_runs_changed" });
		const backlogState = findStateByName("backlog");
		if (backlogState) moveTask(run.taskId, backlogState.id, 0);
		await removeAutoWorkWorktree(cwd, run.worktreePath);
		return undefined;
	}

	const task = getTask(run.taskId);
	if (!task) {
		log.warn(`run ${run.id}: task ${run.taskId} no longer exists — closing the run as failed`);
		completeAutoWorkRun(run.id, { status: "failed", failureReason: "session_lost" });
		broadcastBus.broadcast({ type: "auto_work_runs_changed" });
		await removeAutoWorkWorktree(cwd, run.worktreePath);
		return undefined;
	}

	log.info(
		`${classification === "resume" ? "resuming" : "reconnecting to"} run ${run.id} for T-${task.displayId}, ` +
			`session ${run.sessionId}${worktreeExists ? "" : " (worktree missing)"}`,
	);

	// A resumed handle whose turn died with the previous server process is
	// idle: no event will ever arrive, so waiting alone would always end in a
	// bogus timeout. Kick it with a continuation prompt; if the work was in
	// fact already finished, the agent verifies and ends the turn quickly.
	const streaming = await handle.isStreamingNow();
	const continuationPrompt =
		`La sesión de Auto Work para T-${task.displayId} ("${task.title}") se interrumpió (reinicio del servidor). ` +
		`Continúa el trabajo en el worktree \`${run.worktreePath}\`. Si la tarea ya estaba terminada, verifica el estado (commits, tests) y concluye. ` +
		`(contexto completo via GET /api/tasks/${task.id})`;
	const timeoutMinutes = resolveAutoWorkTimeoutMinutes(run.taskPriority, config);
	return finalizeAutoWorkRun({
		runId: run.id,
		task,
		session: handle,
		worktreePath: run.worktreePath,
		timeoutMinutes,
		...(streaming ? {} : { startTurn: () => handle.prompt(continuationPrompt) }),
		resolveDeckBaseUrl: completion.resolveDeckBaseUrl,
		createPullRequest: completion.createPullRequest,
		notify: completion.notify,
		usageLookup: completion.usageLookup,
		startPct: null, // resumed run: no meaningful pre-session baseline available
	});
}

type AutoWorkTerminalResult =
	| { outcome: "completed" }
	| { outcome: "failed"; failureReason: string }
	| { outcome: "timed_out" };

function terminalOutcomeFromEvent(event: unknown): AutoWorkTerminalResult | undefined {
	if (!event || typeof event !== "object" || !("type" in event)) return undefined;
	if (event.type !== "turn_end" && event.type !== "agent_end") return undefined;

	const nestedMessage = "message" in event && event.message && typeof event.message === "object" ? event.message : undefined;
	const directStopReason = "stopReason" in event && typeof event.stopReason === "string" ? event.stopReason : undefined;
	const nestedStopReason =
		nestedMessage && "stopReason" in nestedMessage && typeof nestedMessage.stopReason === "string"
			? nestedMessage.stopReason
			: undefined;
	const stopReason = directStopReason ?? nestedStopReason;
	if (!stopReason) return { outcome: "failed", failureReason: "agent turn ended without a stop reason" };
	if (stopReason === "end_turn" || stopReason === "stop") return { outcome: "completed" };
	return { outcome: "failed", failureReason: `agent turn ended with stop reason: ${stopReason}` };
}

/**
 * Wait for a terminal event while retaining the exact failure condition for
 * the run record. A resolved prompt alone is not evidence of completion: the
 * T-83 session stopped mid-tool-call after exhausting its execution budget,
 * resolved its prompt, and was incorrectly marked completed.
 */
function waitForAutoWorkSessionTerminalResult(
	handle: SessionHandle,
	timeoutMs: number,
	startTurn?: () => Promise<unknown>,
): Promise<AutoWorkTerminalResult> {
	const { promise, resolve } = Promise.withResolvers<AutoWorkTerminalResult>();
	let settled = false;
	let unsubscribe: (() => void) | undefined;
	const finish = (result: AutoWorkTerminalResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe?.();
		resolve(result);
	};
	const timer = setTimeout(() => finish({ outcome: "timed_out" }), timeoutMs);
	// Bun timers expose `unref`, unlike browser numeric timer ids.
	const unrefTimer = timer as typeof timer & { unref?: () => void };
	unrefTimer.unref?.();
	unsubscribe = handle.subscribe((event) => {
		const result = terminalOutcomeFromEvent(event);
		if (result) finish(result);
	});
	if (startTurn) {
		startTurn().then(
			// Defer one tick so a terminal event emitted just before the prompt
			// promise settles (it carries the precise stopReason) wins the race.
			() => setTimeout(() => finish({ outcome: "failed", failureReason: "agent turn ended without a terminal event" }), 0),
			(err) => {
				log.warn("auto-work turn prompt failed", err);
				const message = err instanceof Error ? err.message : String(err);
				setTimeout(() => finish({ outcome: "failed", failureReason: `agent prompt failed: ${message}` }), 0);
			},
		);
	}
	return promise;
}

/**
 * Waits for the terminal result used by the pre-existing decision helpers.
 * The detailed variant above is reserved for run persistence, which needs the
 * original reason rather than the coarse status.
 */
export async function waitForAutoWorkSessionTerminal(
	handle: SessionHandle,
	timeoutMs: number,
	startTurn?: () => Promise<unknown>,
): Promise<AutoWorkTerminalResult["outcome"]> {
	return (await waitForAutoWorkSessionTerminalResult(handle, timeoutMs, startTurn)).outcome;
}

/**
 * `git worktree add -b auto-work/T<displayId>-<slug> .worktrees/aw-T<displayId>-<slug>
 * origin/<default-branch>`, run from `repoCwd`. The start-point is the remote
 * default branch (resolved via `git ls-remote --symref origin HEAD`), never the
 * currently checked-out branch in the main worktree — ensures all auto-work
 * branches share the same clean base regardless of what the developer has
 * checked out locally, preventing squash-merge conflicts between independent tasks.
 */
async function createAutoWorkWorktree(repoCwd: string, task: Task, slug: string): Promise<string> {
	const dirName = `aw-T${task.displayId}-${slug}`;
	const worktreePath = path.join(repoCwd, ".worktrees", dirName);
	const branch = `auto-work/t${task.displayId}-${slug}`;

	// Reuse an existing registered worktree rather than failing with exit 255
	// when a previous run left the branch/path in place (retry or crashed session).
	const existing = await findExistingWorktreePath(repoCwd, worktreePath);
	if (existing) {
		log.info(`reusing existing worktree at ${worktreePath} (branch ${branch})`);
		return existing;
	}

	const defaultBranch = await resolveDefaultBranch(repoCwd);

	const proc = Bun.spawn(["git", "worktree", "add", "-b", branch, worktreePath, `origin/${defaultBranch}`], {
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

/**
 * Returns `worktreePath` when it is already registered in `git worktree list`,
 * otherwise returns `undefined`. Used by `createAutoWorkWorktree` to detect
 * a leftover worktree from a previous (possibly crashed) run so it can be
 * reused instead of calling `git worktree add` again (which would fail with
 * exit 255 if the branch or directory already exists).
 */
async function findExistingWorktreePath(repoCwd: string, worktreePath: string): Promise<string | undefined> {
	if (!fs.existsSync(worktreePath)) return undefined;
	const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
		cwd: repoCwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return undefined;
	// Each entry starts with "worktree <path>\n"; entries separated by blank lines.
	return stdout.split("\n").some((line) => line === `worktree ${worktreePath}`) ? worktreePath : undefined;
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
 * Ask a short-lived agent session — the global `taskSelectionModel` reused
 * across every internal auto-work decision (T-77) — for a short English
 * kebab-case branch-name slug. The session's system prompt is entirely
 * replaced by `kb/rules/branch-naming.md`'s content (`systemPromptOverride`)
 * instead of the normal `kb/system` prelude, so this stays a narrow, cheap
 * call that runs on every cycle. Any model/session failure or unusable
 * response falls back to `slugifyTaskTitle(task.title)` — the exact naive
 * slug the engine always produced before this existed, so a misconfigured
 * or unreachable model degrades to the old behavior instead of blocking
 * the cycle.
 */
export async function generateBranchSlugWithModel(
	bridge: AgentBridge,
	cwd: string,
	task: Task,
	model: ModelRef | null,
): Promise<string> {
	const fallback = () => slugifyTaskTitle(task.title);
	const prompt = [`Task: T-${task.displayId} — ${task.title}`, "Reply with ONLY the slug, nothing else."].join("\n");

	let session: SessionHandle | undefined;
	try {
		const rulesPath = path.join(resolveKbRoot(), "rules", "branch-naming.md");
		let rules: string;
		try {
			rules = fs.readFileSync(rulesPath, "utf8");
		} catch {
			rules = BRANCH_NAMING_RULES_BODY;
		}
		session = await bridge.createSession({
			cwd,
			suppressAutoStart: true,
			systemPromptOverride: rules,
			...(model ? { model } : {}),
		});
		const s = session;
		const outcome = await waitForAutoWorkSessionTerminal(s, 20_000, () => s.prompt(prompt));
		if (outcome !== "completed") {
			log.warn(`branch slug generation timed out for T-${task.displayId}; using deterministic fallback`);
			return fallback();
		}
		const response = latestAssistantText((await session.snapshot()).messages);
		const slug = sanitizeBranchSlug(response);
		return slug || fallback();
	} catch (err) {
		log.warn(`branch slug generation failed for T-${task.displayId}; using deterministic fallback`, err);
		return fallback();
	} finally {
		if (session) {
			try {
				await bridge.deleteSession(session.sessionId);
			} catch (err) {
				log.warn("branch slug generation cleanup failed", err);
			}
		}
	}
}

/** Lowercase kebab-case ASCII, first line only, capped at 40 chars. */
export function sanitizeBranchSlug(text: string): string {
	const firstLine = text.trim().split("\n")[0] ?? "";
	return firstLine
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
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
	if (match) {
		if (!match.isAvailable) return `no auth configured for ${ref.provider}/${ref.id}`;
		return undefined;
	}
	const shadowed = getModelCatalogOverlay()
		.listShadowed()
		.some((s) => s.provider === ref.provider && s.id === ref.id);
	if (shadowed) {
		return `unavailable: ${ref.provider}/${ref.id} (shadowed by catalog overlay)`;
	}
	return `unknown model: ${ref.provider}/${ref.id}`;
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

/**
 * Resolves the remote default branch for `repoCwd` by parsing
 * `git ls-remote --symref origin HEAD`. Falls back to `"main"` if the
 * command fails or the symref is absent (shallow clones, custom remotes).
 * No dependency on `gh` or any GitHub API.
 *
 * Example output:
 *   ref: refs/heads/main\tHEAD
 *   <sha>\tHEAD
 */
async function resolveDefaultBranch(repoCwd: string): Promise<string> {
	const proc = Bun.spawn(["git", "ls-remote", "--symref", "origin", "HEAD"], {
		cwd: repoCwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return "main";
	for (const line of stdout.split("\n")) {
		const m = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
		if (m?.[1]) return m[1];
	}
	return "main";
}

/**
 * `gh pr create --base <default-branch> --title <title> --body <body>`, run
 * from the worktree directory so `gh` infers the PR head from the branch
 * already checked out there (see `createAutoWorkWorktree`). Follows the same
 * `Bun.spawn` convention as `createAutoWorkWorktree`/`removeAutoWorkWorktree`
 * rather than `node:child_process`. Parses the PR number out of the URL
 * `gh pr create` prints on stdout (e.g. `https://github.com/o/r/pull/123`).
 * The base branch is resolved dynamically from the remote rather than
 * hardcoded, so repos whose default branch is not `main` work correctly.
 */
export async function createPullRequestViaGh(params: CreatePullRequestParams): Promise<CreatePullRequestResult> {
	const baseBranch = await resolveDefaultBranch(params.cwd);
	const proc = Bun.spawn(
		["gh", "pr", "create", "--base", baseBranch, "--title", params.title, "--body", params.body],
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


// ─── Global cycle (multi-workspace) ─────────────────────────────────────────

/**
 * How many auto-work–enabled workspaces currently have at least one eligible
 * task (autoWork flag, backlog state, dependencies met). Used by the
 * schedule-status endpoint so the UI can show whether there's work to do.
 * Pure DB read — does NOT run preflight, budget, or mutex checks.
 */
export function countEligibleWorkspaces(): number {
	const allTasks = listTasks();
	const backlogState = findStateByName("backlog");
	const doneState = findStateByName("done");
	if (!backlogState || !doneState) return 0;

	const tasksByCwd = new Map<string, Task[]>();
	for (const t of allTasks) {
		if (!t.cwd) continue;
		const list = tasksByCwd.get(t.cwd) ?? [];
		list.push(t);
		tasksByCwd.set(t.cwd, list);
	}

	const tasksById = new Map(allTasks.map((t) => [t.id, t]));
	let count = 0;
	for (const [cwd, cwdTasks] of tasksByCwd) {
		const config = getAutoWorkConfig(cwd);
		if (!config.enabled) continue;
		const hasEligible = cwdTasks.some(
			(t) =>
				t.autoWork &&
				t.stateId === backlogState.id &&
				t.dependsOn.every((depId) => tasksById.get(depId)?.stateId === doneState.id),
		);
		if (hasEligible) count++;
	}
	return count;
}

/**
 * Global auto-work cycle: selects the highest-priority eligible task across
 * ALL enabled workspaces and runs it. Called by the global scheduler and the
 * manual trigger endpoint.
 *
 * Algorithm (priority-based, LLM selection deferred to a future iteration):
 * 1. Fetch subscription usage once (shared across workspace checks).
 * 2. For each workspace with `enabled: true`, run preflight + task selection.
 * 3. Collect all candidates (workspace, task, estimatedCostPct).
 * 4. Pick the candidate whose task has the highest priority (lowest PRIORITY_ORDER).
 * 5. Run `runAutoWorkCycle` for the winning workspace, passing the already-
 *    fetched subscription usage so it isn't re-fetched.
 *
 * Returns `{ outcome: "skipped" }` when no workspace passes preflight or no
 * task fits the budget. Returns the inner `AutoWorkCycleResult` otherwise.
 */
export async function runGlobalAutoWorkCycle(
	bridge: AgentBridge,
	options: RunGlobalAutoWorkCycleOptions = {},
): Promise<AutoWorkCycleResult> {
	const now = (options.now ?? (() => new Date()))();
	const usageLookup = options.getSubscriptionUsage ?? (() => getSubscriptionUsage());
	const usage = await usageLookup();
	const subscriptionPctUsed = usage.available && typeof usage.weeklyPct === "number" ? usage.weeklyPct : null;
	const sessionPctUsed = usage.available && typeof usage.sessionPct === "number" ? usage.sessionPct : null;

	const allTasks = listTasks();
	const backlogState = findStateByName("backlog");
	const doneState = findStateByName("done");
	if (!backlogState || !doneState) {
		return { outcome: "skipped", reason: "backlog/done task states missing — cannot run auto-work" };
	}

	// Global Auto Work is deliberately sequential. A running row anywhere is
	// enough to defer this cycle, rather than starting work in another workspace.
	if (listAutoWorkRuns({ status: "running" }).length > 0) {
		return { outcome: "skipped", reason: "another auto-work run is already active" };
	}

	// Collect distinct enabled cwds from all auto-work–flagged tasks.
	const enabledCwds = new Set<string>();
	for (const t of allTasks) {
		if (!t.autoWork || !t.cwd) continue;
		const config = getAutoWorkConfig(t.cwd);
		if (config.enabled) enabledCwds.add(t.cwd);
	}

	if (enabledCwds.size === 0) {
		return { outcome: "skipped", reason: "no workspace has auto-work enabled" };
	}

	// Per-workspace: preflight + task selection.
	const tasksById = new Map(allTasks.map((t) => [t.id, t]));

	const candidates: GlobalAutoWorkCandidate[] = [];

	for (const cwd of enabledCwds) {
		const config = getAutoWorkConfig(cwd);
		const activeRuns = listAutoWorkRuns({ status: "running" }).filter((r) => {
			const task = tasksById.get(r.taskId);
			return task?.cwd === cwd;
		});
		const preflight = checkAutoWorkPreflight({ config, now, subscriptionPctUsed, sessionPctUsed, activeRuns });
		if (!preflight.ok) {
			log.debug(`global cycle: ${cwd} skipped (${preflight.reason})`);
			continue;
		}
		const cwdTasks = allTasks.filter((t) => t.cwd === cwd);
		const selection = selectNextAutoWorkTask({
			tasks: cwdTasks,
			config,
			currentPctUsed: subscriptionPctUsed ?? 0,
			backlogStateId: backlogState.id,
			doneStateId: doneState.id,
			estimateCostPct: (priority) => estimateTaskCostPct(priority, config),
		});
		if (selection.kind === "selected") {
			candidates.push({ workspaceCwd: cwd, task: selection.task, estimatedCostPct: selection.estimatedCostPct });
		}
	}

	if (candidates.length === 0) {
		return { outcome: "skipped", reason: "no eligible task fits the current budget across all workspaces" };
	}

	// Priority remains the deterministic fallback. A selector only runs after
	// candidates exist, so the system never spends a model request on an empty queue.
	candidates.sort(
		(a, b) =>
			PRIORITY_ORDER[a.task.priority] - PRIORITY_ORDER[b.task.priority] ||
			a.task.orderInState - b.task.orderInState,
	);
	const selectedTaskId = options.selectTask
		? await options.selectTask(candidates)
		: await selectTaskWithModel(bridge, candidates, options.taskSelectionModel ?? null);
	const winner = candidates.find((candidate) => candidate.task.id === selectedTaskId) ?? candidates[0]!;
	log.info(
		`global cycle: selected T-${winner.task.displayId} "${winner.task.title}" (${winner.task.priority}) in ${winner.workspaceCwd}`,
	);

	// Run the cycle for the winning workspace, sharing the already-fetched usage.
	// This is the production entry point (scheduler + manual trigger), so unless
	// a caller already injected its own `generateBranchSlug` (e.g. a test), wire
	// in the real LLM-backed generator using the same global model.
	const cachedUsage = usage;
	return runAutoWorkCycle(winner.workspaceCwd, bridge, {
		...options,
		now: () => now,
		getSubscriptionUsage: () => Promise.resolve(cachedUsage),
		generateBranchSlug:
			options.generateBranchSlug ??
			((task) => generateBranchSlugWithModel(bridge, winner.workspaceCwd, task, options.taskSelectionModel ?? null)),
	});
}

/**
 * Ask a short-lived agent session to select one candidate task. The prompt
 * contains no task bodies or repository content, only the fields needed for
 * prioritization. The response must be one candidate task ID. Any malformed
 * response or model/session error returns undefined so priority order wins.
 */
async function selectTaskWithModel(
	bridge: AgentBridge,
	candidates: GlobalAutoWorkCandidate[],
	model: ModelRef | null,
): Promise<string | undefined> {
	const candidateList = candidates
		.map((candidate) =>
			[
				`id=${candidate.task.id}`,
				`display=T-${candidate.task.displayId}`,
				`priority=${candidate.task.priority}`,
				`workspace=${candidate.workspaceCwd}`,
				`estimatePct=${candidate.estimatedCostPct.toFixed(1)}`,
				`title=${JSON.stringify(candidate.task.title)}`,
			].join(" | "),
		)
		.join("\n");
	const prompt = [
		"Choose exactly one task ID from the candidate list for the next unattended engineering run.",
		"Prioritize urgency, small safe high-value work, and avoiding risky broad changes.",
		"Return ONLY the exact id= value, with no prose, punctuation, or markdown.",
		"Candidates:",
		candidateList,
	].join("\n");

	let session: SessionHandle | undefined;
	try {
		session = await bridge.createSession({
			cwd: candidates[0]!.workspaceCwd,
			suppressAutoStart: true,
			...(model ? { model } : {}),
		});
		const s = session;
		const outcome = await waitForAutoWorkSessionTerminal(s, 30_000, () => s.prompt(prompt));
		if (outcome !== "completed") {
			log.warn("global task selector timed out; using priority order");
			return undefined;
		}
		const response = latestAssistantText((await session.snapshot()).messages);
		const match = candidates.find((candidate) => response.trim() === candidate.task.id);
		if (!match) {
			log.warn(`global task selector returned an invalid task ID; using priority order`);
			return undefined;
		}
		return match.task.id;
	} catch (err) {
		log.warn("global task selector failed; using priority order", err);
		return undefined;
	} finally {
		if (session) {
			try {
				await bridge.deleteSession(session.sessionId);
			} catch (err) {
				log.warn("global task selector cleanup failed", err);
			}
		}
	}
}


export interface SqueezeDecisionInput {
	/** Any enabled workspace's cwd — only hosts the ephemeral decision session, no repo content is sent. */
	workspaceCwd: string;
	sessionPct: number;
	sessionResetAt: string;
	weeklyPct: number;
	weeklyResetAt: string;
	eligibleWorkspaceCount: number;
	scheduleIntervalMinutes: number;
}

/**
 * Ask a short-lived agent session — the global `taskSelectionModel` ("the
 * model assigned for decision-making") — whether Auto Work should start
 * another cycle immediately instead of waiting for the next scheduled tick
 * (T-75 "squeeze" mode). Only called after `shouldConsiderSqueeze` already
 * confirmed real unused-capacity risk; the model makes the nuanced call the
 * pure heuristic can't (how much runway is realistically left, whether it's
 * worth starting a task that might not finish before the window resets
 * anyway). Any model/session failure or ambiguous response defaults to
 * `false` — squeeze mode only ever shortens idle time between scheduled
 * cycles, it never forces work the normal cadence wouldn't otherwise reach.
 */
export async function decideSqueezeTiming(
	bridge: AgentBridge,
	input: SqueezeDecisionInput,
	model: ModelRef | null,
): Promise<boolean> {
	const prompt = [
		"Auto Work just finished a cycle. Decide whether to start the next eligible task right now,",
		"instead of waiting for the next scheduled poll, so unused subscription capacity isn't wasted",
		"when the usage window resets.",
		`Session usage window: ${input.sessionPct.toFixed(1)}% used, resets at ${input.sessionResetAt}.`,
		`Weekly usage window: ${input.weeklyPct.toFixed(1)}% used, resets at ${input.weeklyResetAt}.`,
		`Normal poll interval: ${input.scheduleIntervalMinutes} minute(s).`,
		`Workspaces with eligible backlog work right now: ${input.eligibleWorkspaceCount}.`,
		"Reply with exactly one word: YES to start another task now, or NO to wait for the next scheduled poll.",
	].join("\n");

	let session: SessionHandle | undefined;
	try {
		session = await bridge.createSession({
			cwd: input.workspaceCwd,
			suppressAutoStart: true,
			...(model ? { model } : {}),
		});
		const s = session;
		const outcome = await waitForAutoWorkSessionTerminal(s, 30_000, () => s.prompt(prompt));
		if (outcome !== "completed") {
			log.warn("squeeze timing decision timed out; deferring to the next scheduled tick");
			return false;
		}
		const response = latestAssistantText((await session.snapshot()).messages).trim().toUpperCase();
		if (response.startsWith("YES")) return true;
		if (response.startsWith("NO")) return false;
		log.warn(`squeeze timing decision returned an unexpected response ${JSON.stringify(response)}; deferring`);
		return false;
	} catch (err) {
		log.warn("squeeze timing decision failed; deferring to the next scheduled tick", err);
		return false;
	} finally {
		if (session) {
			try {
				await bridge.deleteSession(session.sessionId);
			} catch (err) {
				log.warn("squeeze timing decision cleanup failed", err);
			}
		}
	}
}

/** Extract text from the most recent assistant message without unchecked casts. */
export function latestAssistantText(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) continue;
		const text = message.content.flatMap((block) => {
			if (
				block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) return [block.text];
			return [];
		}).join("");
		if (text) return text;
	}
	return "";
}