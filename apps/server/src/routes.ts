import { Hono } from "hono";
import type {
	CreateSessionRequest,
	CreateSessionResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListWorkspacePreferencesResponse,
	ListWorkspacesResponse,
	ModelRef,
	RestartServerResponse,
	SessionHistoryResponse,
	SetWorkspacePreferenceRequest,
	WorkspaceEntry,
} from "@omp-deck/protocol";

import type { Config } from "./config.ts";
import { logger } from "./log.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { getBuildInfo, getUptimeSecs } from "./build-info.ts";
import { getUpdateCheck } from "./update-check.ts";
import type { AgentBridge } from "./bridge/types.ts";
import { getWorkspacePreference, listWorkspacePreferences, setWorkspacePreference } from "./db/workspace-preferences.ts";

const log = logger("routes");

import { buildTasksRouter } from "./routes-tasks.ts";
import { buildSettingsRouter } from "./routes-settings.ts";
import { buildRoutinesRouter } from "./routes-routines.ts";
import { buildHooksRouter } from "./routes-hooks.ts";
import { buildInboxRouter } from "./routes-inbox.ts";
import { buildUtilityRouter } from "./routes-cron.ts";
import { buildSlashCommandsRouter } from "./routes-slash-commands.ts";
import { buildFsRouter, isCwdAllowed } from "./routes-fs.ts";
import { buildBridgesRouter } from "./routes-bridges.ts";
import { buildMarketplaceRouter } from "./routes-marketplace.ts";
import { buildSkillsRouter } from "./routes-skills.ts";
import { buildKbRouter } from "./routes-kb.ts";
import { buildUploadsRouter } from "./routes-uploads.ts";
import { buildOrientationRouter } from "./routes-orientation.ts";
import { buildAuthOAuthRouter } from "./routes-auth-oauth.ts";
import { buildOnboardingRouter } from "./routes-onboarding.ts";
import { buildUsageRouter } from "./routes-usage.ts";
import { buildAutoWorkRouter } from "./routes-auto-work.ts";
import type { RoutinesRunner } from "./routines-runner.ts";
import type { BridgeSupervisor } from "./bridge-supervisor.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import type { SkillsService } from "./skills-service.ts";
import type { KbService } from "./kb-service.ts";

