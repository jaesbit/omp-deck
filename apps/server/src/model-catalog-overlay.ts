/**
 * Server-side shadowing overlay for the SDK's `ModelRegistry`.
 *
 * # Why this exists (T-74)
 *
 * The deck's model picker (`apps/web/src/lib/model-catalog.ts`) fetches
 * `GET /models` which delegates to the SDK's `ModelRegistry.getAll()`. The
 * registry is built once per process from `models.yml` + a one-shot online
 * refresh (`apps/server/src/auth-singleton.ts`) and **stays cached for the
 * process lifetime** (default provider-cache TTL is 24h). There is no
 * automatic eviction on error: when a model the provider has retired
 * upstream or whose auth went stale is fed to the user, the agent fails
 * mid-turn with a 4xx/404 and the user can't tell why. We have to
 * detect-and-hide at the source so the user never gets a chance to pick
 * a dead entry.
 *
 * # What this module does
 *
 * `ModelCatalogOverlay` wraps the registry and maintains an in-memory
 * **shadow set**: models that have failed at the bridge layer (or that
 * the upstream has dropped entirely) are excluded from `getModels()` for
 * a configurable TTL (`OMP_DECK_MODEL_SHADOW_TTL_MS`, default 24h). On
 * expiry the shadow is automatically re-tried on the next online refresh.
 *
 * Two paths populate the shadow:
 *
 * 1. **Upstream-driven**: `refresh()` re-runs the registry refresh. Any
 *    model that previously existed in the working set but is no longer
 *    present upstream is treated as `removed` and shadowed permanently
 *    (until a future refresh brings it back). The "user said: must be
 *    transparent" requirement is satisfied here: a retired model simply
 *    disappears from the picker on the next modal open, no UI change.
 * 2. **Failure-driven**: `recordFailure({provider, id, error})` is called
 *    by the bridge layer when a `prompt()` (or its SDK equivalent)
 *    rejects with a classified error. `not_found` and `unauthorized`
 *    shadow the model; `server` and `unknown` do not (could be a flake).
 *    `recordSuccess({provider, id})` clears the shadow for that pair on
 *    the next successful turn, so a model that comes back online is
 *    re-surfaced without a server restart.
 *
 * # Process-wide state
 *
 * The overlay is a process-wide singleton (`getModelCatalogOverlay()`).
 * The shadow set is in-memory only — it intentionally does NOT survive a
 * process restart, because:
 * - On restart the registry re-reads `models.yml` + does a fresh online
 *   refresh anyway, which is the real source of truth.
 * - Persistence would mean restoring shadows from a previous process
 *   whose underlying problem may already be fixed (e.g. user re-authed).
 * - A `OOM`/`kill -9` of a healthy process mid-incident shouldn't poison
 *   the next process's picker.
 *
 * If the team later wants persistence (e.g. for an ops dashboard), the
 * `ShadowEntry` shape is the right unit of storage; this module
 * deliberately doesn't take that on now.
 */
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { getDeckModelRegistry } from "./auth-singleton.ts";
import { logger } from "./log.ts";

const log = logger("model-catalog");

/**
 * Why a model is in the shadow set. Drives whether a future success can
 * revive it and how the entry expires.
 *
 * - `upstream_removed`: registry stopped reporting the model. Stays
 *   shadowed until the registry brings it back on a future refresh.
 * - `not_found`: prompt() returned a 404 / `model_not_found`. Stays
 *   shadowed until TTL or a successful call.
 * - `unauthorized`: prompt() returned 401 / `invalid_api_key`. Same
 *   semantics as not_found; the next successful call clears the shadow.
 */
export type ShadowReason = "upstream_removed" | "not_found" | "unauthorized";

export interface ShadowEntry {
	provider: string;
	id: string;
	reason: ShadowReason;
	firstSeenAt: number;
	lastFailureAt: number;
	/** Number of distinct failure events (not retry attempts). */
	count: number;
	/**
	 * Most recent error message captured at shadow time. Useful for ops
	 * introspection via `listShadowed()`. Not surfaced to users.
	 */
	errorMessage: string;
}

