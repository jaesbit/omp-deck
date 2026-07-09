/**
 * Exercises the real Hono router for `/settings/internal-task-model` (T-78):
 * default-unset GET, PUT persistence + catalog validation, GET reflecting a
 * prior PUT, and request-shape validation. Scoped only to the two new
 * internal-task-model routes — see `routes-settings-deck-base-url.test.ts`
 * for deck-base-url coverage. `task-rewrite-model` (an exact sibling route
 * added earlier, T-76) has no existing test coverage in this router and is
 * intentionally left alone here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { InternalTaskModelResponse, ModelInfo } from "@omp-deck/protocol";

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
