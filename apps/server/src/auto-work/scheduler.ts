/**
 * Global Auto Work scheduler — one `setInterval` for the whole server.
 * Reads `AutoWorkGlobalConfig` (`schedule_enabled`, `schedule_interval_minutes`)
 * and fires `runGlobalAutoWorkCycle` on each tick, which itself iterates all
 * enabled workspaces and picks the best task to run.
 *
 * State (lastTriggeredAt, lastOutcome) is in-process memory only.
 * Call `initScheduler` at server boot and `disposeScheduler` on shutdown.
 * Call `updateGlobalSchedule` whenever the global config changes.
 */

import type { AutoWorkCycleResult, AutoWorkGlobalConfig, AutoWorkScheduleStatus } from "@omp-deck/protocol";

import type { AgentBridge } from "../bridge/types.ts";
import { getAutoWorkGlobalConfig } from "../db/auto-work-global.ts";
import { broadcastBus } from "../broadcast-bus.ts";
import { runGlobalAutoWorkCycle, countEligibleWorkspaces } from "./engine.ts";
import type { RunAutoWorkCycleOptions } from "./engine.ts";
import { logger } from "../log.ts";

const log = logger("auto-work:scheduler");

// ─── In-process state ────────────────────────────────────────────────────────

/** Mutable state shared between scheduler ticks and the status endpoint. */
export interface GlobalScheduleState {
	lastTriggeredAt: string | null;
	lastOutcome: AutoWorkCycleResult | null;
}

interface InternalState extends GlobalScheduleState {
	timer: NodeJS.Timeout | null;
}

// Single instance — the scheduler is a process singleton.
const state: InternalState = { timer: null, lastTriggeredAt: null, lastOutcome: null };

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the current global schedule status for the REST endpoint.
 * Reads the global config for `scheduleEnabled`, `scheduleIntervalMinutes`,
 * and `taskSelectionModel`; the rest comes from in-process state.
 */
export function getScheduleStatus(): AutoWorkScheduleStatus {
	const config = getAutoWorkGlobalConfig();
	return {
		scheduleEnabled: config.scheduleEnabled,
		scheduleIntervalMinutes: config.scheduleIntervalMinutes,
		taskSelectionModel: config.taskSelectionModel,
		lastTriggeredAt: state.lastTriggeredAt,
		lastOutcome: state.lastOutcome,
		eligibleWorkspaceCount: countEligibleWorkspaces(),
	};
}

/**
 * Start, restart, or stop the global polling timer based on the config.
 * Safe to call repeatedly — always clears the previous timer first.
 */
export function updateGlobalSchedule(
	config: AutoWorkGlobalConfig,
	bridge: AgentBridge,
	cycleOptions: RunAutoWorkCycleOptions = {},
): void {
	if (state.timer !== null) {
		clearInterval(state.timer);
		state.timer = null;
	}

	if (!config.scheduleEnabled) {
		log.info(`global schedule disabled`);
		return;
	}

	const intervalMs = Math.max(1, config.scheduleIntervalMinutes) * 60_000;
	log.info(`global schedule: every ${config.scheduleIntervalMinutes} min`);
	const tick = (): void => {
		state.lastTriggeredAt = new Date().toISOString();
		runGlobalAutoWorkCycle(bridge, { ...cycleOptions, taskSelectionModel: config.taskSelectionModel })
			.then((outcome) => {
				state.lastOutcome = outcome;
			})
			.catch((err: unknown) => {
				log.error(`scheduled global cycle error`, err);
				state.lastOutcome = { outcome: "skipped", reason: String(err) };
			})
			.finally(() => {
				broadcastBus.broadcast({ type: "auto_work_runs_changed" });
			});
	};

	state.timer = setInterval(tick, intervalMs);
}

/**
 * Called once at server boot — reads the persisted global config and starts
 * the timer if `scheduleEnabled` is true.
 */
export function initScheduler(bridge: AgentBridge, cycleOptions: RunAutoWorkCycleOptions = {}): void {
	const config = getAutoWorkGlobalConfig();
	if (!config.scheduleEnabled) {
		log.info(`no global schedule at boot (disabled)`);
		return;
	}
	log.info(`restoring global schedule from boot`);
	updateGlobalSchedule(config, bridge, cycleOptions);
}

/** Clears the timer — call in the server's shutdown handler. */
export function disposeScheduler(): void {
	if (state.timer !== null) {
		clearInterval(state.timer);
		state.timer = null;
		log.info(`global schedule cleared`);
	}
}

/**
 * Records a manual trigger (called by the POST /auto-work/trigger route)
 * so `lastTriggeredAt`/`lastOutcome` stay in sync with manual runs too.
 */
export function recordManualTrigger(outcome: AutoWorkCycleResult): void {
	state.lastTriggeredAt = new Date().toISOString();
	state.lastOutcome = outcome;
}
