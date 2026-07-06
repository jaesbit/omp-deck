/**
 * Usage REST surface (T-59). Mounted on the main router at `/api/usage/*`.
 *
 * - `GET /usage/subscription` — cached provider subscription / rate-limit
 *   usage via the SDK's AuthStorage; see `usage-subscription.ts`.
 * - `GET /usage/sessions` — per-session token/cost totals from persisted
 *   transcripts; see `usage-sessions.ts`.
 */

import { Hono } from "hono";
import type { ListSessionUsageResponse } from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { getSubscriptionUsage, type UsageReportsFetcher } from "./usage-subscription.ts";
import { listSessionUsage } from "./usage-sessions.ts";

const DEFAULT_SESSIONS_LIMIT = 20;
const MAX_SESSIONS_LIMIT = 200;

export interface BuildUsageRouterOptions {
	/**
	 * Test-only: override the usage-reports fetcher injected into
	 * `getSubscriptionUsage`, avoiding the real `getDeckAuthStorage()` call.
	 */
	fetcherOverride?: UsageReportsFetcher;
}

export function buildUsageRouter(bridge: AgentBridge, options: BuildUsageRouterOptions = {}): Hono {
	const app = new Hono();

	app.get("/usage/subscription", async (c) => {
		const result = await getSubscriptionUsage(options.fetcherOverride);
		return c.json(result);
	});

	app.get("/usage/sessions", async (c) => {
		const rawLimit = c.req.query("limit");
		let limit = DEFAULT_SESSIONS_LIMIT;
		if (rawLimit !== undefined) {
			const parsed = Number(rawLimit);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				return c.json({ error: "limit must be a positive integer" }, 400);
			}
			limit = Math.min(parsed, MAX_SESSIONS_LIMIT);
		}
		const sessions = await listSessionUsage(bridge, limit);
		const body: ListSessionUsageResponse = { sessions };
		return c.json(body);
	});

	return app;
}
