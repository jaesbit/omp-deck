import { Hono } from "hono";
import type { AdvisorSettingsResponse, SetAdvisorSettingsRequest } from "@omp-deck/protocol";

import { getAdvisorSettings, setAdvisorEnabled } from "./advisor-settings.ts";

/**
 * Global advisor setting backed directly by the OMP Settings store.
 * Existing sessions retain their construction-time setting, new sessions read
 * the current persisted value when their SDK worker starts.
 */
export function buildAdvisorsRouter(): Hono {
	const app = new Hono();

	app.get("/advisors/settings", async (c) => {
		const settings = await getAdvisorSettings();
		const body: AdvisorSettingsResponse = settings;
		return c.json(body);
	});

	app.put("/advisors/settings", async (c) => {
		let body: SetAdvisorSettingsRequest;
		try {
			body = (await c.req.json()) as SetAdvisorSettingsRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);

		const settings = await setAdvisorEnabled(body.enabled);
		const response: AdvisorSettingsResponse = settings;
		return c.json(response);
	});

	return app;
}
