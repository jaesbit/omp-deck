import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { AdvisorSettingsResponse } from "@omp-deck/protocol";
import { Settings } from "@oh-my-pi/pi-coding-agent";

import { buildAdvisorsRouter } from "./routes-advisors.ts";

const ADVISOR_ENABLED_KEY = "advisor.enabled";

let settings: Settings;
let initSpy: ReturnType<typeof spyOn<typeof Settings, "init">>;
let setSpy: ReturnType<typeof spyOn<Settings, "set">>;
let flushSpy: ReturnType<typeof spyOn<Settings, "flush">>;

beforeEach(() => {
	settings = Settings.isolated();
	initSpy = spyOn(Settings, "init").mockResolvedValue(settings);
	setSpy = spyOn(settings, "set");
	flushSpy = spyOn(settings, "flush");
});

afterEach(() => {
	initSpy.mockRestore();
	setSpy.mockRestore();
	flushSpy.mockRestore();
});

describe("advisor settings routes", () => {
	test("GET defaults an absent advisor.enabled setting to true and persists it", async () => {
		const app = buildAdvisorsRouter();
		const res = await app.request("/advisors/settings");

		expect(res.status).toBe(200);
		expect((await res.json()) as AdvisorSettingsResponse).toEqual({ enabled: true, configured: true });
		expect(setSpy).toHaveBeenCalledTimes(1);
		expect(setSpy).toHaveBeenCalledWith(ADVISOR_ENABLED_KEY, true);
		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(settings.get(ADVISOR_ENABLED_KEY)).toBe(true);
		expect(settings.isConfigured(ADVISOR_ENABLED_KEY)).toBe(true);
	});

	test("GET preserves an existing explicit false setting without another write", async () => {
		settings.set(ADVISOR_ENABLED_KEY, false);
		setSpy.mockClear();
		flushSpy.mockClear();

		const app = buildAdvisorsRouter();
		const res = await app.request("/advisors/settings");

		expect(res.status).toBe(200);
		expect((await res.json()) as AdvisorSettingsResponse).toEqual({ enabled: false, configured: true });
		expect(setSpy).not.toHaveBeenCalled();
		expect(flushSpy).not.toHaveBeenCalled();
	});

	test("PUT persists false and returns the configured setting", async () => {
		const app = buildAdvisorsRouter();
		const res = await app.request("/advisors/settings", {
			method: "PUT",
			body: JSON.stringify({ enabled: false }),
		});

		expect(res.status).toBe(200);
		expect((await res.json()) as AdvisorSettingsResponse).toEqual({ enabled: false, configured: true });
		expect(setSpy).toHaveBeenCalledTimes(1);
		expect(setSpy).toHaveBeenCalledWith(ADVISOR_ENABLED_KEY, false);
		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(settings.get(ADVISOR_ENABLED_KEY)).toBe(false);
		expect(settings.isConfigured(ADVISOR_ENABLED_KEY)).toBe(true);
	});

	for (const { name, body, error } of [
		{ name: "malformed JSON", body: "not json", error: "invalid json body" },
		{ name: "a non-boolean enabled value", body: JSON.stringify({ enabled: "false" }), error: "enabled must be a boolean" },
	]) {
		test(`PUT rejects ${name} without mutating advisor.enabled`, async () => {
			const app = buildAdvisorsRouter();
			const res = await app.request("/advisors/settings", { method: "PUT", body });

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error });
			expect(setSpy).not.toHaveBeenCalled();
			expect(flushSpy).not.toHaveBeenCalled();
			expect(settings.isConfigured(ADVISOR_ENABLED_KEY)).toBe(false);
		});
	}
});
