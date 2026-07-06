/**
 * Task cost estimation (T-63) — how much of the current session/weekly
 * budget a given priority's auto-work run is expected to consume, before
 * the engine (T-64) decides whether to start it.
 *
 * This module does not decide anything by itself: it only produces a
 * number. The engine is the one that compares `estimateTaskCostPct(...)`
 * against `remainingPct - config.sessionPctLimit` and skips/defers tasks
 * accordingly — see the T-63 ticket's "Engine decision" section, out of
 * scope here.
 *
 * Estimation strategy:
 *  1. Look at the rolling average `pctConsumed` of the last N completed
 *     runs at this priority (`getAutoWorkCostEstimate`, T-62).
 *  2. If no history exists yet (`sampleSize === 0`), fall back to the
 *     workspace's configured default for that priority
 *     (`config.defaultEstimatePctByPriority`).
 *  3. Apply `config.estimationBuffer` as headroom (e.g. 1.3 = 30%) since
 *     both the historical average and the static default are point
 *     estimates, not worst-case bounds.
 */

import type { AutoWorkConfig, TaskPriority } from "@omp-deck/protocol";

import { getAutoWorkCostEstimate } from "../db/auto-work-runs.ts";
import { logger } from "../log.ts";

const log = logger("auto-work:estimate");

/**
 * Estimated % of a session budget that an auto-work run at `priority` will
 * consume, including the configured safety buffer. Synchronous — reads
 * directly from SQLite via `getAutoWorkCostEstimate` (same process, no HTTP
 * round-trip to the `/api/auto-work/cost-estimate` route it backs).
 */
export function estimateTaskCostPct(priority: TaskPriority, config: AutoWorkConfig): number {
	const { avgPctConsumed, sampleSize } = getAutoWorkCostEstimate(priority);

	const basePct = sampleSize > 0 && avgPctConsumed !== null ? avgPctConsumed : config.defaultEstimatePctByPriority[priority];
	const source = sampleSize > 0 && avgPctConsumed !== null ? "history" : "default";

	const estimate = basePct * config.estimationBuffer;

	log.debug(
		`estimate priority=${priority} source=${source} sampleSize=${sampleSize} base=${basePct} buffer=${config.estimationBuffer} estimate=${estimate}`,
	);

	return estimate;
}
