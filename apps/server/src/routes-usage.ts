/**
 * Usage REST surface (T-59). Mounted on the main router at `/api/usage/*`.
 *
 * - `GET /usage/subscription` — cached Anthropic subscription/rate-limit
 *   usage; see `usage-subscription.ts` for the endpoint-choice caveat.
 * - `GET /usage/sessions` — per-session token/cost totals from persisted
 *   transcripts; see `usage-sessions.ts`.
 */

import { Hono } from "hono";
import type { ListSessionUsageResponse } from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { getSubscriptionUsage } from "./usage-subscription.ts";
import { listSessionUsage } from "./usage-sessions.ts";

const DEFAULT_SESSIONS_LIMIT = 20;
const MAX_SESSIONS_LIMIT = 200;

export function buildUsageRouter(bridge: AgentBridge): Hono {
	const app = new Hono();

	app.get("/usage/subscription", async (c) => {
		const result = await getSubscriptionUsage();
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
