import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Database, ExternalLink, RefreshCw } from "lucide-react";
import type {
	CodebaseMemoryContentBlock,
	CodebaseMemoryMcpStatus,
	CodebaseMemoryOverview,
	CodebaseMemoryQueryResult,
	CodebaseMemoryTool,
	WorkspaceEntry,
} from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";

function MemoryContent({ content }: { content: CodebaseMemoryContentBlock[] }) {
	if (content.length === 0) {
		return <p className="text-xs text-ink-3">No content returned by the Codebase Memory MCP.</p>;
	}

	return (
		<div className="space-y-3">
			{content.map((block, index) => (
				<div key={`${block.type}-${block.uri ?? index}`} className="overflow-hidden rounded-md border border-line bg-paper">
					{block.type === "resource" ? (
						<div className="border-b border-line px-3 py-2 font-mono text-2xs text-ink-3">
							{block.uri ?? "MCP resource"}
							{block.mimeType ? ` · ${block.mimeType}` : ""}
						</div>
					) : null}
					{block.text ? (
						<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-ink-2">
							{block.text}
						</pre>
					) : (
						<p className="p-3 text-xs text-ink-3">This resource has no text representation.</p>
					)}
				</div>
			))}
		</div>
	);
}

export function CodebaseMemoryView() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
	const [selectedCwd, setSelectedCwd] = usePersistedViewState("codebase-memory.workspace", "");
	const [status, setStatus] = useState<CodebaseMemoryMcpStatus>();
	const [overview, setOverview] = useState<CodebaseMemoryOverview>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const [selectedTool, setSelectedTool] = useState<string>("");
	const [argumentsText, setArgumentsText] = useState("{}");
	const [queryResult, setQueryResult] = useState<CodebaseMemoryQueryResult>();
	const [queryError, setQueryError] = useState<string>();
	const [querying, setQuerying] = useState(false);

	const refreshWorkspaces = useCallback(async (): Promise<void> => {
		try {
			const response = await api.listWorkspaces();
			setWorkspaces(response.workspaces);
			setError(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	const loadMemory = useCallback(async (cwd: string): Promise<void> => {
		if (!cwd) return;
		setLoading(true);
		setQueryResult(undefined);
		setQueryError(undefined);
		try {
			const nextStatus = await api.getCodebaseMemoryMcpStatus(cwd);
			setStatus(nextStatus);
			if (!nextStatus.enabled) {
				setOverview(undefined);
				setError(undefined);
				return;
			}
			const nextOverview = await api.getCodebaseMemoryOverview(cwd);
			setOverview(nextOverview);
			setSelectedTool(nextOverview.tools.find((tool) => tool.name === "list_projects")?.name ?? nextOverview.tools[0]?.name ?? "");
			setArgumentsText("{}");
			setError(undefined);
		} catch (cause) {
			setOverview(undefined);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refreshWorkspaces();
	}, [refreshWorkspaces]);

	useEffect(() => {
		const cwd = searchParams.get("cwd");
		if (cwd) setSelectedCwd(cwd);
		// The deep link should only update the persisted selection when it changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams]);

	useEffect(() => {
		if (!selectedCwd && workspaces.length > 0) setSelectedCwd(workspaces[0]!.cwd);
	}, [selectedCwd, setSelectedCwd, workspaces]);

	useEffect(() => {
		if (selectedCwd) void loadMemory(selectedCwd);
	}, [loadMemory, selectedCwd]);

	const selectedWorkspace = workspaces.find((workspace) => workspace.cwd === selectedCwd);
	const activeTool: CodebaseMemoryTool | undefined = overview?.tools.find((tool) => tool.name === selectedTool);
	const memoryDisabled = status && !status.enabled;
	const overviewUnavailable = overview?.state === "disabled" || overview?.state === "unavailable";

	async function runQuery(): Promise<void> {
		if (!selectedCwd || !activeTool) return;
		let argumentsValue: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(argumentsText);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				setQueryError("Arguments must be a JSON object.");
				return;
			}
			argumentsValue = parsed as Record<string, unknown>;
		} catch {
			setQueryError("Arguments must be valid JSON.");
			return;
		}

		setQuerying(true);
		setQueryError(undefined);
		try {
			setQueryResult(await api.queryCodebaseMemory(selectedCwd, { tool: activeTool.name, arguments: argumentsValue }));
		} catch (cause) {
			setQueryResult(undefined);
			setQueryError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setQuerying(false);
		}
	}

	return (
		<Layout
			sidebar={<Sidebar />}
			inspector={<div />}
			main={
				<div className="flex h-full overflow-hidden">
					<div className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-line">
						<div className="flex items-center justify-between border-b border-line px-4 py-3">
							<div className="flex items-center gap-2">
								<Database className="h-4 w-4 text-ink-3" />
								<h1 className="text-sm font-semibold text-ink">Codebase Memory</h1>
							</div>
							<button
								type="button"
								onClick={() => {
									void refreshWorkspaces();
									if (selectedCwd) void loadMemory(selectedCwd);
								}}
								className="rounded p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
								title="Refresh"
							>
								<RefreshCw className="h-3.5 w-3.5" />
							</button>
						</div>
						<div className="flex-1 overflow-y-auto p-2">
							{workspaces.map((workspace) => (
								<button
									key={workspace.cwd}
									type="button"
									onClick={() => setSelectedCwd(workspace.cwd)}
									className={cn(
										"w-full rounded-md px-2.5 py-2 text-left transition-colors",
										workspace.cwd === selectedCwd ? "bg-accent-soft text-accent" : "hover:bg-paper-3",
									)}
								>
									<div className="truncate text-sm font-medium">{workspace.label}</div>
									<div className="truncate font-mono text-2xs text-ink-3" title={workspace.cwd}>
										{workspace.cwd}
									</div>
								</button>
							))}
							{workspaces.length === 0 ? <p className="py-8 text-center text-xs text-ink-3">No known workspaces yet.</p> : null}
						</div>
					</div>

					<div className="min-w-0 flex-1 overflow-y-auto p-4">
						<div className="mx-auto max-w-3xl space-y-6">
							{error ? (
								<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div>
							) : null}
							{!selectedWorkspace ? (
								<p className="py-12 text-center text-sm text-ink-3">Select a project to inspect its indexed memory.</p>
							) : loading ? (
								<p className="py-12 text-center text-sm text-ink-3">Loading Codebase Memory…</p>
							) : memoryDisabled || overviewUnavailable ? (
								<div className="rounded-md border border-line bg-paper-2 p-4">
									<h2 className="text-sm font-semibold text-ink">Codebase Memory is disabled</h2>
									<p className="mt-1 text-xs text-ink-3">
										{overview?.message ?? "Enable this project's MCP integration before inspecting indexed content."}
									</p>
									<Button className="mt-3" variant="ghost" size="sm" onClick={() => navigate(`/project-config?cwd=${encodeURIComponent(selectedWorkspace.cwd)}`)}>
										Open Project Configuration <ExternalLink className="ml-1 h-3.5 w-3.5" />
									</Button>
								</div>
							) : overview ? (
								<>
									<div>
										<h2 className="text-lg font-semibold text-ink">{selectedWorkspace.label}</h2>
										<p className="mt-0.5 font-mono text-xs text-ink-3">{selectedWorkspace.cwd}</p>
									</div>

									<section className="rounded-md border border-line bg-paper-2 p-4">
										<h2 className="mb-1 text-sm font-semibold text-ink">Indexed project catalog</h2>
										<p className="mb-3 text-xs text-ink-3">Read directly from the MCP's <code>list_projects</code> tool.</p>
										<MemoryContent content={overview.catalog} />
									</section>

									<section className="rounded-md border border-line bg-paper-2 p-4">
										<h2 className="mb-1 text-sm font-semibold text-ink">Read-only explorer</h2>
										<p className="mb-3 text-xs text-ink-3">
											Only read-only tools exposed by this installed MCP are available. Indexing and deletion are deliberately excluded.
										</p>
										{overview.tools.length === 0 ? (
											<p className="text-xs text-ink-3">The MCP did not expose any supported read-only tools.</p>
										) : (
											<div className="space-y-3">
												<select
													value={selectedTool}
													onChange={(event) => {
														setSelectedTool(event.target.value);
														setArgumentsText("{}");
														setQueryResult(undefined);
														setQueryError(undefined);
													}}
													className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
												>
													{overview.tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
												</select>
												{activeTool?.description ? <p className="text-xs text-ink-3">{activeTool.description}</p> : null}
												<div>
													<label className="mb-1 block font-mono text-2xs text-ink-3">Arguments JSON</label>
													<textarea
														value={argumentsText}
														onChange={(event) => setArgumentsText(event.target.value)}
														spellCheck={false}
														className="h-28 w-full resize-y rounded-md border border-line bg-paper p-3 font-mono text-xs leading-relaxed text-ink focus:border-accent focus:outline-none"
													/>
													{activeTool ? <pre className="mt-2 overflow-auto rounded bg-paper p-2 font-mono text-2xs text-ink-3">{JSON.stringify(activeTool.inputSchema, null, 2)}</pre> : null}
												</div>
												<Button size="sm" onClick={() => void runQuery()} disabled={!activeTool || querying}>
													{querying ? "Running…" : "Run read-only query"}
												</Button>
												{queryError ? <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{queryError}</div> : null}
												{queryResult ? (
													<div className={cn("rounded-md p-3", queryResult.isError ? "border border-danger/30 bg-danger/10" : "border border-line bg-paper")}>
														<p className={cn("mb-2 text-xs", queryResult.isError ? "text-danger" : "text-ink-3")}>
															{queryResult.isError ? "The MCP reported an error" : "Query result"}
														</p>
														<MemoryContent content={queryResult.content} />
													</div>
												) : null}
											</div>
										)}
									</section>
								</>
							) : null}
						</div>
					</div>
				</div>
			}
		/>
	);
}
