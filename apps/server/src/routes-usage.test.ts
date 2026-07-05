/**
 * Exercises the real Hono router for `/usage/*`. The subscription endpoint's
 * network call is stubbed via `resetSubscriptionUsageCacheForTests` +
 * `globalThis.fetch` monkey-patching, matching the project's convention of
 * hand-rolled stubs (see `routes-sessions.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentBridge } from "./bridge/types.ts";
import type { SessionSummary, SubscriptionUsageResponse, ListSessionUsageResponse } from "@omp-deck/protocol";
import { buildUsageRouter } from "./routes-usage.ts";
import { resetSubscriptionUsageCacheForTests } from "./usage-subscription.ts";

let dir: string;
let originalFetch: typeof fetch;
let originalKey: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-usage-"));
	originalFetch = globalThis.fetch;
	originalKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
	resetSubscriptionUsageCacheForTests();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalKey;
	resetSubscriptionUsageCacheForTests();
	rmSync(dir, { recursive: true, force: true });
});

function fakeBridge(sessions: SessionSummary[]): AgentBridge {
	return {
		async createSession() {
			throw new Error("not exercised");
		},
		async resumeSession() {
			throw new Error("not exercised");
		},
		getSession() {
			return undefined;
		},
		async listSessions() {
			return sessions;
		},
		async deleteSession() {
			return { deleted: false };
		},
		trackSubscriberAdded() {},
		trackSubscriberRemoved() {},
		bumpActivity() {},
		async listModels() {
			return [];
		},
	} as unknown as AgentBridge;
}

describe("GET /usage/subscription", () => {
	test("returns available usage derived from rate-limit headers", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response("{}", {
				status: 200,
				headers: {
					"anthropic-ratelimit-tokens-limit": "1000",
					"anthropic-ratelimit-tokens-remaining": "400",
					"anthropic-ratelimit-tokens-reset": "2026-08-01T00:00:00Z",
				},
			});
		}) as typeof fetch;

		const app = buildUsageRouter(fakeBridge([]));
		const res = await app.request("/usage/subscription");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SubscriptionUsageResponse;
		expect(body).toEqual({
			available: true,
			used: 600,
			limit: 1000,
			pctUsed: 60,
			resetAt: "2026-08-01T00:00:00.000Z",
		});

		// Second rapid call must not fire a second Anthropic request.
		const res2 = await app.request("/usage/subscription");
		expect(res2.status).toBe(200);
		expect(calls).toBe(1);
	});

	test("returns a graceful error object (not 500) when the key lacks usage scope", async () => {
		globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
		const app = buildUsageRouter(fakeBridge([]));
		const res = await app.request("/usage/subscription");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SubscriptionUsageResponse;
		expect(body.available).toBe(false);
	});

	test("returns a graceful error object when ANTHROPIC_API_KEY is unset", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		const app = buildUsageRouter(fakeBridge([]));
		const res = await app.request("/usage/subscription");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SubscriptionUsageResponse;
		expect(body.available).toBe(false);
	});
});

describe("GET /usage/sessions", () => {
	test("returns per-session token usage, defaulting to 20 sessions", async () => {
		const filePath = path.join(dir, "s1.jsonl");
		writeFileSync(
			filePath,
			[
				{ type: "message", message: { role: "assistant", usage: { totalTokens: 42, cost: { total: 0.02 } } } },
			]
				.map((l) => JSON.stringify(l))
				.join("\n") + "\n",
		);
		const summary: SessionSummary = {
			id: "s1",
			path: filePath,
			cwd: "/x",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			messageCount: 1,
		};
		const app = buildUsageRouter(fakeBridge([summary]));
		const res = await app.request("/usage/sessions");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListSessionUsageResponse;
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].totalTokens).toBe(42);
		expect(body.sessions[0].costUsd).toBeCloseTo(0.02, 6);
	});

	test("rejects a non-positive-integer limit with 400", async () => {
		const app = buildUsageRouter(fakeBridge([]));
		const res = await app.request("/usage/sessions?limit=abc");
		expect(res.status).toBe(400);
	});
});
