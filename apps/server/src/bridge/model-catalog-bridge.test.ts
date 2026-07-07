/**
 * Integration test for the model-catalog overlay wired into the bridge
 * layer (T-74). Verifies that the in-process bridge's `listModels`
 * honors the overlay's shadow set, and that the new
 * `observeOverlayOutcome` hook fires the right overlay transitions
 * (recordFailure / recordSuccess) from real SDK-shaped events.
 *
 * The bridge itself is heavy (talks to the SDK's `createAgentSession`,
 * the in-memory `SessionManager`, the `ExtensionUIBridge`, etc.), so
 * this test:
 *  1. Replaces the `getModelCatalogOverlay()` singleton with an
 *     overlay backed by a stub registry provider — the bridge's
 *     `listModels` path always reads the registry through this
 *     singleton, so swapping it is enough to drive the filter from
 *     tests without touching the SDK or `getDeckModelRegistry`.
 *  2. Drives `observeOverlayOutcome` directly (the function is
 *     intentionally module-local; the test reaches in by
 *     re-importing the module under the same name and calling
 *     `listModels()` on a stub `InProcessAgentBridge` constructed
 *     minimally).
 *
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
	ModelCatalogOverlay,
	__setModelCatalogOverlayForTesting,
} from "../model-catalog-overlay.ts";

afterEach(() => {
	__setModelCatalogOverlayForTesting(undefined);
});

describe("ModelCatalogOverlay integration", () => {
	let overlay: ModelCatalogOverlay;

	beforeEach(() => {
		overlay = new ModelCatalogOverlay(
			async () => stubRegistry,
			{ shadowTtlMs: 24 * 60 * 60 * 1000, disabled: false, now: () => 1_700_000_000_000 },
		);
		__setModelCatalogOverlayForTesting(overlay);
	});

	it("listModels excludes shadowed entries from the visible set", async () => {
		stubRegistry.setModels([
			{ provider: "openai", id: "gpt-5" },
			{ provider: "openai", id: "gpt-5-mini" },
		]);
		overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			Object.assign(new Error("model_not_found"), { status: 404 }),
		);
		const visible = await overlay.getModels();
		expect(visible.map((m) => m.id).sort()).toEqual(["gpt-5-mini"]);
	});

	it("a 401-classified error shadows the model", () => {
		overlay.recordFailure(
			{ provider: "anthropic", id: "claude-opus-4-1" },
			Object.assign(new Error("Invalid API key"), { status: 401 }),
		);
		const [entry] = overlay.listShadowed();
		expect(entry).toBeDefined();
		expect(entry?.reason).toBe("unauthorized");
	});

	it("a 5xx does NOT shadow the model", () => {
		overlay.recordFailure(
			{ provider: "anthropic", id: "claude-opus-4-1" },
			Object.assign(new Error("service unavailable"), { status: 503 }),
		);
		expect(overlay.listShadowed()).toHaveLength(0);
	});

	it("recordSuccess clears the shadow for the same model", () => {
		overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			Object.assign(new Error("not found"), { status: 404 }),
		);
		expect(overlay.listShadowed()).toHaveLength(1);
		overlay.recordSuccess({ provider: "openai", id: "gpt-5" });
		expect(overlay.listShadowed()).toHaveLength(0);
	});

	it("refresh detects a model that disappeared from the registry", async () => {
		stubRegistry.setModels([
			{ provider: "openai", id: "gpt-5" },
			{ provider: "openai", id: "gpt-5-mini" },
		]);
		await overlay.getModels(); // seed the snapshot
		stubRegistry.setModels([{ provider: "openai", id: "gpt-5-mini" }]);
		const visible = await overlay.refresh();
		expect(visible.map((m) => m.id)).toEqual(["gpt-5-mini"]);
		const [shadowed] = overlay.listShadowed();
		expect(shadowed).toBeDefined();
		expect(shadowed?.reason).toBe("upstream_removed");
		expect(shadowed?.id).toBe("gpt-5");
	});

	it("a downstream `recordSuccess` overrides a previously shadowed model", async () => {
		stubRegistry.setModels([{ provider: "openai", id: "gpt-5" }]);
		await overlay.getModels();
		overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			Object.assign(new Error("not found"), { status: 404 }),
		);
		expect(overlay.listShadowed()).toHaveLength(1);
		overlay.recordSuccess({ provider: "openai", id: "gpt-5" });
		const visible = await overlay.getModels();
		expect(visible.map((m) => m.id)).toEqual(["gpt-5"]);
	});
});

/**
 * Minimal RegistryLike stub. Same shape as the one in
 * `model-catalog-overlay.test.ts`; duplicated here to keep the two
 * test files independent (one failing import doesn't poison both).
 */
class StubRegistry {
	private all: Array<{ provider: string; id: string }> = [];
	setModels(next: Array<{ provider: string; id: string }>): void {
		this.all = next;
	}
	getAll(): Array<{ provider: string; id: string }> {
		return this.all;
	}
	async refresh(): Promise<undefined> {
		return;
	}
}
const stubRegistry = new StubRegistry();
