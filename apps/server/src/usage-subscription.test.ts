/**
 * Unit tests for `fetchSubscriptionUsage` / `getSubscriptionUsage`.
 *
 * Never hits a real provider — `fetcherOverride` is always a stub that returns
 * synthetic `UsageReport[]` or `null`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";

import {
	fetchSubscriptionUsage,
	getSubscriptionUsage,
	resetSubscriptionUsageCacheForTests,
	type UsageReportsFetcher,
} from "./usage-subscription.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIVE_HOURS_MS = 5 * 3600_000;
const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

function makeLimit(
	id: string,
	label: string,
	usedFraction: number,
	windowDurationMs: number,
	resetsAt?: number,
): UsageReport["limits"][number] {
	return {
		id,
		label,
		scope: { provider: "anthropic" },
		amount: { usedFraction, unit: "percent" },
		window: { id, label, durationMs: windowDurationMs, resetsAt },
	};
}

/** One-window report (5h by default). */
function makeReport(usedFraction: number, resetsAt?: number): UsageReport {
	return {
		provider: "anthropic",
		limits: [makeLimit("5h", "5 Hour", usedFraction, FIVE_HOURS_MS, resetsAt)],
	};
}

/** Full two-window report mimicking Claude's real response. */
function makeFullReport(fiveHourFraction: number, sevenDayFraction: number, resetsAt5h?: number, resetsAt7d?: number): UsageReport {
	return {
		provider: "anthropic",
		limits: [
			makeLimit("5h", "5 Hour", fiveHourFraction, FIVE_HOURS_MS, resetsAt5h),
			makeLimit("7d", "7 Day", sevenDayFraction, SEVEN_DAYS_MS, resetsAt7d),
		],
	};
}

function fetcher(reports: UsageReport[] | null): UsageReportsFetcher {
	return async () => reports;
}

function throwingFetcher(message: string): UsageReportsFetcher {
	return async () => {
		throw new Error(message);
	};
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => resetSubscriptionUsageCacheForTests());
afterEach(() => resetSubscriptionUsageCacheForTests());

// ---------------------------------------------------------------------------
// fetchSubscriptionUsage
// ---------------------------------------------------------------------------

describe("fetchSubscriptionUsage", () => {
	test("returns unavailable when reports array is null", async () => {
		const result = await fetchSubscriptionUsage(fetcher(null));
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/no provider usage data/);
	});

	test("returns unavailable when reports array is empty", async () => {
		const result = await fetchSubscriptionUsage(fetcher([]));
		expect(result.available).toBe(false);
	});

	test("maps usedFraction to pctUsed and builds limits array", async () => {
		const resetMs = Date.parse("2026-08-01T00:00:00Z");
		const result = await fetchSubscriptionUsage(fetcher([makeReport(0.75, resetMs)]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.pctUsed).toBe(75);
		expect(result.resetAt).toBe(new Date(resetMs).toISOString());
		expect(result.limits).toHaveLength(1);
		expect(result.limits[0]).toMatchObject({ label: "5 Hour", pctUsed: 75, windowDurationMs: FIVE_HOURS_MS });
	});

	test("exposes both session (5h) and weekly (7d) limits in sorted order", async () => {
		const reset5h = Date.parse("2026-08-01T05:00:00Z");
		const reset7d = Date.parse("2026-08-07T00:00:00Z");
		const result = await fetchSubscriptionUsage(fetcher([makeFullReport(0.4, 0.2, reset5h, reset7d)]));
		expect(result.available).toBe(true);
		if (!result.available) return;

		// Shortest window (5h) comes first
		expect(result.limits[0]).toMatchObject({ label: "5 Hour", pctUsed: 40, windowDurationMs: FIVE_HOURS_MS });
		expect(result.limits[1]).toMatchObject({ label: "7 Day", pctUsed: 20, windowDurationMs: SEVEN_DAYS_MS });

		// Top-level pctUsed = most-constraining (5h at 40% > 7d at 20%)
		expect(result.pctUsed).toBe(40);
	});

	test("top-level pctUsed reflects the most-constraining window", async () => {
		// 7d is more constraining than 5h here
		const result = await fetchSubscriptionUsage(fetcher([makeFullReport(0.3, 0.8)]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.pctUsed).toBeCloseTo(80, 5);
	});

	test("deduplicates limits with the same id across multiple reports, keeping highest fraction", async () => {
		const low: UsageReport = { provider: "anthropic", limits: [makeLimit("5h", "5 Hour", 0.2, FIVE_HOURS_MS)] };
		const high: UsageReport = { provider: "anthropic", limits: [makeLimit("5h", "5 Hour", 0.9, FIVE_HOURS_MS)] };
		const result = await fetchSubscriptionUsage(fetcher([low, high]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.pctUsed).toBeCloseTo(90, 5);
		// Deduped: only one "5h" entry
		expect(result.limits).toHaveLength(1);
	});

	test("clamps pctUsed to [0, 100]", async () => {
		const report = makeReport(1.5); // over 100%
		const result = await fetchSubscriptionUsage(fetcher([report]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.pctUsed).toBe(100);
		expect(result.limits[0]!.pctUsed).toBe(100);
	});

	test("returns available with empty limits and 0% when reports have no usedFraction", async () => {
		const report: UsageReport = {
			provider: "anthropic",
			limits: [{ id: "5h", label: "5 Hour", scope: { provider: "anthropic" }, amount: { unit: "tokens" } }],
		};
		const result = await fetchSubscriptionUsage(fetcher([report]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.pctUsed).toBe(0);
		expect(result.limits).toHaveLength(0); // no usedFraction → excluded from limits array
	});

	test("returns graceful unavailable when fetcher throws (network error)", async () => {
		const result = await fetchSubscriptionUsage(throwingFetcher("ECONNREFUSED"));
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/ECONNREFUSED/);
	});

	test("uses a fallback resetAt when window has no resetsAt", async () => {
		const report = makeReport(0.5); // makeReport passes no resetsAt
		const result = await fetchSubscriptionUsage(fetcher([report]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(() => new Date(result.resetAt)).not.toThrow();
		expect(() => new Date(result.limits[0]!.resetAt)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// getSubscriptionUsage caching
// ---------------------------------------------------------------------------

describe("getSubscriptionUsage caching", () => {
	test("two rapid calls only invoke the fetcher once", async () => {
		let calls = 0;
		const stub: UsageReportsFetcher = async () => {
			calls++;
			return [makeReport(0.1, Date.now() + FIVE_HOURS_MS)];
		};
		const [a, b] = await Promise.all([getSubscriptionUsage(stub), getSubscriptionUsage(stub)]);
		expect(calls).toBe(1);
		expect(a).toEqual(b);
	});

	test("a second call within the TTL window reuses the cached result", async () => {
		let calls = 0;
		const stub: UsageReportsFetcher = async () => {
			calls++;
			return [makeReport(0.2, Date.now() + FIVE_HOURS_MS)];
		};
		const t0 = Date.now();
		await getSubscriptionUsage(stub, t0);
		await getSubscriptionUsage(stub, t0 + 1_000);
		expect(calls).toBe(1);
	});

	test("a call after the TTL expires fires a fresh request", async () => {
		let calls = 0;
		const stub: UsageReportsFetcher = async () => {
			calls++;
			return [makeReport(0.3, Date.now() + FIVE_HOURS_MS)];
		};
		const t0 = Date.now();
		await getSubscriptionUsage(stub, t0);
		await getSubscriptionUsage(stub, t0 + 61_000);
		expect(calls).toBe(2);
	});
});
