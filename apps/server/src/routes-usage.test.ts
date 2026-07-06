/**
 * Exercises the real Hono router for `/usage/*`.
 *
 * The subscription endpoint's external call is stubbed via the
 * `fetcherOverride` option on `buildUsageRouter` — no `globalThis.fetch`
 * patching needed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageReport } from "@oh-my-pi/pi-ai";

import type { AgentBridge } from "./bridge/types.ts";
import type { SessionSummary, SubscriptionUsageResponse, ListSessionUsageResponse } from "@omp-deck/protocol";
import { buildUsageRouter } from "./routes-usage.ts";
import { resetSubscriptionUsageCacheForTests } from "./usage-subscription.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-usage-"));
	resetSubscriptionUsageCacheForTests();
});

afterEach(() => {
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

function reportWith(usedFraction: number, resetsAt?: number): UsageReport {
	return {
		provider: "anthropic",
		limits: [
			{
				id: "5h",
				label: "5 Hour",
				scope: { provider: "anthropic" },
				amount: { usedFraction, unit: "percent" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * 3600_000, resetsAt },
			},
		],
	};
}

describe("GET /usage/subscription", () => {
	test("returns available usage from UsageReport", async () => {
		const resetMs = Date.parse("2026-08-01T00:00:00Z");
		let calls = 0;
		const app = buildUsageRouter(fakeBridge([]), {
			fetcherOverride: async () => {
				calls++;
				return [reportWith(0.6, resetMs)];
			},
		});

		const res = await app.request("/usage/subscription");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SubscriptionUsageResponse;
		expect(body).toMatchObject({
			available: true,
			pctUsed: 60,
			resetAt: new Date(resetMs).toISOString(),
			limits: [{ label: "5 Hour", pctUsed: 60 }],
		});

		// Second rapid call must not fire a second request (cache).
		const res2 = await app.request("/usage/subscription");
		expect(res2.status).toBe(200);
		expect(calls).toBe(1);
	});

	test("returns graceful unavailable when fetcher returns null", async () => {
		const app = buildUsageRouter(fakeBridge([]), {
			fetcherOverride: async () => null,
		});
		const res = await app.request("/usage/subscription");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SubscriptionUsageResponse;
		expect(body.available).toBe(false);
	});

	test("returns graceful unavailable when fetcher throws", async () => {
		const app = buildUsageRouter(fakeBridge([]), {
			fetcherOverride: async () => {
				throw new Error("network error");
			},
		});
		const res = await app.request("/usage/subscription");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SubscriptionUsageResponse;
		expect(body.available).toBe(false);
		if (!body.available) expect(body.reason).toMatch(/network error/);
	});
});

describe("GET /usage/sessions", () => {
	test("returns per-session token usage, defaulting to 20 sessions", async () => {
		const filePath = path.join(dir, "s1.jsonl");
		writeFileSync(
			filePath,
			[{ type: "message", message: { role: "assistant", usage: { totalTokens: 42, cost: { total: 0.02 } } } }]
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
		expect(body.sessions[0]?.totalTokens).toBe(42);
		expect(body.sessions[0]?.costUsd).toBeCloseTo(0.02, 6);
	});

	test("rejects a non-positive-integer limit with 400", async () => {
		const app = buildUsageRouter(fakeBridge([]));
		const res = await app.request("/usage/sessions?limit=abc");
		expect(res.status).toBe(400);
	});
});
