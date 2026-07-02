import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Plus, RefreshCw } from "lucide-react";
import { DirBrowserModal } from "@/components/DirBrowserModal";
import { useStore } from "@/lib/store";
import { cn, shortPath } from "@/lib/utils";

/** Sentinel `<select>` value that switches the workspace picker into
 * free-text mode for a path that isn't a known workspace yet. Mirrors
 * `SessionPicker`'s `CUSTOM_CWD_VALUE`. */
const CUSTOM_CWD_VALUE = "__custom__";

export function Sidebar() {
	const workspaces = useStore((s) => s.workspaces);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const sessions = useStore((s) => s.sessions);
	const activeId = useStore((s) => s.activeId);
	const sessionsById = useStore((s) => s.sessionsById);
	const refreshSessions = useStore((s) => s.refreshSessions);
	const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);
	const createSession = useStore((s) => s.createSession);
	const selectSession = useStore((s) => s.selectSession);
	const sessionsChangeCounter = useStore((s) => s.sessionsChangeCounter);

	const [selectedCwd, setSelectedCwd] = useState<string | "">("");
	const [customCwd, setCustomCwd] = useState<string>("");
	const [creating, setCreating] = useState(false);
	const [browsing, setBrowsing] = useState(false);

	const isCustomCwd = selectedCwd === CUSTOM_CWD_VALUE;
	const cwdInUse = isCustomCwd ? customCwd.trim() : selectedCwd || defaultCwd;

	const filtered = useMemo(() => {
		if (!selectedCwd || isCustomCwd) return sessions;
		return sessions.filter((s) => s.cwd === selectedCwd);
	}, [sessions, selectedCwd, isCustomCwd]);

	// Live updates: another tab (or the REST API) renamed/repointed a session's
	// model via `PATCH /sessions/:id`. Refetch so the sidebar reflects it
	// without a manual refresh. Same pattern as `tasksChangeCounter`.
	useEffect(() => {
		if (sessionsChangeCounter === 0) return;
		void refreshSessions(selectedCwd || undefined);
	}, [sessionsChangeCounter, refreshSessions, selectedCwd]);

	async function handleNew(): Promise<void> {
		if (isCustomCwd && !cwdInUse) return;
		setCreating(true);
		try {
			await createSession({ cwd: cwdInUse });
		} catch (err) {
			console.error(err);
			alert(`Failed to create session: ${String(err)}`);
		} finally {
			setCreating(false);
		}
	}

	async function handleResume(p: string): Promise<void> {
		setCreating(true);
		try {
			await createSession({ cwd: cwdInUse, resumeFromPath: p });
		} catch (err) {
			console.error(err);
			alert(`Failed to resume: ${String(err)}`);
		} finally {
			setCreating(false);
		}
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
						if (value !== CUSTOM_CWD_VALUE) void refreshSessions(value || undefined);
					}}
					className="field h-7 w-full px-2 font-mono text-xs"
				>
					<option value="">(all workspaces)</option>
					<option value={CUSTOM_CWD_VALUE}>+ New path…</option>
					{workspaces.map((w) => (
						<option key={w.cwd} value={w.cwd}>
							{w.label} · {w.sessionCount}
						</option>
					))}
				</select>
				{isCustomCwd ? (
					<div className="flex gap-1.5">
						<input
							type="text"
							autoFocus
							value={customCwd}
							onChange={(e) => setCustomCwd(e.target.value)}
							placeholder="/absolute/path/to/project"
							spellCheck={false}
							className="field h-7 flex-1 px-2 font-mono text-xs"
						/>
						<button
							type="button"
							onClick={() => setBrowsing(true)}
							className="h-7 shrink-0 rounded border border-line bg-paper-2 px-1.5 text-ink-2 hover:bg-paper-3/60"
							title="Browse for a folder"
						>
							<FolderOpen className="h-3.5 w-3.5" />
						</button>
					</div>
				) : (
					<div className="truncate font-mono text-2xs text-ink-3" title={cwdInUse}>
						{cwdInUse}
					</div>
				)}
				<button
					type="button"
					className="btn-primary h-8 w-full text-[13px]"
					onClick={() => void handleNew()}
					disabled={creating || (isCustomCwd && !cwdInUse)}
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
						title={s.sessionName || formatSessionId(s.sessionId)}
						subtitle={shortPath(s.cwd, 30)}
						active={s.sessionId === activeId}
						live
						planMode={s.planMode?.enabled === true}
						onClick={() => selectSession(s.sessionId)}
					/>
				))}

				{liveSessions.length > 0 && persisted.length > 0 ? (
					<div className="my-2 mx-2 border-t border-line" />
				) : null}

				{persisted.map((s) => (
					<SessionRow
						key={s.id}
						title={s.title || formatSessionId(s.id)}
						subtitle={`${shortPath(s.cwd, 26)} · ${s.messageCount}m`}
						meta={formatRelative(s.updatedAt || s.createdAt)}
						onClick={() => void handleResume(s.path)}
					/>
				))}

				{filtered.length === 0 && liveSessions.length === 0 ? (
					<div className="px-3 py-6 text-center font-mono text-2xs text-ink-3">
						No sessions yet.
					</div>
				) : null}
			</div>
			<DirBrowserModal
				open={browsing}
				initialPath={customCwd || defaultCwd}
				onClose={() => setBrowsing(false)}
				onSelect={(path) => {
					setCustomCwd(path);
					setBrowsing(false);
				}}
			/>
		</div>
	);
}

function SessionRow({
	title,
	subtitle,
	meta,
	active,
	live,
	planMode,
	onClick,
}: {
	title: string;
	subtitle?: string;
	meta?: string;
	active?: boolean;
	live?: boolean;
	planMode?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"group block w-full rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
				active ? "bg-paper-3 text-ink" : "text-ink-2 hover:bg-paper-3/60",
			)}
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
