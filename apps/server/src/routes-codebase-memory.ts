import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { Hono } from "hono";
import type { CodebaseMemoryMcpStatus, SetCodebaseMemoryMcpRequest } from "@omp-deck/protocol";

import {
	getCodebaseMemoryMcpStatus,
	getProjectMcpConfigPath,
	setCodebaseMemoryMcpEnabled,
	type ProjectMcpConfig,
} from "./codebase-memory-mcp.ts";

export function buildCodebaseMemoryRouter(isCwdAllowed: (cwd: string) => boolean): Hono {
	const app = new Hono();

	app.get("/workspace-mcp/codebase-memory", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) return c.json({ error: "cwd is not an allowed workspace" }, 400);

		try {
			const config = await readProjectMcpConfig(cwd);
			const status: CodebaseMemoryMcpStatus = getCodebaseMemoryMcpStatus(cwd, config);
			return c.json(status);
		} catch (error) {
			return c.json({ error: `invalid project MCP config: ${String(error)}` }, 500);
		}
	});

	app.put("/workspace-mcp/codebase-memory", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) return c.json({ error: "cwd is not an allowed workspace" }, 400);

		let body: SetCodebaseMemoryMcpRequest;
		try {
			body = (await c.req.json()) as SetCodebaseMemoryMcpRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);

		try {
			const config = await readProjectMcpConfig(cwd);
			const next = setCodebaseMemoryMcpEnabled(config, body.enabled);
			const configPath = getProjectMcpConfigPath(cwd);
			await mkdir(path.dirname(configPath), { recursive: true });
			await Bun.write(configPath, `${JSON.stringify(next, null, 2)}\n`);
			return c.json(getCodebaseMemoryMcpStatus(cwd, next));
		} catch (error) {
			return c.json({ error: `could not write project MCP config: ${String(error)}` }, 500);
		}
	});

	return app;
}

async function readProjectMcpConfig(cwd: string): Promise<ProjectMcpConfig> {
	const file = Bun.file(getProjectMcpConfigPath(cwd));
	if (!(await file.exists())) return {};
	const parsed: unknown = JSON.parse(await file.text());
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("config must be a JSON object");
	}
	return parsed as ProjectMcpConfig;
}
