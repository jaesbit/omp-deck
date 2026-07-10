import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { SessionMonitorEntry, SessionMonitorStatus } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { api } from "@/lib/api";
import { cn, formatDurationMs, formatTimestamp, shortPath } from "@/lib/utils";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";
import { useStore } from "@/lib/store";

const REFRESH_INTERVAL_MS = 5_000;

type StatusFilter = "all" | "active" | "error";

export function SessionsView() {
	const workspaces = useStore((s) => s.workspaces);
	const sessionsChangeCounter = useStore((s) => s.sessionsChangeCounter);
	const [workspace, setWorkspace] = usePersistedViewState("sessions.workspace", "");
	const [statusFilter, setStatusFilter] = usePersistedViewState<StatusFilter>("sessions.status", "all");
	const [sessions, setSessions] = useState<SessionMonitorEntry[]>([]);
	const [selectedId, setSelectedId] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();

	const refresh = useCallback(async () => {
		try {
			const response = await api.listSessionMonitor(workspace || undefined);
			setSessions(response.sessions);
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [workspace]);

	useEffect(() => {
		void refresh();
		const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [refresh]);

	useEffect(() => {
		if (sessionsChangeCounter > 0) void refresh();
	}, [refresh, sessionsChangeCounter]);

	const filtered = useMemo(
		() => sessions.filter((session) => statusFilter === "all" || session.status === statusFilter),
		[sessions, statusFilter],
	);

	return (
		<Layout
			sidebar={<Sidebar />}
			inspector={<div />}
			main={
				<div className="flex h-full min-h-0 flex-col overflow-hidden">
					<header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-paper px-4 py-3">
						<div>
							<h1 className="text-sm font-semibold text-ink">Sessions</h1>
							<p className="mt-0.5 text-xs text-ink-3">Live activity and sessions whose final steps failed.</p>
						</div>
						<button type="button" onClick={() => void refresh()} className="btn-secondary h-8 px-2.5 text-xs" aria-label="Refresh sessions">
							<RefreshCw className="h-3.5 w-3.5" />
							Refresh
						</button>
					</header>
					<div className="flex shrink-0 flex-wrap gap-3 border-b border-line px-4 py-2.5">
						<label className="flex items-center gap-2 text-xs text-ink-3">
							Workspace
							<select value={workspace} onChange={(event) => setWorkspace(event.target.value)} className="field h-8 min-w-52 px-2 font-mono text-xs">
								<option value="">All workspaces</option>
								{workspaces.map((item) => <option key={item.cwd} value={item.cwd}>{item.label}</option>)}
							</select>
						</label>
						<label className="flex items-center gap-2 text-xs text-ink-3">
							State
							<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className="field h-8 px-2 text-xs">
								<option value="all">All</option>
								<option value="active">Active</option>
								<option value="error">Ended with error</option>
							</select>
						</label>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto p-4">
						{error ? <p className="rounded border border-red-400/30 bg-red-500/5 px-3 py-2 text-sm text-red-400">{error}</p> : null}
						{loading ? <p className="text-sm text-ink-3">Loading sessions…</p> : null}
						{!loading && !error && filtered.length === 0 ? <p className="text-sm text-ink-3">No sessions match these filters.</p> : null}
						<div className="space-y-2">
							{filtered.map((session) => (
								<SessionCard key={session.id} session={session} expanded={session.id === selectedId} onToggle={() => setSelectedId((current) => current === session.id ? undefined : session.id)} />
							))}
						</div>
					</div>
				</div>
			}
		/>
	);
}

function SessionCard({ session, expanded, onToggle }: { session: SessionMonitorEntry; expanded: boolean; onToggle(): void }) {
	return (
		<article className={cn("overflow-hidden rounded-md border", expanded ? "border-accent/50" : "border-line")}>
			<button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-paper-3">
				<StatusIcon status={session.status} />
				<div className="min-w-0 flex-1">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<p className="truncate text-sm font-medium text-ink">{session.title || session.id}</p>
							<p className="mt-0.5 truncate font-mono text-2xs text-ink-3" title={session.cwd}>{shortPath(session.cwd, 70)}</p>
						</div>
						<div className="shrink-0 text-right text-xs text-ink-3">
							<p>{formatTimestamp(session.updatedAt || session.createdAt)}</p>
							<p className="mt-0.5">{session.durationMs != null ? formatDurationMs(session.durationMs) : `${session.messageCount} messages`}</p>
						</div>
					</div>
					{session.error ? <p className="mt-2 line-clamp-2 text-xs text-red-400">{session.error}</p> : null}
				</div>
				{expanded ? <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-ink-3" /> : <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-3" />}
			</button>
			{expanded ? <SessionMessages session={session} /> : null}
		</article>
	);
}

function StatusIcon({ status }: { status: SessionMonitorStatus }) {
	if (status === "active") return <Activity className="mt-0.5 h-4 w-4 shrink-0 animate-pulse text-green-400" aria-label="Active" />;
	if (status === "error") return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-label="Ended with error" />;
	return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-label="Completed" />;
}

function SessionMessages({ session }: { session: SessionMonitorEntry }) {
	return (
		<div className="border-t border-line bg-paper-2 px-4 py-3">
			<p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Latest messages</p>
			{session.recentMessages.length === 0 ? <p className="text-xs text-ink-3">No displayable messages in the transcript tail.</p> : (
				<div className="space-y-2">
					{session.recentMessages.map((message, index) => (
						<div key={`${message.role}-${index}`} className={cn("rounded border px-3 py-2 text-xs", message.isError ? "border-red-400/30 bg-red-500/5 text-red-200" : "border-line bg-paper text-ink-2")}>
							<p className="mb-1 font-medium uppercase tracking-wide text-2xs text-ink-3">{message.role}</p>
							<p className="whitespace-pre-wrap break-words">{message.text}</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
