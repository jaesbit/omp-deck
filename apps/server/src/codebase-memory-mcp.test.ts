import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearOmpExtensionCliRoots, injectOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";

import { getCodebaseMemoryMcpExtensionPath } from "./codebase-memory-mcp.ts";

beforeAll(() => {
	injectOmpExtensionCliRoots([getCodebaseMemoryMcpExtensionPath()], process.env.HOME ?? "/tmp", process.cwd());
});
afterAll(() => {
	clearOmpExtensionCliRoots();
});

describe("bundled codebase-memory-mcp discovery (T-111)", () => {
	test("loads the bundled server with the default enabled config", async () => {
		const result = await loadAllMCPConfigs(process.cwd(), { filterExa: false });
		expect(result.configs["codebase-memory-mcp"]).toMatchObject({
			type: "stdio",
			command: "codebase-memory-mcp",
			enabled: true,
		});
	});
	test("project disabled override removes only the bundled server", async () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "omp-deck-mcp-project-"));
		try {
			mkdirSync(path.join(project, ".omp"));
			writeFileSync(
				path.join(project, ".omp", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						"codebase-memory-mcp": {
							command: "codebase-memory-mcp",
							args: [],
							enabled: false,
						},
					},
				}),
			);
			const result = await loadAllMCPConfigs(project, { filterExa: false });
			expect(result.configs["codebase-memory-mcp"]).toBeUndefined();
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});
});
