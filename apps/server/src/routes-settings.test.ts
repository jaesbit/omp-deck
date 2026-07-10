/**
 * Exercises the real Hono router for internal task model and session-title
 * prompt settings. Each assertion covers a persisted API contract rather than
 * the router's internal storage wiring.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
	InternalTaskModelResponse,
	ModelInfo,
	SessionTitlePromptResponse,
	SetSessionTitlePromptRequest,
} from "@omp-deck/protocol";

import { closeDb, openDb } from "./db/index.ts";
import { buildSettingsRouter } from "./routes-settings.ts";
import type { Config } from "./config.ts";
import type { AgentBridge } from "./bridge/types.ts";

let dbDir: string;

const AVAILABLE_MODEL: ModelInfo = {
	provider: "anthropic",
	id: "claude-good",
	label: "Claude Good",
	isAvailable: true,
};

function fakeBridge(models: ModelInfo[] = [AVAILABLE_MODEL]): AgentBridge {
	return {
		async listModels() {
			return models;
		},
	} as unknown as AgentBridge;
}

function fakeConfig(): Config {
	return { port: 8787 } as Config;
}

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-settings-internal-task-model-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
});

afterEach(() => {
	closeDb();
	try {
		fs.rmSync(dbDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe("GET /settings/internal-task-model", () => {
	test("returns model: null when unset", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app.request("/settings/internal-task-model");
		expect(res.status).toBe(200);
		const body = (await res.json()) as InternalTaskModelResponse;
		expect(body).toEqual({ model: null });
	});
});

describe("PUT /settings/internal-task-model", () => {
	test("persists a catalog model and GET reflects it afterward", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const putRes = await app.request("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "anthropic", id: "claude-good" } }),
		});
		expect(putRes.status).toBe(200);
		expect((await putRes.json()) as InternalTaskModelResponse).toEqual({
			model: { provider: "anthropic", id: "claude-good" },
		});

		const getRes = await app.request("/settings/internal-task-model");
		expect((await getRes.json()) as InternalTaskModelResponse).toEqual({
			model: { provider: "anthropic", id: "claude-good" },
		});
	});

	test("model: null clears a previously-persisted override", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		await app.request("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "anthropic", id: "claude-good" } }),
		});

		const clearRes = await app.request("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model: null }),
		});
		expect(clearRes.status).toBe(200);
		expect((await clearRes.json()) as InternalTaskModelResponse).toEqual({ model: null });

		const getRes = await app.request("/settings/internal-task-model");
		expect((await getRes.json()) as InternalTaskModelResponse).toEqual({ model: null });
	});

	for (const [name, body] of [
		["missing id", { model: { provider: "anthropic" } }],
		["missing provider", { model: { id: "claude-good" } }],
		["non-object model", { model: "claude-good" }],
	] as const) {
		test(`rejects a malformed model shape (${name})`, async () => {
			const app = buildSettingsRouter(fakeBridge(), fakeConfig());
			const res = await app.request("/settings/internal-task-model", {
				method: "PUT",
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(400);
		});
	}

	test("rejects a model that is not present in the bridge's catalog", async () => {
		const app = buildSettingsRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());
		const res = await app.request("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "openai", id: "not-in-catalog" } }),
		});
		expect(res.status).toBe(400);

		const getRes = await app.request("/settings/internal-task-model");
		expect((await getRes.json()) as InternalTaskModelResponse).toEqual({ model: null });
	});

	test("rejects an invalid json body", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app.request("/settings/internal-task-model", { method: "PUT", body: "not json" });
		expect(res.status).toBe(400);
	});
});

describe("GET /settings/session-title-prompt", () => {
	test("resolves the effective prompt to the default when no override is stored", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app.request("/settings/session-title-prompt");

		expect(res.status).toBe(200);
		const body = (await res.json()) as SessionTitlePromptResponse;
		expect(body.override).toBeNull();
		expect(body.effective).toBe(body.default);
	});
});

describe("PUT /settings/session-title-prompt", () => {
	test("persists an override and exposes it as the effective prompt", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const override = "Write a concise Spanish title.";
		const request: SetSessionTitlePromptRequest = { value: override };
		const putRes = await app.request("/settings/session-title-prompt", {
			method: "PUT",
			body: JSON.stringify(request),
		});

		expect(putRes.status).toBe(200);
		const putBody = (await putRes.json()) as SessionTitlePromptResponse;
		expect(putBody.override).toBe(override);
		expect(putBody.effective).toBe(override);

		const getRes = await app.request("/settings/session-title-prompt");
		expect((await getRes.json()) as SessionTitlePromptResponse).toEqual(putBody);
	});

	test("null removes an override and restores the default resolution", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		await app.request("/settings/session-title-prompt", {
			method: "PUT",
			body: JSON.stringify({ value: "A temporary title instruction." } satisfies SetSessionTitlePromptRequest),
		});

		const clearRes = await app.request("/settings/session-title-prompt", {
			method: "PUT",
			body: JSON.stringify({ value: null } satisfies SetSessionTitlePromptRequest),
		});

		expect(clearRes.status).toBe(200);
		const clearBody = (await clearRes.json()) as SessionTitlePromptResponse;
		expect(clearBody.override).toBeNull();
		expect(clearBody.effective).toBe(clearBody.default);

		const getRes = await app.request("/settings/session-title-prompt");
		expect((await getRes.json()) as SessionTitlePromptResponse).toEqual(clearBody);
	});

	for (const [name, body] of [
		["invalid json", "not json"],
		["non-string, non-null value", JSON.stringify({ value: 42 })],
	] as const) {
		test(`rejects ${name}`, async () => {
			const app = buildSettingsRouter(fakeBridge(), fakeConfig());
			const res = await app.request("/settings/session-title-prompt", { method: "PUT", body });

			expect(res.status).toBe(400);
		});
	}
});
