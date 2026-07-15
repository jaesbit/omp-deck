/**
 * Project Configuration (T-112).
 *
 * Centralises the settings that can be applied individually per project:
 * the default agent for new sessions (`WorkspacePreference`) and the
 * per-difficulty agent mapping the auto-work engine consults first
 * (`AutoWorkConfig.modelByDifficulty`, T-109). Replaces the old "Workspaces"
 * Settings tab and the difficulty picker that used to live inside the
 * per-workspace Auto Work config modal — both moved here so a project's
 * generic configuration has a single home.
 *
 * What stays in Settings → Auto Work: enable/disable, execution time windows,
 * and the rest of the auto-work engine's own budget/timeout internals — none
 * of that is generic project config, it only makes sense for unattended runs.
 * This view links there for convenience, and Auto Work links back here.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FolderCog, RefreshCw } from "lucide-react";
import type { AutoWorkConfig, CodebaseMemoryMcpStatus, TaskDifficulty, WorkspaceEntry } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/Button";
import { AgentPickerModal, WorkspaceDefaultAgentModal } from "@/components/settings/AgentPickerModals";
import { api } from "@/lib/api";
import { autoWorkConfigToRequest } from "@/lib/auto-work-config";
import { cn } from "@/lib/utils";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";

const DIFFICULTIES: TaskDifficulty[] = ["hard", "medium", "easy"];

export function ProjectConfigView() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
	const [autoWorkConfigs, setAutoWorkConfigs] = useState<Record<string, AutoWorkConfig>>({});
	const [codebaseMemoryMcpStatuses, setCodebaseMemoryMcpStatuses] = useState<Record<string, CodebaseMemoryMcpStatus>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [selectedCwd, setSelectedCwd] = usePersistedViewState("project-config.workspace", "");
	const [editingDefaultAgent, setEditingDefaultAgent] = useState(false);
	const [pickerDifficulty, setPickerDifficulty] = useState<TaskDifficulty | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const resp = await api.listWorkspaces();
			setWorkspaces(resp.workspaces);
			// A stale workspace must not prevent the remaining project settings from loading.
			const results = await Promise.allSettled(
				resp.workspaces.map(async (w) => [w.cwd, await api.getAutoWorkConfig(w.cwd)] as const),
			);
			const entries = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
			setAutoWorkConfigs(Object.fromEntries(entries));
			const mcpResults = await Promise.allSettled(
				resp.workspaces.map(async (w) => [w.cwd, await api.getCodebaseMemoryMcpStatus(w.cwd)] as const),
			);
			const mcpEntries = mcpResults.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
			setCodebaseMemoryMcpStatuses(Object.fromEntries(mcpEntries));
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Deep link from Auto Work ("Project" row action / "Open Project
	// Configuration" in the config modal) — `?cwd=` selects that workspace.
	useEffect(() => {
		const cwdParam = searchParams.get("cwd");
		if (cwdParam) setSelectedCwd(cwdParam);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams]);

	// Fall back to the first known workspace once loaded, if nothing (and no
	// deep link) selected one yet.
	useEffect(() => {
		if (!selectedCwd && workspaces.length > 0) setSelectedCwd(workspaces[0]!.cwd);
	}, [workspaces, selectedCwd, setSelectedCwd]);

	const selected = useMemo(() => workspaces.find((w) => w.cwd === selectedCwd), [workspaces, selectedCwd]);
	const selectedAutoWork = selectedCwd ? autoWorkConfigs[selectedCwd] : undefined;
	const selectedCodebaseMemoryMcp = selectedCwd ? codebaseMemoryMcpStatuses[selectedCwd] : undefined;

	async function saveDifficultyAgent(difficulty: TaskDifficulty, ref: { provider: string; id: string } | null): Promise<void> {
		if (!selectedCwd || !selectedAutoWork) return;
		const next: AutoWorkConfig = {
			...selectedAutoWork,
			modelByDifficulty: { ...selectedAutoWork.modelByDifficulty, [difficulty]: ref },
		};
		try {
			const saved = await api.setAutoWorkConfig(selectedCwd, autoWorkConfigToRequest(next));
			setAutoWorkConfigs((prev) => ({ ...prev, [selectedCwd]: saved }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function clearDefaultAgent(): Promise<void> {
		if (!selectedCwd) return;
		try {
			await api.setWorkspacePreference(selectedCwd, null, null);
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function setCodebaseMemoryMcpEnabled(enabled: boolean): Promise<void> {
		if (!selectedCwd) return;
		try {
			const status = await api.setCodebaseMemoryMcpEnabled(selectedCwd, enabled);
			setCodebaseMemoryMcpStatuses((prev) => ({ ...prev, [selectedCwd]: status }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	const content = (
		<div className="flex h-full overflow-hidden">
			{/* Left: project list */}
			<div className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-line">
				<div className="flex items-center justify-between border-b border-line px-4 py-3">
					<div className="flex items-center gap-2">
						<FolderCog className="h-4 w-4 text-ink-3" />
						<h2 className="text-sm font-semibold text-ink">Project Configuration</h2>
					</div>
					<button
						type="button"
						onClick={() => void refresh()}
						className="rounded p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
						title="Refresh"
					>
						<RefreshCw className="h-3.5 w-3.5" />
					</button>
				</div>
				<div className="flex-1 overflow-y-auto p-2">
					{loading ? (
						<div className="flex items-center justify-center py-8 text-xs text-ink-3">Loading…</div>
					) : workspaces.length === 0 ? (
						<div className="py-8 text-center text-xs text-ink-3">No known workspaces yet.</div>
					) : (
						<div className="space-y-1">
							{workspaces.map((w) => (
								<button
									key={w.cwd}
									type="button"
									onClick={() => setSelectedCwd(w.cwd)}
									className={cn(
										"w-full rounded-md px-2.5 py-2 text-left transition-colors",
										w.cwd === selectedCwd ? "bg-accent-soft text-accent" : "hover:bg-paper-3",
									)}
								>
									<div className="truncate text-sm font-medium">{w.label}</div>
									<div className="truncate font-mono text-2xs text-ink-3" title={w.cwd}>
										{w.cwd}
									</div>
								</button>
							))}
						</div>
					)}
				</div>
			</div>

			{/* Right: selected project's config */}
			<div className="min-w-0 flex-1 overflow-y-auto p-4">
				{error ? (
					<div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{!selected ? (
					<div className="flex h-full items-center justify-center text-sm text-ink-3">
						{loading ? "Loading…" : "Select a project"}
					</div>
				) : (
					<div className="mx-auto max-w-2xl space-y-6">
						<div>
							<h1 className="text-lg font-semibold text-ink">{selected.label}</h1>
							<p className="mt-0.5 truncate font-mono text-xs text-ink-3" title={selected.cwd}>
								{selected.cwd}
							</p>
						</div>

						{/* Default agent */}
						<div className="rounded-md border border-line bg-paper-2 p-4">
							<h2 className="mb-1 text-sm font-semibold text-ink">Default agent</h2>
							<p className="mb-3 text-xs text-ink-3">
								Used for new sessions in this project unless overridden at creation time.
							</p>
							<div className="flex items-center gap-3">
								<div className="min-w-0 flex-1">
									{selected.defaultModel ? (
										<div className="font-mono text-xs text-ink-2">
											{selected.defaultModel.provider}/{selected.defaultModel.id}
										</div>
									) : (
										<div className="font-mono text-xs text-ink-4">global/SDK default</div>
									)}
									{selected.defaultThinking ? (
										<div className="font-mono text-2xs text-ink-3">thinking: {selected.defaultThinking}</div>
									) : null}
								</div>
								<Button variant="ghost" size="sm" onClick={() => setEditingDefaultAgent(true)}>
									Change
								</Button>
								{selected.defaultModel || selected.defaultThinking ? (
									<Button variant="ghost" size="sm" onClick={() => void clearDefaultAgent()}>
										Clear
									</Button>
								) : null}
							</div>
						</div>

						{/* Agents by difficulty */}
						<div className="rounded-md border border-line bg-paper-2 p-4">
							<h2 className="mb-1 text-sm font-semibold text-ink">Agents by difficulty</h2>
							<p className="mb-3 text-xs text-ink-3">
								Which agent auto-work uses, selected by the task's difficulty level (T-109).
								Cascade: this project hard→medium→easy → global fallback hard→medium→easy →
								this project's default agent above.
							</p>
							{!selectedAutoWork ? (
								<p className="text-xs text-ink-3">Unavailable — could not load auto-work config for this project.</p>
							) : (
								<ul className="divide-y divide-line rounded-md border border-line">
									{DIFFICULTIES.map((difficulty) => {
										const ref = selectedAutoWork.modelByDifficulty[difficulty];
										return (
											<li key={difficulty} className="flex items-center gap-2 px-2 py-1.5 text-sm">
												<span className="w-14 font-mono text-2xs text-ink-3">{difficulty}</span>
												<span className="min-w-0 flex-1 truncate font-mono text-2xs">
													{ref ? `${ref.provider}/${ref.id}` : "cascade fallback"}
												</span>
												<Button variant="ghost" size="sm" onClick={() => setPickerDifficulty(difficulty)}>
													Change
												</Button>
												{ref ? (
													<Button variant="ghost" size="sm" onClick={() => void saveDifficultyAgent(difficulty, null)}>
														Clear
													</Button>
												) : null}
											</li>
										);
									})}
								</ul>
							)}
						</div>

						{/* Codebase Memory MCP */}
						<div className="rounded-md border border-line bg-paper-2 p-4">
							<h2 className="mb-1 text-sm font-semibold text-ink">Codebase Memory MCP</h2>
							<p className="mb-3 text-xs text-ink-3">
								Indexes this project's code for structural and semantic code queries. It is enabled by
								default for new projects and can be disabled here without affecting other MCP servers.
							</p>
							<label className="flex cursor-pointer items-center gap-3 text-sm text-ink-2">
								<input
									type="checkbox"
									checked={selectedCodebaseMemoryMcp?.enabled ?? true}
									disabled={!selectedCodebaseMemoryMcp}
									onChange={(event) => void setCodebaseMemoryMcpEnabled(event.target.checked)}
									className="h-4 w-4 accent-accent"
								/>
								<span>
									{selectedCodebaseMemoryMcp
										? selectedCodebaseMemoryMcp.enabled
											? "Enabled for this project"
											: "Disabled for this project"
										: "Loading…"}
								</span>
							</label>
							{selectedCodebaseMemoryMcp?.enabled ? (
								<Button
									className="mt-3"
									variant="ghost"
									size="sm"
									onClick={() => navigate(`/codebase-memory?cwd=${encodeURIComponent(selectedCwd)}`)}
								>
									Explore indexed memory →
								</Button>
							) : null}
							<p className="mt-2 text-2xs text-ink-4">
								The override is stored in <code>.omp/mcp.json</code> and applies after the next session restart.
							</p>
						</div>

						{/* Auto Work summary — everything else about unattended runs lives in Settings. */}
						<div className="rounded-md border border-line bg-paper-2 p-4">
							<h2 className="mb-1 text-sm font-semibold text-ink">Auto Work</h2>
							<p className="mb-3 text-xs text-ink-3">
								Enable/disable, execution windows, and spend limits are engine-specific settings,
								not generic project config — manage them in Settings.
							</p>
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0 flex-1 font-mono text-2xs text-ink-3">
									{selectedAutoWork
										? `${selectedAutoWork.enabled ? "enabled" : "disabled"} · ${
												selectedAutoWork.timeWindows.length === 0
													? "never runs"
													: selectedAutoWork.timeWindows.map((w) => `${w.start}:00–${w.end}:00`).join(", ")
											}`
										: "…"}
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => navigate("/settings?section=autowork")}
								>
									Open Auto Work settings →
								</Button>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);

	return (
		<>
			<Layout sidebar={<Sidebar />} main={content} inspector={<div />} />
			<WorkspaceDefaultAgentModal
				cwd={editingDefaultAgent ? selectedCwd : undefined}
				onClose={() => setEditingDefaultAgent(false)}
				onPicked={() => void refresh()}
			/>
			<AgentPickerModal
				open={pickerDifficulty !== undefined}
				onClose={() => setPickerDifficulty(undefined)}
				onPicked={(ref) => {
					if (pickerDifficulty) void saveDifficultyAgent(pickerDifficulty, ref);
					setPickerDifficulty(undefined);
				}}
			/>
		</>
	);
}
