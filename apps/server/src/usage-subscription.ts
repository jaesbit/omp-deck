/**
 * Anthropic subscription (rate-limit) usage — `GET /api/usage/subscription`.
 *
 * Anthropic does not expose a single documented endpoint that returns "% of
 * plan consumed right now" + a reset timestamp the way this ticket's shape
 * implies. What IS documented (https://docs.claude.com/en/api/rate-limits):
 * every Messages API response carries `anthropic-ratelimit-tokens-limit`,
 * `anthropic-ratelimit-tokens-remaining`, and `anthropic-ratelimit-tokens-reset`
 * (RFC 3339) headers describing the org's current token-bucket state for the
 * most restrictive active limit. The Admin "Usage & Cost" and "Rate Limits"
 * APIs were also investigated (see PR description) but only expose historical
 * reports and static configured limits respectively — neither gives a live
 * used/limit/resetAt triple. We derive the response from the rate-limit
 * headers on a minimal, real Messages API call.
 */

import { logger } from "./log.ts";

const log = logger("usage-subscription");

export interface SubscriptionUsageAvailable {
	available: true;
	used: number;
	limit: number;
	pctUsed: number;
	resetAt: string;
}

export interface SubscriptionUsageUnavailable {
	available: false;
	reason: string;
}

export type SubscriptionUsageResult = SubscriptionUsageAvailable | SubscriptionUsageUnavailable;

const CACHE_TTL_MS = 60_000;
const ANTHROPIC_VERSION = "2023-06-01";
// Smallest, cheapest model in the catalog — this call exists purely to read
// the rate-limit headers off a real response, not to use the completion.
const PROBE_MODEL = "claude-haiku-4-5";

interface CacheEntry {
	result: SubscriptionUsageResult;
	fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<SubscriptionUsageResult> | null = null;

/** Test-only: drop the cache/in-flight state between test cases. */
export function resetSubscriptionUsageCacheForTests(): void {
	cache = null;
	inFlight = null;
}

/**
 * Cached + request-coalesced subscription usage lookup. Two calls within the
 * same TTL window (or concurrent calls while a request is in flight) share a
 * single Anthropic request.
 */
export async function getSubscriptionUsage(
	fetchImpl: typeof fetch = fetch,
	now: number = Date.now(),
): Promise<SubscriptionUsageResult> {
	if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
		return cache.result;
	}
	if (inFlight) return inFlight;

	inFlight = fetchSubscriptionUsage(fetchImpl)
		.then((result) => {
			cache = { result, fetchedAt: Date.now() };
			return result;
		})
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

/**
 * Performs the real Anthropic call and parses rate-limit headers. Exported
 * separately from the cache wrapper so tests can stub `fetchImpl` without
 * touching module-level cache state directly.
 *
 * // TODO(verify): confirm exact Anthropic usage endpoint + response shape
 * // against live API. This assumes a minimal Messages API request carries the
 * // same `anthropic-ratelimit-tokens-*` headers documented for general
 * // Messages API traffic; it has not been confirmed against a live call with
 * // a real Admin/API key in this environment.
 */
export async function fetchSubscriptionUsage(fetchImpl: typeof fetch = fetch): Promise<SubscriptionUsageResult> {
	const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
	if (!apiKey) {
		return { available: false, reason: "ANTHROPIC_API_KEY is not configured" };
	}

	let res: Response;
	try {
		res = await fetchImpl("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": ANTHROPIC_VERSION,
				"x-api-key": apiKey,
			},
			body: JSON.stringify({
				model: PROBE_MODEL,
				max_tokens: 1,
				messages: [{ role: "user", content: "." }],
			}),
		});
	} catch (err) {
		log.warn("request to Anthropic failed", err);
		return { available: false, reason: `request failed: ${(err as Error)?.message ?? String(err)}` };
	}

	if (res.status === 401 || res.status === 403) {
		// Drain the body so undici/bun don't warn about an unconsumed stream.
		await res.text().catch(() => undefined);
		return { available: false, reason: "API key lacks usage/messages access" };
	}
	if (!res.ok && res.status !== 400) {
		// A 400 (e.g. invalid probe payload) still carries rate-limit headers on
		// most Anthropic error responses; anything else is treated as unavailable.
		await res.text().catch(() => undefined);
		return { available: false, reason: `Anthropic returned HTTP ${res.status}` };
	}
	await res.text().catch(() => undefined);

	const limitHeader = res.headers.get("anthropic-ratelimit-tokens-limit");
	const remainingHeader = res.headers.get("anthropic-ratelimit-tokens-remaining");
	const resetHeader = res.headers.get("anthropic-ratelimit-tokens-reset");

	if (!limitHeader || !remainingHeader || !resetHeader) {
		return { available: false, reason: "response did not include rate-limit usage headers" };
	}

	const limit = Number(limitHeader);
	const remaining = Number(remainingHeader);
	const resetAtMs = Date.parse(resetHeader);
	if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining) || !Number.isFinite(resetAtMs)) {
		return { available: false, reason: "rate-limit usage headers were malformed" };
	}

	const used = Math.max(0, limit - remaining);
	const pctUsed = Math.min(100, Math.max(0, (used / limit) * 100));
	return {
		available: true,
		used,
		limit,
		pctUsed,
		resetAt: new Date(resetAtMs).toISOString(),
	};
}
