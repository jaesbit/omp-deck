import * as path from "node:path";

export const CODEBASE_MEMORY_MCP_NAME = "codebase-memory-mcp";
export const CODEBASE_MEMORY_MCP_COMMAND = "codebase-memory-mcp";

export interface ProjectMcpConfig {
	mcpServers?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
}

export interface CodebaseMemoryMcpStatus {
	cwd: string;
	enabled: boolean;
	configured: boolean;
}

export function getCodebaseMemoryMcpExtensionPath(): string {
	return path.resolve(import.meta.dir, "mcp", "codebase-memory-mcp");
}

export function getProjectMcpConfigPath(cwd: string): string {
	return path.join(cwd, ".omp", "mcp.json");
}

export function getDefaultCodebaseMemoryMcpConfig(): Record<string, unknown> {
	return {
		command: CODEBASE_MEMORY_MCP_COMMAND,
		args: [],
	};
}

export function getCodebaseMemoryMcpStatus(cwd: string, config: ProjectMcpConfig): CodebaseMemoryMcpStatus {
	const entry = config.mcpServers?.[CODEBASE_MEMORY_MCP_NAME];
	return {
		cwd,
		enabled: entry?.enabled !== false,
		configured: entry !== undefined,
	};
}

export function setCodebaseMemoryMcpEnabled(config: ProjectMcpConfig, enabled: boolean): ProjectMcpConfig {
	return {
		...config,
		mcpServers: {
			...(config.mcpServers ?? {}),
			[CODEBASE_MEMORY_MCP_NAME]: {
				...getDefaultCodebaseMemoryMcpConfig(),
				...(config.mcpServers?.[CODEBASE_MEMORY_MCP_NAME] ?? {}),
				enabled,
			},
		},
	};
}
