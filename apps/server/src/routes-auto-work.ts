/**
 * Auto Work REST surface (T-60/T-62). Mounted on the main router at
 * `/api/auto-work/*`.
 *
 * - `GET /auto-work/config?cwd=<path>` — per-workspace Auto Work
 *   configuration; returns computed defaults when unconfigured (see
 *   `db/auto-work.ts`).
 * - `PUT /auto-work/config?cwd=<path>` — replaces the full configuration.
 *   All fields are required and validated server-side (400 on bad input).
 * - `GET /auto-work/runs?limit=&taskId=&priority=&status=` — run history
 *   (see `db/auto-work-runs.ts`). Recording runs (open on start, close on
 *   finish) is the DB layer's `startAutoWorkRun`/`completeAutoWorkRun` —
 *   the engine that calls them at the right lifecycle moments is T-64.
 * - `GET /auto-work/cost-estimate?priority=` — rolling average
 *   `pctConsumed` over the last 10 completed runs at that priority.
 *
 * This file is the shared home for the whole Auto Work settings surface —
 * later tickets (T-63 scheduler, T-64 execution, T-66/67 reporting) extend
 * `buildAutoWorkRouter` with more routes rather than spawning parallel
 * files. Keep additions as more `app.<verb>(...)` calls plus small private
 * helpers below, matching this repo's router-per-file convention (see
 * `routes-usage.ts`, `routes-tasks.ts`).
 */

import * as path from "node:path";
import { Hono } from "hono";
import type {
	AutoWorkConfig,
	AutoWorkCostEstimateResponse,
	AutoWorkRunStatus,
	ListAutoWorkRunsResponse,
	ModelRef,
	SetAutoWorkConfigRequest,
	TaskPriority,
} from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { getAutoWorkConfig, setAutoWorkConfig } from "./db/auto-work.ts";
import { getAutoWorkCostEstimate, listAutoWorkRuns } from "./db/auto-work-runs.ts";
import { logger } from "./log.ts";

const log = logger("routes:auto-work");

const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4", "P5"];
const RUN_STATUSES: AutoWorkRunStatus[] = ["running", "completed", "failed", "timed_out"];