export interface ShadowKey {
	provider: string;
	id: string;
}

export type ClassifiedErrorKind = "not_found" | "unauthorized" | "server" | "unknown";

export interface ClassifiedError {
	kind: ClassifiedErrorKind;
	retriable: boolean;
}

/**
 * Read-only view of a model as known to the overlay. We deliberately
 * model this independently of the SDK's `SdkModel` so the overlay can
 * be tested with a stub registry that returns plain `Model` shapes
 * (and so the contract is small).
 */
export interface OverlayModel {
	provider: string;
	id: string;
}

export interface ModelCatalogConfig {
	/** Shadow TTL in ms; defaults to 24h to mirror the SDK provider cache. */
	shadowTtlMs: number;
	/** When true, the overlay is a transparent pass-through (no shadowing). */
	disabled: boolean;
	/** Clock for tests; defaults to `Date.now`. */
	now: () => number;
}

/**
 * Minimal subset of the SDK's `ModelRegistry` that this overlay needs.
 * Defined as a structural type so tests can pass a stub and so the
 * overlay doesn't drag the entire SDK type graph into its signature.
 */
export interface RegistryLike {
	getAll(): Array<{ provider: string | { toString(): string }; id: string }>;
	refresh(mode: "online" | "online-if-uncached" | "offline"): Promise<unknown>;
}

const DEFAULT_SHADOW_TTL_MS = 24 * 60 * 60 * 1000;

function readEnvNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readEnvBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	return raw === "1" || raw.toLowerCase() === "true";
}

function defaultConfig(): ModelCatalogConfig {
	return {
		shadowTtlMs: readEnvNumber("OMP_DECK_MODEL_SHADOW_TTL_MS", DEFAULT_SHADOW_TTL_MS),
		disabled: readEnvBool("OMP_DECK_MODEL_SHADOW_DISABLE", false),
		now: () => Date.now(),
	};
}

/**
 * Classify an error thrown by the bridge layer (SDK prompt / setModel /
 * anything that surfaces a provider response). The classifier is
 * deliberately best-effort — it pattern-matches on the SDK's known error
 * shapes (status codes, message substrings) rather than depending on a
 * typed error class, because the SDK's error surface is heterogeneous
 * and not formally typed.
 *
 * The mapping is intentionally conservative: only the two cases that
 * mean "this model is gone for the foreseeable future" feed into the
 * shadow set (`not_found`, `unauthorized`). `server` (5xx, overload,
 * timeout) and `unknown` are returned with `retriable: true` so callers
 * can distinguish, but `recordFailure` will not shadow on them.
 */
export function classifyModelError(err: unknown): ClassifiedError {
	const message = err instanceof Error ? err.message : String(err ?? "");
	const lower = message.toLowerCase();
	const status = ((): number | undefined => {
		if (err && typeof err === "object") {
			const e = err as { status?: unknown; statusCode?: unknown };
			if (typeof e.status === "number") return e.status;
			if (typeof e.statusCode === "number") return e.statusCode;
		}
		// Heuristic: an explicit "HTTP <code>" or "status <code>" mention.
		const m = /(?:\bstatus[: ]+|\bhttp[ /])(\d{3})\b/i.exec(message);
		if (m) {
			const n = Number(m[1]);
			if (Number.isFinite(n)) return n;
		}
		return undefined;
	})();

	// Order matters: 401 is technically a "client error" but for model
	// availability it's more useful to call it `unauthorized` than a
	// generic 4xx, so it goes first.
	if (status === 401 || status === 403) {
		return { kind: "unauthorized", retriable: false };
	}
	if (status === 404) {
		return { kind: "not_found", retriable: false };
	}
	if (lower.includes("model_not_found") || lower.includes("model not found")) {
		return { kind: "not_found", retriable: false };
	}
	if (
		lower.includes("invalid_api_key") ||
		lower.includes("invalid api key") ||
		lower.includes("incorrect api key") ||
		lower.includes("unauthorized") ||
		lower.includes("authentication failed")
	) {
		return { kind: "unauthorized", retriable: false };
	}
	if (typeof status === "number" && status >= 500) {
		return { kind: "server", retriable: true };
	}
	if (lower.includes("overloaded") || lower.includes("rate limit") || lower.includes("timeout")) {
		return { kind: "server", retriable: true };
	}
	return { kind: "unknown", retriable: true };
}

