/**
 * Onboarding routes — drive the first-run wizard's state machine.
 *
 * GET  /api/onboarding/state          → OnboardingState (composite)
 * POST /api/onboarding/complete       → mark done (skipped flag distinguishes
 *                                       walked-through vs X-ed out)
 * POST /api/onboarding/seed-kb-system → write the README + every
 *                                       `system/*.md` / `rules/*.md` template
 *                                       (see `kb-templates.ts`); idempotent
 *                                       (won't overwrite existing files)
 *
 * Provider auth, kb init, start.md write, and env updates all reuse their
 * existing routes (`/api/auth/oauth/*`, `/api/kb/init`,
 * `/api/orientation/*`, `/api/env/*`). The wizard just sequences them.
 */
import { Hono } from "hono";

import type {
	CompleteOnboardingRequest,
	OnboardingState,
	SeedKbSystemRequest,
	SeedKbSystemResponse,
} from "@omp-deck/protocol";

import { resolveKbRoot } from "./kb-service.ts";
import { seedKbTemplates } from "./kb-templates.ts";
import type { SeedKbTemplatesResult } from "./kb-templates.ts";
import { logger } from "./log.ts";
import { getOnboardingState, markOnboardingComplete } from "./onboarding-state.ts";

const log = logger("routes:onboarding");

export function buildOnboardingRouter(): Hono {
	const app = new Hono();

	app.get("/state", async (c) => {
		const state: OnboardingState = await getOnboardingState();
		return c.json(state);
	});

	app.post("/complete", async (c) => {
		let body: CompleteOnboardingRequest = { skipped: false };
		try {
			body = (await c.req.json()) as CompleteOnboardingRequest;
		} catch {
			// Empty body is fine — assume non-skipped completion.
		}
		markOnboardingComplete(Boolean(body.skipped));
		const state = await getOnboardingState();
		return c.json(state);
	});

	app.post("/seed-kb-system", async (c) => {
		let body: SeedKbSystemRequest = {};
		try {
			body = (await c.req.json()) as SeedKbSystemRequest;
		} catch {
			/* empty body uses defaults */
		}
		const kbRoot = body.kbRoot?.trim() || resolveKbRoot();
		let result: SeedKbTemplatesResult;
		try {
			result = seedKbTemplates(kbRoot);
		} catch (err) {
			log.error(`seed-kb-system failed at ${kbRoot}`, err);
			return c.json({ error: String(err) }, 500);
		}
		const response: SeedKbSystemResponse = result;
		return c.json(response);
	});

	return app;
}

