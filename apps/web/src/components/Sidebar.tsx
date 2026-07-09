import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { SessionLaunchModal, type SessionLaunchOpts } from "@/components/chat/SessionLaunchModal";
import { launchSession } from "@/lib/first-prompt";
import { useStore } from "@/lib/store";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";
import { cn, shortPath } from "@/lib/utils";

export function Sidebar() {
	const workspaces = useStore((s) => s.workspaces);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const sessions = useStore((s) => s.sessions);
	const activeId = useStore((s) => s.activeId);
	const sessionsById = useStore((s) => s.sessionsById);
	const refreshSessions = useStore((s) => s.refreshSessions);
	const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);
	const createSession = useStore((s) => s.createSession);
	const setPendingDraft = useStore((s) => s.setPendingDraft);
	const selectSession = useStore((s) => s.selectSession);
	const sessionsChangeCounter = useStore((s) => s.sessionsChangeCounter);
	const deleteSession = useStore((s) => s.deleteSession);

	const [selectedCwd, setSelectedCwd] = usePersistedViewState("chat.workspace", "");
	const [launchOpen, setLaunchOpen] = useState(false);

	const filtered = useMemo(() => {
		if (!selectedCwd) return sessions;
		return sessions.filter((s) => s.cwd === selectedCwd);
	}, [sessions, selectedCwd]);

	// Live updates: another tab (or the REST API) renamed/repointed a session's
	// model via `PATCH /sessions/:id`. Refetch so the sidebar reflects it
	// without a manual refresh. Same pattern as `tasksChangeCounter`.
	useEffect(() => {
		if (sessionsChangeCounter === 0) return;
		void refreshSessions(selectedCwd || undefined);
	}, [sessionsChangeCounter, refreshSessions, selectedCwd]);

	async function launch(opts: SessionLaunchOpts): Promise<void> {
		await launchSession(createSession, setPendingDraft, opts);
		setLaunchOpen(false);
	}

	async function handleResume(p: string): Promise<void> {
		try {
			await createSession({ cwd: selectedCwd || defaultCwd, resumeFromPath: p });
		} catch (err) {
			console.error(err);
			alert(`Failed to resume: ${String(err)}`);
		}
	}

	// Trash-icon action on each row (T-47). Destructive + irreversible — the
	// server drops the `.jsonl` file, not just the in-memory handle — hence
	// the confirm prompt, matching the resume-failure `alert()` pattern above.
	function handleDelete(id: string): void {
		if (!window.confirm("Delete this session? This permanently removes its history and cannot be undone.")) return;
		void deleteSession(id);
	}

	const liveSessions = Object.values(sessionsById);
	const persisted = filtered.filter((s) => !sessionsById[s.id]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="space-y-3 px-3 py-3 border-b border-line">
				<div className="flex items-center justify-between">
					<div className="meta">Workspace</div>
					<button
						type="button"
						className="text-ink-3 hover:text-ink"
						onClick={() => void refreshWorkspaces()}
						aria-label="Refresh workspaces"
					>
						<RefreshCw className="h-3 w-3" />
					</button>
				</div>

				<select
					value={selectedCwd}
					onChange={(e) => {
						const value = e.target.value;
						setSelectedCwd(value);
						void refreshSessions(value || undefined);
					}}
					className="field h-7 w-full px-2 font-mono text-xs"
				>
					<option value="">(all workspaces)</option>
					{workspaces.map((w) => (
						<option key={w.cwd} value={w.cwd}>
							{w.label} · {w.sessionCount}
						</option>
					))}
				</select>
				<div className="truncate font-mono text-2xs text-ink-3" title={selectedCwd || defaultCwd}>
					{selectedCwd || defaultCwd}
				</div>
				<button
					type="button"
					className="btn-primary h-8 w-full text-[13px]"
					onClick={() => setLaunchOpen(true)}
				>
					<Plus className="h-3.5 w-3.5" />
					New session
				</button>
			</div>

			<div className="flex items-center justify-between px-3 pt-3 pb-1">
				<div className="meta">Sessions · {filtered.length}</div>
				<button
					type="button"
					className="text-ink-3 hover:text-ink"
					onClick={() => void refreshSessions(selectedCwd || undefined)}
					aria-label="Refresh sessions"
				>
					<RefreshCw className="h-3 w-3" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-1 pb-3">
				{liveSessions.map((s) => (
					<SessionRow
						key={s.sessionId}
						id={s.sessionId}
						title={s.sessionName || formatSessionId(s.sessionId)}
						subtitle={shortPath(s.cwd, 30)}
						active={s.sessionId === activeId}
						live
						planMode={s.planMode?.enabled === true}
						goalStatus={s.goalMode?.status}
						onClick={() => selectSession(s.sessionId)}
						onDelete={handleDelete}
					/>
				))}

				{liveSessions.length > 0 && persisted.length > 0 ? (
					<div className="my-2 mx-2 border-t border-line" />
				) : null}

				{persisted.map((s) => (
					<SessionRow
						key={s.id}
						id={s.id}
						title={s.title || formatSessionId(s.id)}
						subtitle={`${shortPath(s.cwd, 26)} · ${s.messageCount}m`}
						meta={formatRelative(s.updatedAt || s.createdAt)}
						onClick={() => void handleResume(s.path)}
						onDelete={handleDelete}
					/>
				))}

				{filtered.length === 0 && liveSessions.length === 0 ? (
					<div className="px-3 py-6 text-center font-mono text-2xs text-ink-3">
						No sessions yet.
					</div>
				) : null}
			</div>
			<SessionLaunchModal
				open={launchOpen}
				initialCwd={selectedCwd || defaultCwd}
				onCancel={() => setLaunchOpen(false)}
				onConfirm={launch}
			/>
		</div>
	);
}

