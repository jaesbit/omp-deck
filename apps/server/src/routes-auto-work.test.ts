/**
 * Exercises the real Hono router for `/auto-work/*` (T-60): defaults when
 * unconfigured, persistence across a simulated restart (close + reopen the
 * same on-disk DB file), and server-side validation of the PUT body.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AutoWorkConfig, ModelInfo, SetAutoWorkConfigRequest } from "@omp-deck/protocol";

import { closeDb, openDb } from "./db/index.ts";
import { buildAutoWorkRouter } from "./routes-auto-work.ts";
import type { AgentBridge } from "./bridge/types.ts";

let dbDir: string;
let dbPath: string;

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

function fakeBridge(models: ModelInfo[]): AgentBridge {
	return {
		async listModels() {
			return models;
		},
	} as unknown as AgentBridge;
}

function fullConfigBody(overrides: Partial<SetAutoWorkConfigRequest> = {}): SetAutoWorkConfigRequest {
	return {
		enabled: true,
		modelByPriority: { P0: null, P1: null, P2: null, P3: null, P4: null, P5: null },
		timeWindows: [{ start: 9, end: 17 }],
		sessionPctLimit: 25,
		weeklyPctLimit: 60,
		...overrides,
	};
}

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-auto-work-db-"));
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

describe("GET /auto-work/config", () => {
	test("requires a cwd query param", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const res = await app.request("/auto-work/config");
		expect(res.status).toBe(400);
	});

	test("accepts any absolute path (NFS, outside $HOME) — config is a pure DB key", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent("/mnt/nas/Public/openscad")}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as AutoWorkConfig;
		expect(body.workspaceCwd).toBe("/mnt/nas/Public/openscad");
		expect(body.enabled).toBe(false);
	});

	test("returns computed defaults when no config exists", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as AutoWorkConfig;
		expect(body.workspaceCwd).toBe(cwd);
		expect(body.enabled).toBe(false);
		expect(body.modelByPriority).toEqual({ P0: null, P1: null, P2: null, P3: null, P4: null, P5: null });
		expect(body.timeWindows).toEqual([{ start: 0, end: 24 }]);
		expect(body.sessionPctLimit).toBe(100);
		expect(body.weeklyPctLimit).toBe(100);
	});
});

describe("PUT /auto-work/config — validation", () => {
	test("rejects a missing cwd", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const res = await app.request("/auto-work/config", {
			method: "PUT",
			body: JSON.stringify(fullConfigBody()),
		});
		expect(res.status).toBe(400);
	});

	test("rejects invalid json", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	test("rejects a missing priority key in modelByPriority", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const cwd = process.cwd();
		const bad = fullConfigBody();
		delete (bad.modelByPriority as Record<string, unknown>).P3;
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(bad),
		});
		expect(res.status).toBe(400);
	});

	test("rejects overlapping timeWindows", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ timeWindows: [{ start: 0, end: 10 }, { start: 8, end: 14 }] })),
		});
		expect(res.status).toBe(400);
	});

	test("accepts multiple non-overlapping timeWindows", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ timeWindows: [{ start: 0, end: 6 }, { start: 13, end: 15 }, { start: 20, end: 24 }] })),
		});
		expect(res.status).toBe(200);
	});

	test("rejects an out-of-range pct limit", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ sessionPctLimit: 150 })),
		});
		expect(res.status).toBe(400);
	});

	test("rejects an unknown model override", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]));
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(
				fullConfigBody({ modelByPriority: { P0: { provider: "nope", id: "nope" }, P1: null, P2: null, P3: null, P4: null, P5: null } }),
			),
		});
		expect(res.status).toBe(400);
	});

	test("rejects a model override with no configured auth", async () => {
		const app = buildAutoWorkRouter(fakeBridge([UNAUTHED_MODEL]));
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(
				fullConfigBody({
					modelByPriority: {
						P0: { provider: "anthropic", id: "claude-noauth" },
						P1: null,
						P2: null,
						P3: null,
						P4: null,
						P5: null,
					},
				}),
			),
		});
		expect(res.status).toBe(400);
	});
});

describe("PUT /auto-work/config — persistence", () => {
	test("round-trips a full config through GET", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]));
		const cwd = process.cwd();
		const putRes = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(
				fullConfigBody({
					modelByPriority: {
						P0: { provider: "anthropic", id: "claude-good" },
						P1: null,
						P2: null,
						P3: null,
						P4: null,
						P5: null,
					},
				}),
			),
		});
		expect(putRes.status).toBe(200);

		const getRes = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
		const body = (await getRes.json()) as AutoWorkConfig;
		expect(body.enabled).toBe(true);
		expect(body.modelByPriority.P0).toEqual({ provider: "anthropic", id: "claude-good" });
		expect(body.modelByPriority.P1).toBeNull();
		expect(body.timeWindows).toEqual([{ start: 9, end: 17 }]);
		expect(body.sessionPctLimit).toBe(25);
		expect(body.weeklyPctLimit).toBe(60);
	});

	test("persists across a simulated server restart (close + reopen the DB file)", async () => {
		const cwd = process.cwd();
		const app1 = buildAutoWorkRouter(fakeBridge([]));
		await app1.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody()),
		});

		closeDb();
		openDb({ path: dbPath });

		const app2 = buildAutoWorkRouter(fakeBridge([]));
		const res = await app2.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
		const body = (await res.json()) as AutoWorkConfig;
		expect(body.enabled).toBe(true);
		expect(body.timeWindows).toEqual([{ start: 9, end: 17 }]);
		expect(body.sessionPctLimit).toBe(25);
		expect(body.weeklyPctLimit).toBe(60);
	});

	test("a second PUT replaces the prior config (upsert, not insert)", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]));
		const cwd = process.cwd();
		await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ enabled: true, sessionPctLimit: 25 })),
		});
		await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ enabled: false, sessionPctLimit: 80 })),
		});
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
		const body = (await res.json()) as AutoWorkConfig;
		expect(body.enabled).toBe(false);
		expect(body.sessionPctLimit).toBe(80);
	});
});
