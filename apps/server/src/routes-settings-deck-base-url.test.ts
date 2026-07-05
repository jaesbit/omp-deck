/**
 * Exercises the real Hono router for `/settings/deck-base-url` (T-61):
 * computed default, persistence across a simulated restart, clearing back
 * to default, and request validation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DeckBaseUrlResponse } from "@omp-deck/protocol";

import { closeDb, openDb } from "./db/index.ts";
import { buildSettingsRouter } from "./routes-settings.ts";
import type { Config } from "./config.ts";
import type { AgentBridge } from "./bridge/types.ts";

let dbDir: string;
let dbPath: string;

function fakeBridge(): AgentBridge {
	return {} as unknown as AgentBridge;
}

function fakeConfig(port = 8787): Config {
	return { port } as Config;
}

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-settings-db-"));
	dbPath = path.join(dbDir, "deck.db");
	openDb({ path: dbPath });
});

afterEach(() => {
	closeDb();
	try {
		fs.rmSync(dbDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe("GET /settings/deck-base-url", () => {
	test("returns the computed default when unset", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig(8787));
		const res = await app.request("/settings/deck-base-url");
		expect(res.status).toBe(200);
		const body = (await res.json()) as DeckBaseUrlResponse;
		expect(body).toEqual({ deckBaseUrl: "http://localhost:8787", isCustom: false });
	});

	test("reflects the configured port", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig(4321));
		const res = await app.request("/settings/deck-base-url");
		const body = (await res.json()) as DeckBaseUrlResponse;
		expect(body.deckBaseUrl).toBe("http://localhost:4321");
	});
});

describe("PUT /settings/deck-base-url", () => {
	test("rejects invalid json", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app.request("/settings/deck-base-url", { method: "PUT", body: "not json" });
		expect(res.status).toBe(400);
	});

	test("rejects a non-string, non-null deckBaseUrl", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app.request("/settings/deck-base-url", {
			method: "PUT",
			body: JSON.stringify({ deckBaseUrl: 42 }),
		});
		expect(res.status).toBe(400);
	});

	test("rejects a malformed URL", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app.request("/settings/deck-base-url", {
			method: "PUT",
			body: JSON.stringify({ deckBaseUrl: "not-a-url" }),
		});
		expect(res.status).toBe(400);
	});

	test("persists a custom value and GET returns it after PUT", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const putRes = await app.request("/settings/deck-base-url", {
			method: "PUT",
			body: JSON.stringify({ deckBaseUrl: "https://deck.example.com" }),
		});
		expect(putRes.status).toBe(200);
		const putBody = (await putRes.json()) as DeckBaseUrlResponse;
		expect(putBody).toEqual({ deckBaseUrl: "https://deck.example.com", isCustom: true });

		const getRes = await app.request("/settings/deck-base-url");
		const getBody = (await getRes.json()) as DeckBaseUrlResponse;
		expect(getBody).toEqual({ deckBaseUrl: "https://deck.example.com", isCustom: true });
	});

	test("persists across a simulated server restart (close + reopen the DB file)", async () => {
		const app1 = buildSettingsRouter(fakeBridge(), fakeConfig());
		await app1.request("/settings/deck-base-url", {
			method: "PUT",
			body: JSON.stringify({ deckBaseUrl: "https://deck.example.com" }),
		});

		closeDb();
		openDb({ path: dbPath });

		const app2 = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app2.request("/settings/deck-base-url");
		const body = (await res.json()) as DeckBaseUrlResponse;
		expect(body).toEqual({ deckBaseUrl: "https://deck.example.com", isCustom: true });
	});

	test("deckBaseUrl: null clears the override, reverting to the computed default", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig(8787));
		await app.request("/settings/deck-base-url", {
			method: "PUT",
			body: JSON.stringify({ deckBaseUrl: "https://deck.example.com" }),
		});
		const res = await app.request("/settings/deck-base-url", {
			method: "PUT",
			body: JSON.stringify({ deckBaseUrl: null }),
		});
		const body = (await res.json()) as DeckBaseUrlResponse;
		expect(body).toEqual({ deckBaseUrl: "http://localhost:8787", isCustom: false });
	});
});
