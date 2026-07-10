import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Settings, settings } from "@oh-my-pi/pi-coding-agent";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { generateTitleOnline } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

import { initializeSdkSettings } from "./sdk-settings.ts";

let testRoot: string;

beforeEach(() => {
	testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-sdk-settings-"));
});

afterEach(() => {
	resetSettingsForTest();
	fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("server SDK settings startup", () => {
	test("initializes Settings before the online title generator reads the singleton", async () => {
		const model = { id: "title-test-model", provider: "title-test-provider" } as never;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => undefined,
		};

		await expect(
			generateTitleOnline("Fix the login flow", registry as never, settings, "session-1", model),
		).rejects.toThrow("Settings not initialized. Call Settings.init() first.");

		const initialized = await initializeSdkSettings(testRoot, path.join(testRoot, "agent"));

		expect(Settings.instance).toBe(initialized);
		expect(Settings.instance.getCwd()).toBe(testRoot);
		expect(Settings.instance.getAgentDir()).toBe(path.join(testRoot, "agent"));
		await expect(
			generateTitleOnline("Fix the login flow", registry as never, settings, "session-1", model),
		).resolves.toBeNull();
	});
});
