/**
 * Focused tests for the `POST /sessions` (T-39) and `PUT /workspace-preferences`
 * (T-42) additions in `routes.ts`: model validation, the `resumeFromPath` +
 * model/planMode combo rejection, and workspace-default-model precedence.
 *
 * Exercises the real Hono router via `app.request()` with a hand-rolled
 * `AgentBridge` stub — no real SDK/model registry involved, matching the
 * project's existing convention of unit-testing state machines with
 * hand-rolled surfaces (see `plan-mode-bridge.test.ts`) rather than spinning
 * up the full server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Config } from "./config.ts";
import { closeDb, openDb } from "./db/index.ts";
import { buildRouter } from "./routes.ts";
import type { AgentBridge, CreateSessionOpts, SessionHandle } from "./bridge/types.ts";
import { broadcastBus, type BroadcastFrame } from "./broadcast-bus.ts";
import type { ModelInfo } from "@omp-deck/protocol";

let dbDir: string | null = null;
let createCalls: CreateSessionOpts[] = [];

function fakeBridge(models: ModelInfo[]): AgentBridge {
	createCalls = [];
	return {
		async createSession(opts: CreateSessionOpts) {
			createCalls.push(opts);
			return {
				sessionId: "sess-1",
				sessionFile: "/tmp/sess-1.jsonl",
				cwd: opts.cwd,
			} as unknown as ReturnType<AgentBridge["createSession"]> extends Promise<infer T> ? T : never;
		},
		async resumeSession() {
			throw new Error("not exercised in this suite");
		},
		getSession() {
			return undefined;
		},
		async listSessions() {
			return [];
		},
		async deleteSession() {
			return { deleted: false };
		},
		trackSubscriberAdded() {},
		trackSubscriberRemoved() {},
		bumpActivity() {},
		async listModels() {
			return models;
		},
		subscribeUiFrames() {
			return () => {};
		},
		respondToUiDialog() {},
		subscribePlanModeFrames() {
			return () => {};
		},
		async respondToPlanApproval() {
			return "unknown" as const;
		},
		async dispose() {},
	} as unknown as AgentBridge;
}

function fakeConfig(defaultCwd: string): Config {
	return {
		host: "127.0.0.1",
		port: 0,
		defaultCwd,
		extraWorkspaces: [],
		devMode: true,
		idleTimeoutMs: 0,
		dbPath: ":memory:",
		uploadsRoot: path.join(os.tmpdir(), "omp-deck-uploads-test"),
		autoStartCommand: null,
	};
}

const noopService = {} as never;

function buildTestApp(bridge: AgentBridge, cwd: string) {
	return buildRouter(
		bridge,
		fakeConfig(cwd),
		noopService,
		noopService,
		noopService,
		noopService,
		noopService,
	);
}

const AVAILABLE_MODEL: ModelInfo = {
	provider: "anthropic",
	id: "claude-good",
	label: "Claude Good",
	isAvailable: true,
};
const UNAUTHED_MODEL: ModelInfo = {
	provider: "anthropic",
	id: "claude-noauth",
	label: "Claude No Auth",
	isAvailable: false,
};

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-sessions-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
});

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		dbDir = null;
	}
});

describe("POST /sessions — T-39 validation", () => {
	test("rejects model combined with resumeFromPath", async () => {
		const app = buildTestApp(fakeBridge([AVAILABLE_MODEL]), process.cwd());
		const res = await app.request("/sessions", {
			method: "POST",
			body: JSON.stringify({ resumeFromPath: "/tmp/x.jsonl", model: { provider: "anthropic", id: "claude-good" } }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/cannot be combined with resumeFromPath/);
	});

	test("rejects planMode combined with resumeFromPath", async () => {
		const app = buildTestApp(fakeBridge([AVAILABLE_MODEL]), process.cwd());
		const res = await app.request("/sessions", {
			method: "POST",
			body: JSON.stringify({ resumeFromPath: "/tmp/x.jsonl", planMode: true }),
		});
		expect(res.status).toBe(400);
	});

	test("rejects an unknown model", async () => {
		const app = buildTestApp(fakeBridge([AVAILABLE_MODEL]), process.cwd());
		const res = await app.request("/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: process.cwd(), model: { provider: "nope", id: "nope" } }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/unknown model/);
	});

	test("rejects a model without configured auth", async () => {
		const app = buildTestApp(fakeBridge([UNAUTHED_MODEL]), process.cwd());
		const res = await app.request("/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: process.cwd(), model: { provider: "anthropic", id: "claude-noauth" } }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/no auth configured/);
	});

	test("creates with an explicit valid model and planMode", async () => {
		const bridge = fakeBridge([AVAILABLE_MODEL]);
		const app = buildRouter(bridge, fakeConfig(process.cwd()), noopService, noopService, noopService, noopService, noopService);
		const res = await app.request("/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: process.cwd(),
				model: { provider: "anthropic", id: "claude-good" },
				planMode: true,
			}),
		});
		expect(res.status).toBe(200);
		expect(createCalls).toHaveLength(1);
		expect(createCalls[0]?.model).toEqual({ provider: "anthropic", id: "claude-good" });
		expect(createCalls[0]?.planMode).toBe(true);
	});

	test("falls back to the workspace default model when none is given explicitly", async () => {
		const cwd = process.cwd();
		const bridge = fakeBridge([AVAILABLE_MODEL]);
		const app = buildTestApp(bridge, cwd);

		const putRes = await app.request(`/workspace-preferences?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "anthropic", id: "claude-good" } }),
		});
		expect(putRes.status).toBe(200);

		const res = await app.request("/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd }),
		});
		expect(res.status).toBe(200);
		expect(createCalls[0]?.model).toEqual({ provider: "anthropic", id: "claude-good" });
	});

	test("explicit model wins over the workspace default", async () => {
		const cwd = process.cwd();
		const bridge = fakeBridge([
			AVAILABLE_MODEL,
			{ provider: "anthropic", id: "claude-explicit", label: "Explicit", isAvailable: true },
		]);
		const app = buildTestApp(bridge, cwd);

		await app.request(`/workspace-preferences?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "anthropic", id: "claude-good" } }),
		});

		const res = await app.request("/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd, model: { provider: "anthropic", id: "claude-explicit" } }),
		});
		expect(res.status).toBe(200);
		expect(createCalls[0]?.model).toEqual({ provider: "anthropic", id: "claude-explicit" });
	});
});

describe("PUT /workspace-preferences — T-42", () => {
	test("rejects an invalid model the same way session creation does", async () => {
		const cwd = process.cwd();
		const app = buildTestApp(fakeBridge([AVAILABLE_MODEL]), cwd);
		const res = await app.request(`/workspace-preferences?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "nope", id: "nope" } }),
		});
		expect(res.status).toBe(400);
	});

	test("model: null clears an existing override", async () => {
		const cwd = process.cwd();
		const app = buildTestApp(fakeBridge([AVAILABLE_MODEL]), cwd);
		await app.request(`/workspace-preferences?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "anthropic", id: "claude-good" } }),
		});
		const clearRes = await app.request(`/workspace-preferences?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ model: null }),
		});
		expect(clearRes.status).toBe(200);

		const listRes = await app.request("/workspace-preferences");
		const { preferences } = (await listRes.json()) as { preferences: Array<{ cwd: string; model?: unknown }> };
		expect(preferences.find((p) => p.cwd === cwd)).toBeUndefined();
	});

	test("GET /workspaces surfaces the stored default model", async () => {
		const cwd = process.cwd();
		const bridge = fakeBridge([AVAILABLE_MODEL]);
		const app = buildTestApp(bridge, cwd);
		await app.request(`/workspace-preferences?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "anthropic", id: "claude-good" } }),
		});
		const res = await app.request("/workspaces");
		const { workspaces } = (await res.json()) as {
			workspaces: Array<{ cwd: string; defaultModel?: { provider: string; id: string } }>;
		};
		const entry = workspaces.find((w) => w.cwd === cwd);
		expect(entry?.defaultModel).toEqual({ provider: "anthropic", id: "claude-good" });
	});
});

describe("DELETE /sessions/:id — T-47", () => {
	test("unknown id 404s without broadcasting", async () => {
		const frames: BroadcastFrame[] = [];
		const unsub = broadcastBus.subscribe((f) => frames.push(f));
		try {
			const bridge: AgentBridge = {
				...fakeBridge([]),
				async deleteSession() {
					return { deleted: false };
				},
			};
			const app = buildTestApp(bridge, process.cwd());
			const res = await app.request("/sessions/does-not-exist", { method: "DELETE" });
			expect(res.status).toBe(404);
			expect(frames.some((f) => f.type === "sessions_changed")).toBe(false);
		} finally {
			unsub();
		}
	});

	test("known id (live or persisted) succeeds and broadcasts sessions_changed", async () => {
		const frames: BroadcastFrame[] = [];
		const unsub = broadcastBus.subscribe((f) => frames.push(f));
		try {
			const bridge: AgentBridge = {
				...fakeBridge([]),
				async deleteSession(id: string) {
					return { deleted: true, sessionPath: `/tmp/${id}.jsonl` };
				},
			};
			const app = buildTestApp(bridge, process.cwd());
			const res = await app.request("/sessions/sess-1", { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
			expect(frames.some((f) => f.type === "sessions_changed")).toBe(true);
		} finally {
			unsub();
		}
	});
});

describe("GET /sessions/:id/history", () => {
	/**
	 * Bridge whose single live session records the (before, limit) pairs the
	 * route forwards, following the T-47 spread-and-override pattern. The
	 * handle fake is partial — the route only ever touches `getHistory`.
	 */
	function historyBridge(): { bridge: AgentBridge; calls: Array<{ before: number; limit: number }> } {
		const calls: Array<{ before: number; limit: number }> = [];
		const handle = {
			getHistory(before: number, limit: number) {
				calls.push({ before, limit });
				return { messages: [{ role: "user", content: "m0" }], startIndex: 7 };
			},
		} as unknown as SessionHandle;
		const bridge: AgentBridge = {
			...fakeBridge([]),
			getSession: (id: string) => (id === "sess-live" ? handle : undefined),
		};
		return { bridge, calls };
	}

	test("404s when the session is not active", async () => {
		const { bridge } = historyBridge();
		const app = buildTestApp(bridge, process.cwd());
		const res = await app.request("/sessions/does-not-exist/history?before=5");
		expect(res.status).toBe(404);
	});

	test("400s on a missing, negative, or non-numeric before index without touching the handle", async () => {
		const { bridge, calls } = historyBridge();
		const app = buildTestApp(bridge, process.cwd());
		for (const query of ["", "?before=-1", "?before=abc"]) {
			const res = await app.request(`/sessions/sess-live/history${query}`);
			expect(res.status).toBe(400);
		}
		expect(calls).toEqual([]);
	});

	test("forwards before/limit to the live handle and returns its page as JSON", async () => {
		const { bridge, calls } = historyBridge();
		const app = buildTestApp(bridge, process.cwd());
		const res = await app.request("/sessions/sess-live/history?before=42&limit=3");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ messages: [{ role: "user", content: "m0" }], startIndex: 7 });
		expect(calls).toEqual([{ before: 42, limit: 3 }]);
	});

	test("before=0 is a valid cursor (empty page request, not an error)", async () => {
		const { bridge, calls } = historyBridge();
		const app = buildTestApp(bridge, process.cwd());
		const res = await app.request("/sessions/sess-live/history?before=0");
		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.before).toBe(0);
	});

	test("clamps limit into [1, 500] and never forwards a non-finite one", async () => {
		const { bridge, calls } = historyBridge();
		const app = buildTestApp(bridge, process.cwd());

		await app.request("/sessions/sess-live/history?before=10&limit=9999");
		await app.request("/sessions/sess-live/history?before=10&limit=0");
		await app.request("/sessions/sess-live/history?before=10&limit=-3");
		expect(calls.map((c) => c.limit)).toEqual([500, 1, 1]);

		// Omitted limit: the default is a tunable, so pin only the contract —
		// a finite value already inside the clamp range reaches the handle.
		await app.request("/sessions/sess-live/history?before=10");
		const forwarded = calls[3]?.limit ?? Number.NaN;
		expect(Number.isFinite(forwarded)).toBe(true);
		expect(forwarded).toBeGreaterThanOrEqual(1);
		expect(forwarded).toBeLessThanOrEqual(500);
	});
});
