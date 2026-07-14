import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentBridge } from "./bridge/types.ts";
import type { BridgeSupervisor } from "./bridge-supervisor.ts";
import type { Config } from "./config.ts";
import type { KbService } from "./kb-service.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import { buildRouter } from "./routes.ts";
import type { RoutinesRunner } from "./routines-runner.ts";
import type { SkillsService } from "./skills-service.ts";

function config(defaultCwd: string): Config {
	return {
		host: "127.0.0.1",
		port: 8787,
		defaultCwd,
		extraWorkspaces: [],
		devMode: true,
		idleTimeoutMs: 0,
		dbPath: path.join(defaultCwd, "deck.db"),
		uploadsRoot: path.join(defaultCwd, "uploads"),
	};
}

function makeApp(project: string) {
	return buildRouter(
		{ listModels: async () => [] } as unknown as AgentBridge,
		config(project),
		{} as RoutinesRunner,
		{} as BridgeSupervisor,
		{} as MarketplaceService,
		{} as SkillsService,
		{} as KbService,
	);
}

describe("codebase-memory-mcp project toggle (T-111)", () => {
	let originalHome: string | undefined;
	let home: string;
	let project: string;

	beforeEach(() => {
		home = mkdtempSync(path.join(os.tmpdir(), "omp-deck-codebase-memory-home-"));
		project = path.join(home, "project");
		mkdirSync(project);
		originalHome = process.env.HOME;
		process.env.HOME = home;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(home, { recursive: true, force: true });
	});

	test("defaults to enabled without creating a project override", async () => {
		const response = await makeApp(project).request(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(project)}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ cwd: project, enabled: true, configured: false });
	});

	test("persists disabled state and preserves other project MCP servers", async () => {
		mkdirSync(path.join(project, ".omp"));
		writeFileSync(
			path.join(project, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { filesystem: { command: "filesystem", args: [] } } }),
		);
		const app = makeApp(project);
		const response = await app.request(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(project)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ cwd: project, enabled: false, configured: true });

		const configPath = path.join(project, ".omp", "mcp.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect(config.mcpServers.filesystem).toEqual({ command: "filesystem", args: [] });
		expect(config.mcpServers["codebase-memory-mcp"]).toEqual({
			command: "codebase-memory-mcp",
			args: [],
			enabled: false,
		});

		const enabled = await app.request(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(project)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		expect(await enabled.json()).toEqual({ cwd: project, enabled: true, configured: true });
	});

	test("rejects non-boolean toggle payloads", async () => {
		const response = await makeApp(project).request(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(project)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: "false" }),
		});
		expect(response.status).toBe(400);
	});
});