export function buildAutoWorkRouter(bridge: AgentBridge): Hono {
	const app = new Hono();

	app.get("/auto-work/config", (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		// No existence check: the cwd is a pure DB key. Workspaces may be on
		// NFS or otherwise temporarily inaccessible — their config must still
		// be readable/writable regardless.
		const config: AutoWorkConfig = getAutoWorkConfig(cwd);
		return c.json(config);
	});

	app.put("/auto-work/config", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!path.isAbsolute(cwd)) {
			return c.json({ error: "cwd must be an absolute path" }, 400);
		}

		let body: SetAutoWorkConfigRequest;
		try {
			body = (await c.req.json()) as SetAutoWorkConfigRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const shapeError = validateShape(body);
		if (shapeError) return c.json({ error: shapeError }, 400);

		for (const priority of TASK_PRIORITIES) {
			const ref = body.modelByPriority[priority];
			if (ref === null) continue;
			const invalid = await validateModelRef(bridge, ref);
			if (invalid) return c.json({ error: `${priority}: ${invalid}` }, 400);
		}

		try {
			const config = setAutoWorkConfig(cwd, {
				enabled: body.enabled,
				modelByPriority: body.modelByPriority,
				timeWindows: body.timeWindows,
				sessionPctLimit: body.sessionPctLimit,
				weeklyPctLimit: body.weeklyPctLimit,
				defaultEstimatePctByPriority: body.defaultEstimatePctByPriority,
				estimationBuffer: body.estimationBuffer,
			});
			return c.json(config);
		} catch (err) {
			log.error("setAutoWorkConfig failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/auto-work/runs", (c) => {
		const limitParam = c.req.query("limit");
		let limit: number | undefined;
		if (limitParam !== undefined) {
			limit = Number(limitParam);
			if (!Number.isInteger(limit) || limit <= 0) {
				return c.json({ error: "limit must be a positive integer" }, 400);
			}
		}

		const taskId = c.req.query("taskId")?.trim() || undefined;

		const priorityParam = c.req.query("priority")?.trim();
		let priority: TaskPriority | undefined;
		if (priorityParam !== undefined) {
			if (!TASK_PRIORITIES.includes(priorityParam as TaskPriority)) {
				return c.json({ error: `priority must be one of ${TASK_PRIORITIES.join(", ")}` }, 400);
			}
			priority = priorityParam as TaskPriority;
		}

		const statusParam = c.req.query("status")?.trim();
		let status: AutoWorkRunStatus | undefined;
		if (statusParam !== undefined) {
			if (!RUN_STATUSES.includes(statusParam as AutoWorkRunStatus)) {
				return c.json({ error: `status must be one of ${RUN_STATUSES.join(", ")}` }, 400);
			}
			status = statusParam as AutoWorkRunStatus;
		}

		const response: ListAutoWorkRunsResponse = { runs: listAutoWorkRuns({ limit, taskId, priority, status }) };
		return c.json(response);
	});

	app.get("/auto-work/cost-estimate", (c) => {
		const priorityParam = c.req.query("priority")?.trim();
		if (!priorityParam || !TASK_PRIORITIES.includes(priorityParam as TaskPriority)) {
			return c.json({ error: `priority query param must be one of ${TASK_PRIORITIES.join(", ")}` }, 400);
		}
		const response: AutoWorkCostEstimateResponse = getAutoWorkCostEstimate(priorityParam as TaskPriority);
		return c.json(response);
	});

	return app;
}

/**
 * Validates field types/ranges only — does not touch the bridge's model
 * catalog (that's `validateModelRef`, called separately since it's async).
 * Returns an error message, or `undefined` when the shape is acceptable.
 */
function validateShape(body: SetAutoWorkConfigRequest): string | undefined {
	if (typeof body.enabled !== "boolean") return "enabled must be a boolean";

	if (typeof body.modelByPriority !== "object" || body.modelByPriority === null) {
		return "modelByPriority must be an object";
	}
	for (const priority of TASK_PRIORITIES) {
		const ref = body.modelByPriority[priority];
		if (ref === undefined) return `modelByPriority.${priority} is required (use null for no override)`;
		if (ref === null) continue;
		if (typeof ref !== "object" || typeof ref.provider !== "string" || typeof ref.id !== "string") {
			return `modelByPriority.${priority} must be null or {provider, id}`;
		}
	}

	if (!Array.isArray(body.timeWindows)) return "timeWindows must be an array";
	const sortedWindows = [...body.timeWindows].sort((a, b) => a.start - b.start);
	for (let i = 0; i < sortedWindows.length; i++) {
		const w = sortedWindows[i]!;
		if (!Number.isInteger(w.start) || w.start < 0 || w.start > 23)
			return `timeWindows[${i}].start must be an integer 0–23`;
		if (!Number.isInteger(w.end) || w.end < 1 || w.end > 24)
			return `timeWindows[${i}].end must be an integer 1–24`;
		if (w.start >= w.end)
			return `timeWindows[${i}]: start must be less than end`;
		if (i > 0 && w.start < sortedWindows[i - 1]!.end)
			return `timeWindows: windows must not overlap (${sortedWindows[i - 1]!.start}–${sortedWindows[i - 1]!.end} overlaps ${w.start}–${w.end})`;
	}

	if (typeof body.sessionPctLimit !== "number" || body.sessionPctLimit < 0 || body.sessionPctLimit > 100) {
		return "sessionPctLimit must be a number between 0 and 100";
	}
	if (typeof body.weeklyPctLimit !== "number" || body.weeklyPctLimit < 0 || body.weeklyPctLimit > 100) {
		return "weeklyPctLimit must be a number between 0 and 100";
	}

	if (typeof body.defaultEstimatePctByPriority !== "object" || body.defaultEstimatePctByPriority === null) {
		return "defaultEstimatePctByPriority must be an object";
	}
	for (const priority of TASK_PRIORITIES) {
		const pct = body.defaultEstimatePctByPriority[priority];
		if (typeof pct !== "number" || pct < 0 || pct > 100) {
			return `defaultEstimatePctByPriority.${priority} must be a number between 0 and 100`;
		}
	}

	if (typeof body.estimationBuffer !== "number" || body.estimationBuffer < 1 || body.estimationBuffer > 5) {
		return "estimationBuffer must be a number between 1 and 5";
	}

	return undefined;
}

/**
 * Validate a `ModelRef` against the bridge's live model catalog. Mirrors
 * `routes.ts`'s private `validateModelRef` (used by `POST /sessions` and
 * `PUT /workspace-preferences`) — duplicated rather than imported since
 * that one isn't exported and this router owns its own small set of
 * private helpers per the repo's router-per-file convention.
 */
async function validateModelRef(bridge: AgentBridge, ref: ModelRef): Promise<string | undefined> {
	const models = await bridge.listModels();
	const match = models.find((m) => m.provider === ref.provider && m.id === ref.id);
	if (!match) return `unknown model: ${ref.provider}/${ref.id}`;
	if (!match.isAvailable) return `no auth configured for ${ref.provider}/${ref.id}`;
	return undefined;
}