export function buildRouter(
	bridge: AgentBridge,
	config: Config,
	runner: RoutinesRunner,
	supervisor: BridgeSupervisor,
	marketplace: MarketplaceService,
	skills: SkillsService,
	kb: KbService,
	opts: { restartServer?: () => RestartServerResponse } = {},
): Hono {
	const app = new Hono();

	app.get("/health", (c) => {
		const info = getBuildInfo();
		return c.json({
			ok: true,
			pid: info.pid,
			defaultCwd: config.defaultCwd,
			extraWorkspaces: config.extraWorkspaces,
			serverStartedAt: info.serverStartedAt,
			version: info.version,
			buildSha: info.buildSha,
			uptimeSecs: getUptimeSecs(),
		});
	});

	app.get("/version", async (c) => {
		const info = getBuildInfo();
		const body = await getUpdateCheck({ currentVersion: info.version });
		return c.json(body);
	});

	app.get("/workspaces", async (c) => {
		const allSessions = await bridge.listSessions({});
		const counts = new Map<string, number>();
		for (const s of allSessions) {
			if (!s.cwd) continue;
			counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
		}

		// Always include default + extras even if zero sessions.
		const known = new Set<string>([config.defaultCwd, ...config.extraWorkspaces]);
		for (const cwd of counts.keys()) known.add(cwd);

		const preferenceByCwd = new Map(listWorkspacePreferences().map((p) => [p.cwd, p.model]));

		const workspaces: WorkspaceEntry[] = Array.from(known)
			.map((cwd) => {
				const entry: WorkspaceEntry = {
					cwd,
					label: deriveLabel(cwd),
					sessionCount: counts.get(cwd) ?? 0,
				};
				const defaultModel = preferenceByCwd.get(cwd);
				if (defaultModel) entry.defaultModel = defaultModel;
				return entry;
			})
			.sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));

		const body: ListWorkspacesResponse = {
			workspaces,
			defaultCwd: config.defaultCwd,
		};
		return c.json(body);
	});

	// ─── Workspace preferences (T-42: per-cwd default model override) ──────

	app.get("/workspace-preferences", (c) => {
		const body: ListWorkspacePreferencesResponse = { preferences: listWorkspacePreferences() };
		return c.json(body);
	});

	app.put("/workspace-preferences", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) {
			return c.json(
				{ error: `cwd does not exist, isn't a directory, or is outside the home directory: ${cwd}` },
				400,
			);
		}
		let body: SetWorkspacePreferenceRequest;
		try {
			body = (await c.req.json()) as SetWorkspacePreferenceRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (body.model !== null) {
			const invalid = await validateModelRef(bridge, body.model);
			if (invalid) return c.json({ error: invalid }, 400);
		}
		try {
			const preference = setWorkspacePreference(cwd, body.model);
			return c.json(preference);
		} catch (err) {
			log.error(`setWorkspacePreference failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/sessions", async (c) => {
		const cwd = c.req.query("cwd");
		try {
			const sessions = await bridge.listSessions(cwd ? { cwd } : {});
			const body: ListSessionsResponse = { sessions };
			return c.json(body);
		} catch (err) {
			log.error(`listSessions failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	/**
	 * One page of message history older than `before` (a history index,
	 * exclusive). Complements the tail-sliced subscribe snapshot: the web
	 * client calls this as the user scrolls toward the top, walking `before`
	 * backwards until `startIndex` reaches 0. Only answerable for active
	 * sessions — the client is by construction subscribed (and thus the
	 * session active) whenever it pages.
	 */
	app.get("/sessions/:id/history", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not active" }, 404);
		const before = Number(c.req.query("before"));
		if (!Number.isFinite(before) || before < 0) {
			return c.json({ error: "invalid 'before' index" }, 400);
		}
		const limitRaw = Number(c.req.query("limit"));
		const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
		const body: SessionHistoryResponse = await handle.getHistory(before, limit);
		return c.json(body);
	});

	app.post("/sessions", async (c) => {
		let body: CreateSessionRequest;
		try {
			body = (await c.req.json()) as CreateSessionRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const requestedCwd = body.cwd?.trim();
		const cwd = requestedCwd || config.defaultCwd;

		// Only gate cwds the caller actually supplied — resuming a session or
		// falling back to the (already-trusted) default shouldn't re-validate.
		if (!body.resumeFromPath && requestedCwd && !isCwdAllowed(requestedCwd)) {
			return c.json(
				{ error: `cwd does not exist, isn't a directory, or is outside the home directory: ${requestedCwd}` },
				400,
			);
		}

		// Model + Plan Mode are creation-time-only options (T-39): a resumed
		// session keeps its persisted state instead of taking a fresh default,
		// so combining them with `resumeFromPath` is rejected rather than
		// silently ignored.
		if (body.resumeFromPath && (body.model || body.planMode)) {
			return c.json(
				{ error: "model and planMode cannot be combined with resumeFromPath" },
				400,
			);
		}

		// Resolve the model to apply: explicit request > per-workspace default
		// (T-42) > undefined (SDK/OMP_MODEL picks its own default). Only when
		// creating fresh — resume never takes a model.
		let resolvedModel: ModelRef | undefined;
		if (!body.resumeFromPath) {
			resolvedModel = body.model ?? getWorkspacePreference(cwd)?.model;
			if (resolvedModel) {
				const invalid = await validateModelRef(bridge, resolvedModel);
				if (invalid) return c.json({ error: invalid }, 400);
			}
		}

		try {
			const handle = body.resumeFromPath
				? await bridge.resumeSession({ sessionPath: body.resumeFromPath })
				: await bridge.createSession({
						cwd,
						...(resolvedModel ? { model: resolvedModel } : {}),
						...(body.planMode ? { planMode: true } : {}),
						...(body.suppressAutoStart ? { suppressAutoStart: true } : {}),
					});
			const resp: CreateSessionResponse = {
				sessionId: handle.sessionId,
				sessionFile: handle.sessionFile,
				cwd: handle.cwd,
			};
			return c.json(resp);
		} catch (err) {
			log.error(`createSession failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/abort", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		try {
			await handle.abort();
			return c.json({ ok: true });
		} catch (err) {
			log.error(`abort failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/compact", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		// Body is optional — accept missing/empty JSON without bouncing.
		let body: { focus?: string } = {};
		try {
			const raw = await c.req.text();
			if (raw.trim().length > 0) body = JSON.parse(raw) as { focus?: string };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			await handle.compact(body.focus);
			return c.json({ ok: true });
		} catch (err) {
			log.error(`compact failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.patch("/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found or not active" }, 404);
		let body: { name?: string; model?: { provider?: unknown; id?: unknown } };
		try {
			body = (await c.req.json()) as { name?: string; model?: { provider?: unknown; id?: unknown } };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			let changed = false;
			if (typeof body.name === "string") {
				await handle.setName(body.name.trim());
				changed = true;
			}
			if (body.model && typeof body.model === "object") {
				const provider = typeof body.model.provider === "string" ? body.model.provider : "";
				const modelId = typeof body.model.id === "string" ? body.model.id : "";
				if (!provider || !modelId) {
					return c.json({ error: "model requires provider and id strings" }, 400);
				}
				await handle.setModel({ provider, id: modelId });
				changed = true;
			}
			if (changed) broadcastBus.broadcast({ type: "sessions_changed" });
			return c.json({ ok: true, sessionId: id });
		} catch (err) {
			log.error(`patch session failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.get("/models", async (c) => {
		const sessionId = c.req.query("sessionId");
		try {
			const opts: { sessionId?: string } = {};
			if (sessionId) opts.sessionId = sessionId;
			const models = await bridge.listModels(opts);
			const active = models.find((m) => m.isCurrent);
			const body: ListModelsResponse = {
				models,
				...(active ? { active: { provider: active.provider, id: active.id } } : {}),
			};
			return c.json(body);
		} catch (err) {
			log.error(`listModels failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.delete("/sessions/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const result = await bridge.deleteSession(id);
			if (!result.deleted) return c.json({ error: "session not found" }, 404);
			broadcastBus.broadcast({ type: "sessions_changed" });
			return c.json({ ok: true });
		} catch (err) {
			log.error(`delete session failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.route("/", buildTasksRouter());
	app.route("/", buildUploadsRouter({ uploadsRoot: config.uploadsRoot }));
	app.route("/", buildRoutinesRouter(runner));
	app.route("/", buildHooksRouter(runner));
	app.route("/", buildInboxRouter());
	app.route("/", buildUtilityRouter());
	app.route("/", buildSlashCommandsRouter());
	app.route("/", buildFsRouter());
	app.route("/", buildSettingsRouter(bridge, config, opts));
	app.route("/", buildOrientationRouter());
	app.route("/", buildBridgesRouter(supervisor));
	app.route("/", buildMarketplaceRouter(marketplace));
	app.route("/", buildSkillsRouter(skills));
	app.route("/", buildKbRouter(kb));
	app.route("/auth/oauth", buildAuthOAuthRouter());
	app.route("/onboarding", buildOnboardingRouter());
	app.route("/", buildUsageRouter(bridge));
	app.route("/", buildAutoWorkRouter(bridge, config));

	return app;
}

/**
 * Validate a `ModelRef` against the bridge's live model catalog. Returns an
 * error message when the model is unknown or lacks configured auth; returns
 * `undefined` when it is safe to use. Used by both `POST /sessions` and
 * `PUT /workspace-preferences` so an unauthenticated/unknown model never gets
 * silently swapped for the SDK default — the caller gets a 400 instead.
 */
async function validateModelRef(bridge: AgentBridge, ref: ModelRef): Promise<string | undefined> {
	const models = await bridge.listModels();
	const match = models.find((m) => m.provider === ref.provider && m.id === ref.id);
	if (!match) return `unknown model: ${ref.provider}/${ref.id}`;
	if (!match.isAvailable) return `no auth configured for ${ref.provider}/${ref.id}`;
	return undefined;
}

function deriveLabel(cwd: string): string {
	if (!cwd) return "(unknown)";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}
