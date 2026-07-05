/**
 * Unit tests for `fetchSubscriptionUsage` / `getSubscriptionUsage`. Never
 * hits the live Anthropic API — `fetchImpl` is always a stub.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	fetchSubscriptionUsage,
	getSubscriptionUsage,
	resetSubscriptionUsageCacheForTests,
} from "./usage-subscription.ts";

function headerResponse(headers: Record<string, string>, status = 200): Response {
	return new Response("{}", { status, headers });
}

let originalKey: string | undefined;

beforeEach(() => {
	originalKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
	resetSubscriptionUsageCacheForTests();
});

afterEach(() => {
	if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalKey;
	resetSubscriptionUsageCacheForTests();
});

describe("fetchSubscriptionUsage", () => {
	test("returns unavailable when no API key is configured", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		const result = await fetchSubscriptionUsage(async () => headerResponse({}));
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/not configured/);
	});

	test("parses used/limit/pctUsed/resetAt from rate-limit headers", async () => {
		const resetAt = "2026-08-01T00:00:00Z";
		const fetchImpl = async () =>
			headerResponse({
				"anthropic-ratelimit-tokens-limit": "1000000",
				"anthropic-ratelimit-tokens-remaining": "250000",
				"anthropic-ratelimit-tokens-reset": resetAt,
			});
		const result = await fetchSubscriptionUsage(fetchImpl);
		expect(result).toEqual({
			available: true,
			used: 750000,
			limit: 1000000,
			pctUsed: 75,
			resetAt: new Date(resetAt).toISOString(),
		});
	});

	test("returns graceful unavailable on 401/403 instead of throwing", async () => {
		const fetchImpl = async () => headerResponse({}, 403);
		const result = await fetchSubscriptionUsage(fetchImpl);
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/usage\/messages access/);
	});

	test("returns graceful unavailable when rate-limit headers are missing", async () => {
		const fetchImpl = async () => headerResponse({});
		const result = await fetchSubscriptionUsage(fetchImpl);
		expect(result.available).toBe(false);
	});

	test("returns graceful unavailable when fetch itself throws (network error)", async () => {
		const fetchImpl = async () => {
			throw new Error("ECONNREFUSED");
		};
		const result = await fetchSubscriptionUsage(fetchImpl);
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/ECONNREFUSED/);
	});
});

describe("getSubscriptionUsage caching", () => {
	test("two rapid calls only fire one Anthropic request", async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return headerResponse({
				"anthropic-ratelimit-tokens-limit": "100",
				"anthropic-ratelimit-tokens-remaining": "90",
				"anthropic-ratelimit-tokens-reset": "2026-08-01T00:00:00Z",
			});
		};
		const [a, b] = await Promise.all([getSubscriptionUsage(fetchImpl), getSubscriptionUsage(fetchImpl)]);
		expect(calls).toBe(1);
		expect(a).toEqual(b);
	});

	test("a second call within the TTL window reuses the cached result", async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return headerResponse({
				"anthropic-ratelimit-tokens-limit": "100",
				"anthropic-ratelimit-tokens-remaining": "90",
				"anthropic-ratelimit-tokens-reset": "2026-08-01T00:00:00Z",
			});
		};
		const t0 = Date.now();
		await getSubscriptionUsage(fetchImpl, t0);
		await getSubscriptionUsage(fetchImpl, t0 + 1000); // well within 60s TTL
		expect(calls).toBe(1);
	});

	test("a call after the TTL expires fires a fresh request", async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return headerResponse({
				"anthropic-ratelimit-tokens-limit": "100",
				"anthropic-ratelimit-tokens-remaining": "90",
				"anthropic-ratelimit-tokens-reset": "2026-08-01T00:00:00Z",
			});
		};
		const t0 = Date.now();
		await getSubscriptionUsage(fetchImpl, t0);
		await getSubscriptionUsage(fetchImpl, t0 + 61_000); // past 60s TTL
		expect(calls).toBe(2);
	});
});