function keyOf(model: OverlayModel): string {
	return `${model.provider}/${model.id}`;
}

/**
 * The overlay. Exposed both as a class (for tests) and through the
 * `getModelCatalogOverlay()` singleton (for production).
 *
 * Concurrency: all methods take a single-process `this.shadow` `Map`
 * which is mutated in-place. Bridge code calls `recordFailure` /
 * `recordSuccess` from the prompt() promise chain; `getModels` is
 * called from the GET /models request handler. Because Node is
 * single-threaded and these operations are O(n) on a small set, no
 * additional locking is needed — interleavings preserve the intended
 * "most recent call wins" semantics. If we ever move to worker threads
 * this would need a `Map` swap or a mutex.
 */
export class ModelCatalogOverlay {
	private readonly shadow = new Map<string, ShadowEntry>();
	/** Snapshot of the model list as of the last `getModels()` call. */
	private lastSnapshot: OverlayModel[] = [];
	private hasSnapshot = false;

	constructor(
		private readonly getRegistry: () => Promise<RegistryLike>,
		private readonly config: ModelCatalogConfig = defaultConfig(),
	) {}

	/** Returns the currently visible model set (after shadow filtering). */
	async getModels(): Promise<OverlayModel[]> {
		const registry = await this.getRegistry();
		const all = registry.getAll().map((m) => ({
			provider: String(m.provider),
			id: m.id,
		}));
		// Snapshot the full registry contents (NOT the filtered view) so
		// `refresh()` can detect both "model disappeared upstream" and
		// "model came back upstream" without losing the filter bias.
		this.lastSnapshot = all;
		this.hasSnapshot = true;

		if (this.config.disabled) return all;

		// Sweep expired shadows. Models whose shadow has aged out are
		// re-included; the next prompt() success or failure will update
		// their entry again.
		const now = this.config.now();
		for (const [k, entry] of this.shadow) {
			if (now - entry.lastFailureAt > this.config.shadowTtlMs) {
				this.shadow.delete(k);
			}
		}

		// Auto-revive upstream-removed shadows when the model is back in
		// the registry. Failure-driven shadows (not_found / unauthorized)
		// are not auto-revived here — the user's next successful call to
		// the same model is what clears them via `recordSuccess`.
		for (const m of all) {
			const k = keyOf(m);
			const entry = this.shadow.get(k);
			if (entry && entry.reason === "upstream_removed") {
				this.shadow.delete(k);
				log.info("un-shadowed model returned upstream", { provider: m.provider, id: m.id });
			}
		}

		return all.filter((m) => !this.shadow.has(keyOf(m)));
	}

	/**
	 * Run an online refresh of the underlying registry and reconcile the
	 * shadow set: any model that was previously visible but is no longer
	 * in the new registry working set is added to the shadow with reason
	 * `upstream_removed` (stays until upstream brings it back or until
	 * the operator calls `clearShadow`). Returns the new visible set.
	 */
	async refresh(opts: { forceOnline?: boolean } = {}): Promise<OverlayModel[]> {
		const registry = await this.getRegistry();
		await registry.refresh(opts.forceOnline ? "online" : "online-if-uncached");
		const before = this.hasSnapshot ? new Set(this.lastSnapshot.map(keyOf)) : new Set<string>();
		const visible = await this.getModels();
		const after = new Set(visible.map(keyOf));

		if (before.size > 0 && this.config.disabled === false) {
			for (const k of before) {
				if (after.has(k)) continue;
				const [provider, id] = k.split("/", 2);
				if (!provider || !id) continue;
				// Don't downgrade a more specific shadow reason to
				// `upstream_removed` — keep the existing entry intact.
				if (this.shadow.has(k)) continue;
				this.shadow.set(k, {
					provider,
					id,
					reason: "upstream_removed",
					firstSeenAt: this.config.now(),
					lastFailureAt: this.config.now(),
					count: 1,
					errorMessage: "no longer reported by upstream",
				});
				log.info("shadowed model removed upstream", { provider, id });
			}
		}

		return visible;
	}

