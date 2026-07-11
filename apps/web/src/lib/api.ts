import type {
	ApplyDelegationArtifactRequest,
	ApplyDelegationArtifactResponse,
	AdvisorSettingsResponse,
	AutoWorkConfig,
	AutoWorkCycleResult,
	AutoWorkGlobalConfig,
	AutoWorkRunStatus,
	AutoWorkScheduleStatus,
	CreateSessionRequest,
	CreateSessionResponse,
	DeckBaseUrlResponse,
	DelegationArtifactResponse,
	DiscardDelegationArtifactRequest,
	DiscardDelegationArtifactResponse,
	GetDelegationSettingsResponse,
	InternalTaskModelResponse,
	ListAutoWorkRunsResponse,
	ListDirResponse,
	ListFilePathsResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListSessionMonitorResponse,
	ListSlashCommandsResponse,
	ListTasksResponse,
	ListWorkspacePreferencesResponse,
	ListWorkspacesResponse,
	ModelRef,
	PatchDelegationSettingsRequest,
	PatchDelegationSettingsResponse,
	RewriteTaskRequest,
	RewriteTaskResponse,
	SessionHistoryResponse,
	SetAutoWorkConfigRequest,
	SetAutoWorkGlobalConfigRequest,
	SetDeckBaseUrlRequest,
	SetInternalTaskModelRequest,
	PlanModelResponse,
	SetPlanModelRequest,
	SpendSummaryResponse,
	SetTaskRewriteModelRequest,
	SetAdvisorSettingsRequest,
	SubscriptionUsageResponse,
	TaskPriority,
	TaskRewriteModelResponse,
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
	listSessionMonitor(cwd?: string): Promise<ListSessionMonitorResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSessionMonitorResponse>(`/sessions/monitor${q}`);
	},
	sessionHistory(id: string, before: number, limit: number): Promise<SessionHistoryResponse> {
		return request<SessionHistoryResponse>(
			`/sessions/${encodeURIComponent(id)}/history?before=${before}&limit=${limit}`,
		);
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
	setWorkspacePreference(cwd: string, model: ModelRef | null, thinking?: string | null): Promise<WorkspacePreference> {
		return request<WorkspacePreference>(`/workspace-preferences?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ model, ...(thinking !== undefined ? { thinking } : {}) }),
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
	getAdvisorSettings(): Promise<AdvisorSettingsResponse> {
		return request<AdvisorSettingsResponse>("/advisors/settings");
	},
	setAdvisorEnabled(enabled: boolean): Promise<AdvisorSettingsResponse> {
		return request<AdvisorSettingsResponse>("/advisors/settings", {
			method: "PUT",
			body: JSON.stringify({ enabled } satisfies SetAdvisorSettingsRequest),
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
	retryAutoWorkRunPr(runId: string): Promise<{ number: number; url: string }> {
		return request<{ number: number; url: string }>(
			`/auto-work/runs/${encodeURIComponent(runId)}/create-pr`,
			{ method: "POST" },
		);
	},
	stopAutoWorkRun(runId: string): Promise<{ ok: true }> {
		return request<{ ok: true }>(`/auto-work/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
	},
	deleteAutoWorkRun(runId: string): Promise<{ ok: true }> {
		return request<{ ok: true }>(`/auto-work/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
	},
	triggerAutoWork(): Promise<AutoWorkCycleResult> {
		return request<AutoWorkCycleResult>(`/auto-work/trigger`, { method: "POST" });
	},
	getAutoWorkScheduleStatus(): Promise<AutoWorkScheduleStatus> {
		return request<AutoWorkScheduleStatus>(`/auto-work/schedule-status`);
	},
	getAutoWorkGlobalConfig(): Promise<AutoWorkGlobalConfig> {
		return request<AutoWorkGlobalConfig>(`/auto-work/global-config`);
	},
	setAutoWorkGlobalConfig(body: SetAutoWorkGlobalConfigRequest): Promise<AutoWorkGlobalConfig> {
		return request<AutoWorkGlobalConfig>(`/auto-work/global-config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	},
	getSubscriptionUsage(): Promise<SubscriptionUsageResponse> {
		return request<SubscriptionUsageResponse>(`/usage/subscription`);
	},
	getAccountSpendSummary(): Promise<SpendSummaryResponse> {
		return request<SpendSummaryResponse>(`/usage/spend`);
	},
	listTasks(): Promise<ListTasksResponse> {
		return request<ListTasksResponse>("/tasks");
	},
	rewriteTask(taskId: string, opts: RewriteTaskRequest = {}): Promise<RewriteTaskResponse> {
		return request<RewriteTaskResponse>(`/tasks/${encodeURIComponent(taskId)}/rewrite`, {
			method: "POST",
			body: JSON.stringify(opts),
		});
	},
	getTaskRewriteModel(): Promise<TaskRewriteModelResponse> {
		return request<TaskRewriteModelResponse>("/settings/task-rewrite-model");
	},
	setTaskRewriteModel(model: ModelRef | null): Promise<TaskRewriteModelResponse> {
		return request<TaskRewriteModelResponse>("/settings/task-rewrite-model", {
			method: "PUT",
			body: JSON.stringify({ model } satisfies SetTaskRewriteModelRequest),
		});
	},
	getInternalTaskModel(): Promise<InternalTaskModelResponse> {
		return request<InternalTaskModelResponse>("/settings/internal-task-model");
	},
	setInternalTaskModel(model: ModelRef | null): Promise<InternalTaskModelResponse> {
		return request<InternalTaskModelResponse>("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model } satisfies SetInternalTaskModelRequest),
		});
	},
	getPlanModel(): Promise<PlanModelResponse> {
		return request<PlanModelResponse>("/settings/plan-model");
	},
	setPlanModel(model: ModelRef | null, thinking: string | null = null): Promise<PlanModelResponse> {
		return request<PlanModelResponse>("/settings/plan-model", {
			method: "PUT",
			body: JSON.stringify({ model, thinking } satisfies SetPlanModelRequest),
		});
	},
	getDelegationSettings(): Promise<GetDelegationSettingsResponse> {
		return request<GetDelegationSettingsResponse>("/delegation/settings");
	},
	patchDelegationSettings(body: PatchDelegationSettingsRequest): Promise<PatchDelegationSettingsResponse> {
		return request<PatchDelegationSettingsResponse>("/delegation/settings", {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	getDelegationArtifact(path: string): Promise<DelegationArtifactResponse> {
		return request<DelegationArtifactResponse>(`/delegation/artifact?path=${encodeURIComponent(path)}`);
	},
	applyDelegationArtifact(body: ApplyDelegationArtifactRequest): Promise<ApplyDelegationArtifactResponse> {
		return request<ApplyDelegationArtifactResponse>("/delegation/artifact/apply", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	discardDelegationArtifact(body: DiscardDelegationArtifactRequest): Promise<DiscardDelegationArtifactResponse> {
		return request<DiscardDelegationArtifactResponse>("/delegation/artifact/discard", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
};
