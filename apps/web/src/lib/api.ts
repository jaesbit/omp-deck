import type {
	AutoWorkConfig,
	AutoWorkCycleResult,
	AutoWorkRunStatus,
	CreateSessionRequest,
	CreateSessionResponse,
	DeckBaseUrlResponse,
	ListAutoWorkRunsResponse,
	ListDirResponse,
	ListFilePathsResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListSlashCommandsResponse,
	ListTasksResponse,
	ListWorkspacePreferencesResponse,
	ListWorkspacesResponse,
	ModelRef,
	SetAutoWorkConfigRequest,
	SetDeckBaseUrlRequest,
	TaskPriority,
	WorkspacePreference,
} from "@omp-deck/protocol";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "(unreadable body)");
		let parsedError: string | undefined;
		try {
			parsedError = (JSON.parse(text) as { error?: string }).error;
		} catch {
			// Body wasn't JSON — fall through to the raw-text error below.
		}
		throw new Error(parsedError ?? `HTTP ${res.status} ${path}: ${text}`);
	}
	return (await res.json()) as T;
}

export const api = {
	listWorkspaces(): Promise<ListWorkspacesResponse> {
		return request<ListWorkspacesResponse>("/workspaces");
	},
	listSessions(cwd?: string): Promise<ListSessionsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSessionsResponse>(`/sessions${q}`);
	},
	createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
		return request<CreateSessionResponse>("/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	abortSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });
	},
	renameSession(id: string, name: string): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
	},
	listModels(sessionId?: string): Promise<ListModelsResponse> {
		const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
		return request<ListModelsResponse>(`/models${q}`);
	},
	setSessionModel(id: string, model: ModelRef): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ model }),
		});
	},
	compactSession(id: string, focus?: string): Promise<{ ok: true }> {
		const body = focus && focus.trim().length > 0 ? JSON.stringify({ focus: focus.trim() }) : "";
		const init: RequestInit = { method: "POST" };
		if (body) {
			init.body = body;
			init.headers = { "content-type": "application/json" };
		}
		return request(`/sessions/${encodeURIComponent(id)}/compact`, init);
	},
	disposeSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	listSlashCommands(cwd?: string): Promise<ListSlashCommandsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSlashCommandsResponse>(`/slash-commands${q}`);
	},
	completeFilePath(cwd: string, q: string, limit = 20): Promise<ListFilePathsResponse> {
		const params = new URLSearchParams({ cwd, q, limit: String(limit) });
		return request<ListFilePathsResponse>(`/fs/complete?${params.toString()}`);
	},
	browseDir(path?: string): Promise<ListDirResponse> {
		const q = path ? `?path=${encodeURIComponent(path)}` : "";
		return request<ListDirResponse>(`/fs/browse${q}`);
	},
	listWorkspacePreferences(): Promise<ListWorkspacePreferencesResponse> {
		return request<ListWorkspacePreferencesResponse>("/workspace-preferences");
	},
	setWorkspacePreference(cwd: string, model: ModelRef | null): Promise<WorkspacePreference> {
		return request<WorkspacePreference>(`/workspace-preferences?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ model }),
		});
	},
	getAutoWorkConfig(cwd: string): Promise<AutoWorkConfig> {
		return request<AutoWorkConfig>(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
	},
	setAutoWorkConfig(cwd: string, config: SetAutoWorkConfigRequest): Promise<AutoWorkConfig> {
		return request<AutoWorkConfig>(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(config),
		});
	},
	getDeckBaseUrl(): Promise<DeckBaseUrlResponse> {
		return request<DeckBaseUrlResponse>("/settings/deck-base-url");
	},
	setDeckBaseUrl(deckBaseUrl: string | null): Promise<DeckBaseUrlResponse> {
		return request<DeckBaseUrlResponse>("/settings/deck-base-url", {
			method: "PUT",
			body: JSON.stringify({ deckBaseUrl } satisfies SetDeckBaseUrlRequest),
		});
	},
	listAutoWorkRuns(filter: {
		limit?: number;
		taskId?: string;
		priority?: TaskPriority;
		status?: AutoWorkRunStatus;
	} = {}): Promise<ListAutoWorkRunsResponse> {
		const params = new URLSearchParams();
		if (filter.limit !== undefined) params.set("limit", String(filter.limit));
		if (filter.taskId) params.set("taskId", filter.taskId);
		if (filter.priority) params.set("priority", filter.priority);
		if (filter.status) params.set("status", filter.status);
		const qs = params.toString();
		return request<ListAutoWorkRunsResponse>(`/auto-work/runs${qs ? `?${qs}` : ""}`);
	},
	triggerAutoWork(cwd: string): Promise<AutoWorkCycleResult> {
		return request<AutoWorkCycleResult>(`/auto-work/trigger?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
		});
	},
	listTasks(): Promise<ListTasksResponse> {
		return request<ListTasksResponse>("/tasks");
	},
};