	/**
	 * Record a model-level failure. Only `not_found` and `unauthorized`
	 * shadow; other classifications are logged but ignored (so a
	 * transient 5xx doesn't hide a working model for 24h).
	 *
	 * Returns `true` if the model is now shadowed, `false` if the error
	 * was classified but deemed retriable (caller may want to surface
	 * this to a future metric or telemetry path).
	 */
	recordFailure(model: OverlayModel, error: unknown, classified = classifyModelError(error)): boolean {
		if (classified.kind === "server" || classified.kind === "unknown") {
			log.debug("ignoring non-shadowing model failure", {
				provider: model.provider,
				id: model.id,
				kind: classified.kind,
			});
			return false;
		}
		const k = keyOf(model);
		const reason: ShadowReason = classified.kind;
		const now = this.config.now();
		const existing = this.shadow.get(k);
		const errorMessage = error instanceof Error ? error.message : String(error ?? "");
		if (existing) {
			existing.lastFailureAt = now;
			existing.count += 1;
			// Keep the most specific reason: a `not_found` observed after
			// an `unauthorized` is still a hard "gone" signal.
			existing.reason = reason;
			existing.errorMessage = errorMessage;
		} else {
			this.shadow.set(k, {
				provider: model.provider,
				id: model.id,
				reason,
				firstSeenAt: now,
				lastFailureAt: now,
				count: 1,
				errorMessage,
			});
		}
		log.info("shadowed model after failure", {
			provider: model.provider,
			id: model.id,
			reason,
		});
		return true;
	}

	/**
	 * Record a successful turn for a model. Clears any active shadow
	 * for the pair (auto-revival). Intended to be called from the
	 * bridge's `agent_end` success path.
	 */
	recordSuccess(model: OverlayModel): void {
		const k = keyOf(model);
		if (this.shadow.delete(k)) {
			log.info("un-shadowed model after success", { provider: model.provider, id: model.id });
		}
	}

	/** Manually clear a shadow entry (operator action; e.g. user re-authed). */
	clearShadow(model: ShadowKey): boolean {
		return this.shadow.delete(keyOf(model));
	}

	/** Drop every shadow entry. Used by tests and by an ops endpoint. */
	clearAllShadows(): void {
		this.shadow.clear();
	}

	/** Snapshot the active shadow set. Order is implementation-defined. */
	listShadowed(): ShadowEntry[] {
		return Array.from(this.shadow.values());
	}

	/**
	 * Test seam: replace the active shadow set. Intended for unit tests
	 * that want a pre-seeded state. Does NOT trigger any side effects
	 * (no log line, no refresh). Each entry's `lastFailureAt` and
	 * `firstSeenAt` are rewritten to the current clock so the TTL
	 * sweep in `getModels()` doesn't immediately delete the seed.
	 */
	__setShadowForTesting(entries: ShadowEntry[]): void {
		this.shadow.clear();
		const now = this.config.now();
		for (const e of entries) {
			this.shadow.set(keyOf(e), { ...e, firstSeenAt: now, lastFailureAt: now });
		}
	}

	isDisabled(): boolean {
		return this.config.disabled;
	}

	getConfig(): Readonly<ModelCatalogConfig> {
		return { ...this.config };
	}
}

let singleton: ModelCatalogOverlay | undefined;

/**
 * Process-wide singleton. Bridges import this and call
 * `await getModelCatalogOverlay().getModels()`. The first call wires the
 * default registry provider; tests can call `__setModelCatalogOverlayForTesting`
 * to substitute a stub.
 */
export function getModelCatalogOverlay(): ModelCatalogOverlay {
	if (!singleton) {
		singleton = new ModelCatalogOverlay(async () => {
			const r = await getDeckModelRegistry();
			return r as unknown as RegistryLike;
		});
	}
	return singleton;
}

export function __setModelCatalogOverlayForTesting(overlay: ModelCatalogOverlay | undefined): void {
	singleton = overlay;
}
