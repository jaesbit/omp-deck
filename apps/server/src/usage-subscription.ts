/**
 * Provider subscription / rate-limit usage — `GET /api/usage/subscription`.
 *
 * Uses the SDK's `AuthStorage.fetchUsageReports()` which handles every auth
 * mode (API key, Claude.ai OAuth, Copilot, etc.) without requiring callers to
 * know the underlying credential type.  The old approach — probing
 * `POST /v1/messages` with `ANTHROPIC_API_KEY` and reading rate-limit headers
 * — only worked for direct API-key accounts; subscription users had no key in
 * the environment so it always returned `available: false`.
 *
 * Caching: one shared in-flight promise + a 60-second result cache so
 * concurrent callers and rapid polls don't fan out to the provider.
 */

import { resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai";
import { getDeckAuthStorage, getDeckModelRegistry } from "./auth-singleton.ts";
import { logger } from "./log.ts";

const log = logger("usage-subscription");

// ---------------------------------------------------------------------------
// Public types (also declared in packages/protocol/src/index.ts — keep in sync)
// ---------------------------------------------------------------------------

export interface SubscriptionUsageAvailable {
	available: true;
	/** Percentage of the most-constraining usage window consumed (0–100). */
	pctUsed: number;
	/** ISO-8601 timestamp of when that window resets. */
	resetAt: string;
}

export interface SubscriptionUsageUnavailable {
	available: false;
	reason: string;
}

export type SubscriptionUsageResult = SubscriptionUsageAvailable | SubscriptionUsageUnavailable;

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Narrowest contract the implementation needs from AuthStorage, exposed so
 * tests can pass a lightweight stub without importing the full SDK.
 */
export type UsageReportsFetcher = (options?: {
	baseUrlResolver?: (provider: string) => string | undefined;
}) => Promise<UsageReport[] | null>;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
	result: SubscriptionUsageResult;
	fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<SubscriptionUsageResult> | null = null;

/** Test-only: drop the cache / in-flight state between test cases. */
export function resetSubscriptionUsageCacheForTests(): void {
	cache = null;
	inFlight = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cached + request-coalesced subscription usage lookup.
 *
 * @param fetcherOverride  Inject a custom fetcher in tests; production always
 *   uses the deck's shared `getDeckAuthStorage()` instance.
 * @param now  Override `Date.now()` for TTL tests.
 */
export async function getSubscriptionUsage(
	fetcherOverride?: UsageReportsFetcher,
	now: number = Date.now(),
): Promise<SubscriptionUsageResult> {
	if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.result;
	if (inFlight) return inFlight;

	inFlight = (async () => {
		try {
			const result = await fetchSubscriptionUsage(fetcherOverride);
			cache = { result, fetchedAt: now };
			return result;
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/**
 * Single uncached fetch. Exported for tests that want to exercise the
 * raw lookup without the caching layer.
 */
export async function fetchSubscriptionUsage(
	fetcherOverride?: UsageReportsFetcher,
): Promise<SubscriptionUsageResult> {
	try {
		let reports: UsageReport[] | null;

		if (fetcherOverride) {
			reports = await fetcherOverride();
		} else {
			const [authStorage, registry] = await Promise.all([getDeckAuthStorage(), getDeckModelRegistry()]);
			reports = await authStorage.fetchUsageReports({
				baseUrlResolver: (provider) => registry.getProviderBaseUrl(provider),
			});
		}

		if (!reports || reports.length === 0) {
			return { available: false, reason: "no provider usage data available" };
		}

		// Collect all limits that carry a usedFraction, dedup by limitId (same
		// window can appear on multiple accounts — keep the highest fraction seen).
		const byId = new Map<string, { fraction: number; label: string; resetsAt?: number; windowDurationMs?: number }>();
		for (const report of reports) {
			for (const limit of report.limits) {
				const fraction = resolveUsedFraction(limit);
				if (fraction === undefined) continue;
				const existing = byId.get(limit.id);
				if (existing === undefined || fraction > existing.fraction) {
					byId.set(limit.id, {
						fraction,
						label: limit.label,
						resetsAt: limit.window?.resetsAt,
						windowDurationMs: limit.window?.durationMs,
					});
				}
			}
		}

		// Sort shortest window first so callers can find the session (5h) limit
		// at index 0 and the weekly (7d) limit further along.
		const sorted = [...byId.values()].sort((a, b) => {
			const da = a.windowDurationMs ?? Number.POSITIVE_INFINITY;
			const db = b.windowDurationMs ?? Number.POSITIVE_INFINITY;
			return da - db;
		});

		// Build the wire-format limits array.
		const limits = sorted.map((entry) => ({
			label: entry.label,
			pctUsed: Math.min(100, Math.max(0, entry.fraction * 100)),
			resetAt: entry.resetsAt != null ? new Date(entry.resetsAt).toISOString() : new Date().toISOString(),
			...(entry.windowDurationMs != null ? { windowDurationMs: entry.windowDurationMs } : {}),
		}));

		// Top-level pctUsed / resetAt = most-constraining limit (highest fraction).
		const worst = sorted.reduce(
			(best, entry) => (entry.fraction > best.fraction ? entry : best),
			sorted[0] ?? { fraction: 0, resetsAt: undefined },
		);

		return {
			available: true,
			limits,
			pctUsed: Math.min(100, Math.max(0, worst.fraction * 100)),
			resetAt: worst.resetsAt != null ? new Date(worst.resetsAt).toISOString() : new Date().toISOString(),
		};
	} catch (err) {
		log.warn("failed to fetch subscription usage", err);
		return {
			available: false,
			reason: `request failed: ${(err as Error)?.message ?? String(err)}`,
		};
	}
}