function SessionRow({
	id,
	title,
	subtitle,
	meta,
	active,
	live,
	planMode,
	goalStatus,
	onClick,
	onDelete,
}: {
	id: string;
	title: string;
	subtitle?: string;
	meta?: string;
	active?: boolean;
	live?: boolean;
	planMode?: boolean;
	/** Goal Mode status, when this session has an active/paused objective. Mutually
	 * exclusive with `planMode` (a session is never in both at once). */
	goalStatus?: "active" | "paused" | "budget-limited" | "complete" | "dropped";
	onClick: () => void;
	/** Delete this session (trash icon, hover-revealed). Confirms + deletes
	 *  both live and persisted rows — see `Sidebar`'s `handleDelete`. */
	onDelete: (id: string) => void;
}) {
	return (
		<div
			className={cn(
				"group relative rounded-md transition-colors",
				active ? "bg-paper-3 text-ink" : "text-ink-2 hover:bg-paper-3/60",
			)}
		>
			<button
				type="button"
				onClick={onClick}
				className="block w-full rounded-md py-1.5 pl-2 pr-7 text-left text-[13px]"
			>
				<div className="flex items-center gap-1.5">
					{live ? (
						<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="live" />
					) : (
						<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
					)}
					<span className="truncate">{title}</span>
					{planMode ? (
						<span
							className="ml-auto shrink-0 rounded border border-thinking/40 bg-thinking/10 px-1 py-px font-mono text-[10px] uppercase tracking-meta text-thinking"
							title="Plan mode active"
						>
							plan
						</span>
					) : goalStatus ? (
						<span
							className="ml-auto shrink-0 rounded border border-accent/40 bg-accent/10 px-1 py-px font-mono text-[10px] uppercase tracking-meta text-accent"
							title={`Goal mode — ${goalStatus}`}
						>
							goal{goalStatus !== "active" ? `:${goalStatus}` : ""}
						</span>
					) : null}
				</div>
				{subtitle ? (
					<div className="mt-0.5 truncate pl-3 font-mono text-2xs text-ink-3">
						{subtitle}
					</div>
				) : null}
				{meta ? (
					<div className="truncate pl-3 font-mono text-2xs text-ink-4">{meta}</div>
				) : null}
			</button>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onDelete(id);
				}}
				className="absolute right-1 top-1.5 shrink-0 rounded p-0.5 text-ink-4 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
				aria-label="Delete session"
				title="Delete session"
			>
				<Trash2 className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

function formatSessionId(id: string): string {
	if (id.length <= 8) return id;
	return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

const RELATIVE_THRESHOLDS: Array<[number, string]> = [
	[60_000, "just now"],
	[3_600_000, "m"],
	[86_400_000, "h"],
	[2_592_000_000, "d"],
];

function formatRelative(ts: string): string {
	if (!ts) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	const diff = Date.now() - d.getTime();
	if (diff < 0) return d.toLocaleDateString();
	const first = RELATIVE_THRESHOLDS[0];
	if (!first || diff < first[0]) return "just now";
	for (let i = 1; i < RELATIVE_THRESHOLDS.length; i++) {
		const cur = RELATIVE_THRESHOLDS[i];
		const prev = RELATIVE_THRESHOLDS[i - 1];
		if (!cur || !prev) continue;
		if (diff < cur[0]) return `${Math.floor(diff / prev[0])}${cur[1]} ago`;
	}
	return d.toLocaleDateString();
}
