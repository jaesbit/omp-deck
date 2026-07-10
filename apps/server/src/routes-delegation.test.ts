import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GetDelegationSettingsResponse } from "@omp-deck/protocol";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const canApplyText = mock(async () => true);
const applyText = mock(async () => {});
const getRepoRoot = mock(async () => "/virtual/repository");

mock.module("@oh-my-pi/pi-coding-agent/utils/git", () => ({
	patch: { canApplyText, applyText },
}));
mock.module("@oh-my-pi/pi-coding-agent/task/worktree", () => ({
	cleanupTaskBranches: mock(async () => {}),
	getRepoRoot,
	mergeTaskBranches: mock(async () => ({ failed: [] })),
}));

const { buildDelegationRouter } = await import("./routes-delegation.ts");

let originalHome: string | undefined;
let fakeHome: string;
let repoCwd: string;
let settings: Settings;
let initSpy: ReturnType<typeof spyOn<typeof Settings, "init">>;
let setSpy: ReturnType<typeof spyOn<Settings, "set">>;
let flushSpy: ReturnType<typeof spyOn<Settings, "flush">>;

beforeEach(() => {
	originalHome = process.env.HOME;
	fakeHome = mkdtempSync(path.join(os.tmpdir(), "omp-deck-delegation-home-"));
	repoCwd = path.join(fakeHome, "workspace");
	mkdirSync(repoCwd);
	process.env.HOME = fakeHome;

	settings = Settings.isolated();
	settings.set("task.maxConcurrency", 7);
	initSpy = spyOn(Settings, "init").mockResolvedValue(settings);
	setSpy = spyOn(settings, "set");
	flushSpy = spyOn(settings, "flush");
	canApplyText.mockClear();
	applyText.mockClear();
	getRepoRoot.mockClear();
});

afterEach(() => {
	initSpy.mockRestore();
	setSpy.mockRestore();
	flushSpy.mockRestore();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("delegation governance routes", () => {
	test("GET exposes the six governed OMP settings with their effective values and metadata", async () => {
		const app = buildDelegationRouter();
		const res = await app.request("/delegation/settings");

		expect(res.status).toBe(200);
		const body = (await res.json()) as GetDelegationSettingsResponse;
		expect(body.settings).toHaveLength(6);
		expect(body.settings.map((entry) => entry.key)).toEqual([
			"task.maxConcurrency",
			"task.maxRecursionDepth",
			"task.maxRuntimeMs",
			"task.isolation.mode",
			"task.isolation.merge",
			"task.isolation.commits",
		]);
		expect(body.settings.find((entry) => entry.key === "task.maxConcurrency")).toMatchObject({
			key: "task.maxConcurrency",
			type: "number",
			value: 7,
			configured: true,
			label: "Max Concurrent Tasks",
			description: "Maximum number of subagents running concurrently",
		});
		expect(body.configPath).toBe(path.join(fakeHome, ".omp", "agent", "config.yml"));
	});

	for (const { name, updates, error } of [
		{
			name: "unknown settings keys",
			updates: { "task.unrestricted": true },
			error: "unknown delegation setting: task.unrestricted",
		},
		{
			name: "recursion depths below the supported unlimited sentinel",
			updates: { "task.maxRecursionDepth": -2 },
			error: "task.maxRecursionDepth must be an integer greater than or equal to -1",
		},
	]) {
		test(`PATCH rejects ${name} without changing OMP settings`, async () => {
			const app = buildDelegationRouter();
			const res = await app.request("/delegation/settings", {
				method: "PATCH",
				body: JSON.stringify({ updates }),
			});

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error });
			expect(setSpy).not.toHaveBeenCalled();
			expect(flushSpy).not.toHaveBeenCalled();
			expect(settings.get("task.maxConcurrency")).toBe(7);
		});
	}

	test("PATCH persists an allowed OMP setting and returns its new effective value", async () => {
		const app = buildDelegationRouter();
		const res = await app.request("/delegation/settings", {
			method: "PATCH",
			body: JSON.stringify({ updates: { "task.maxConcurrency": 4 } }),
		});

		expect(res.status).toBe(200);
		expect(setSpy).toHaveBeenCalledTimes(1);
		expect(setSpy).toHaveBeenCalledWith("task.maxConcurrency", 4);
		expect(flushSpy).toHaveBeenCalledTimes(1);
		const body = (await res.json()) as GetDelegationSettingsResponse;
		expect(body.settings.find((entry) => entry.key === "task.maxConcurrency")).toMatchObject({
			value: 4,
			configured: true,
		});
	});

	test("POST artifact apply rejects invalid artifact paths before the patch mutation boundary", async () => {
		const app = buildDelegationRouter();

		for (const [patchPath, error] of [
			["task.patch", "path must be an absolute patch path"],
			[path.join(repoCwd, "task.txt"), "artifact path must end in .patch"],
		] as const) {
			const res = await app.request("/delegation/artifact/apply", {
				method: "POST",
				body: JSON.stringify({ cwd: repoCwd, patchPath }),
			});

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error });
		}
		expect(applyText).not.toHaveBeenCalled();
	});
});
