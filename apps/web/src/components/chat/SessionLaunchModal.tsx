import { useEffect, useMemo, useState } from "react";
import { Check, FolderOpen, Loader2, Search } from "lucide-react";
import type { ModelRef } from "@omp-deck/protocol";

import { DirBrowserModal } from "@/components/DirBrowserModal";
import { Modal } from "@/components/ui/Modal";
import { useModelCatalog } from "@/lib/model-catalog";
import { useStore } from "@/lib/store";
import { cn, shortPath } from "@/lib/utils";
import { formatContext } from "./ModelPickerModal";

export interface SessionLaunchOpts {
	cwd: string;
	model?: ModelRef;
	planMode: boolean;
	/** Trimmed, non-empty initial prompt, or `undefined` when left blank. */
	initialPrompt?: string;
}

/** Sentinel `<select>` value that switches the workspace picker into
 * free-text mode for a path that isn't a known workspace yet. Mirrors
 * `SessionPicker`/`Sidebar`'s `CUSTOM_CWD_VALUE`. */
const CUSTOM_CWD_VALUE = "__custom__";

interface Props {
	open: boolean;
	/** Heading shown in the modal titlebar, e.g. "New session" or "Send to agent — T-44". */
	title?: string;
	confirmLabel?: string;
	initialCwd: string;
	/** When false, the workspace is fixed to `initialCwd` (still shown, read-only). */
	allowWorkspaceChange?: boolean;
	onCancel: () => void;
	/**
	 * Creates the session. Throwing keeps the modal open with the error
	 * surfaced inline and every field (workspace/model/plan mode) intact so
	 * the user can retry without re-entering anything (T-41).
	 */
	onConfirm: (opts: SessionLaunchOpts) => Promise<void>;
	/**
	 * Show the optional "Initial prompt" textarea. Off for Tasks/Inbox launches
	 * (T-41/T-44), which already build their own contextual draft from the
	 * task/inbox item — showing a second free-form field there would be
	 * redundant and confusing. On (default) for plain "New session" entry
	 * points, where it lets the user hand the agent an instruction up front
	 * without needing Plan Mode just to avoid an empty first turn.
	 */
	showInitialPrompt?: boolean;
}

/**
 * Shared "how should this session start" panel (T-40). Presents workspace,
 * model, and Plan Mode as one atomic choice consumed by `POST /sessions`
 * (T-39) so every "New session" entry point — Sidebar, SessionPicker, chat
 * header, and Tasks/Inbox "Open in chat" / "Send to agent" (T-41/T-44) —
 * produces the same request shape for equivalent choices.
 */
export function SessionLaunchModal({
	open,
	title = "New session",
	confirmLabel = "Start session",
	initialCwd,
	allowWorkspaceChange = true,
	onCancel,
	onConfirm,
	showInitialPrompt = true,
}: Props) {
	const workspaces = useStore((s) => s.workspaces);
	const defaultCwd = useStore((s) => s.defaultCwd);

	const [selectedCwd, setSelectedCwd] = useState<string>(initialCwd);
	const [customCwd, setCustomCwd] = useState<string>("");
	const [browsing, setBrowsing] = useState(false);
	const [planMode, setPlanMode] = useState(false);
	const [model, setModel] = useState<ModelRef | undefined>(undefined);
	const [modelTouched, setModelTouched] = useState(false);
	const [initialPrompt, setInitialPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const isCustomCwd = selectedCwd === CUSTOM_CWD_VALUE;
	const cwd = isCustomCwd ? customCwd.trim() : selectedCwd || defaultCwd;

	// Reset transient UI state fresh on every open — but NOT on error, so a
	// failed create (T-41 retry requirement) keeps the user's choices intact.
	useEffect(() => {
		if (!open) return;
		setSelectedCwd(initialCwd || defaultCwd);
		setCustomCwd("");
		setPlanMode(false);
		setModel(undefined);
		setModelTouched(false);
		setInitialPrompt("");
		setError(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const workspaceDefaultModel = useMemo(
		() => workspaces.find((w) => w.cwd === cwd)?.defaultModel,
		[workspaces, cwd],
	);

	// Preselect the workspace's effective default model (T-42) the first time
	// it becomes known for the chosen cwd, unless the user already picked one.
	useEffect(() => {
		if (modelTouched) return;
		if (workspaceDefaultModel) setModel(workspaceDefaultModel);
	}, [workspaceDefaultModel, modelTouched]);

	const {
		loading: modelsLoading,
		error: modelsError,
		query,
		setQuery,
		availableCount,
		grouped,
	} = useModelCatalog(undefined, open);

	async function confirm(): Promise<void> {
		if (isCustomCwd && !cwd) return;
		setBusy(true);
		setError(undefined);
		try {
			const trimmedPrompt = initialPrompt.trim();
			await onConfirm({ cwd, model, planMode, initialPrompt: trimmedPrompt || undefined });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal open={open} onClose={onCancel} widthClass="max-w-2xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">{title}</div>
			</div>

			<div className="max-h-[70vh] overflow-y-auto px-4 py-3">
				<div className="mb-3">
					<div className="meta mb-1.5">Workspace</div>
					{allowWorkspaceChange ? (
						<>
							<select
								value={selectedCwd}
								onChange={(e) => setSelectedCwd(e.target.value)}
								className="field h-8 w-full px-2 font-mono text-xs"
							>
								<option value="">{`(default) ${defaultCwd}`}</option>
								<option value={CUSTOM_CWD_VALUE}>+ New path…</option>
								{workspaces
									.filter((w) => w.cwd !== defaultCwd)
									.map((w) => (
										<option key={w.cwd} value={w.cwd}>
											{w.label} · {w.cwd}
										</option>
									))}
							</select>
							{isCustomCwd ? (
								<div className="mt-2 flex gap-1.5">
									<input
										type="text"
										autoFocus
										value={customCwd}
										onChange={(e) => setCustomCwd(e.target.value)}
										placeholder="/absolute/path/to/project"
										spellCheck={false}
										className="field h-8 flex-1 px-2 font-mono text-xs"
									/>
									<button
										type="button"
										onClick={() => setBrowsing(true)}
										className="h-8 shrink-0 rounded border border-line bg-paper-2 px-2 text-ink-2 hover:bg-paper-3/60"
										title="Browse for a folder"
									>
										<FolderOpen className="h-3.5 w-3.5" />
									</button>
								</div>
							) : (
								<div className="mt-1.5 truncate font-mono text-2xs text-ink-3" title={cwd}>
									{shortPath(cwd, 80)}
								</div>
							)}
						</>
					) : (
						<div className="truncate rounded border border-line bg-paper-2 px-2 py-1.5 font-mono text-xs text-ink-2" title={cwd}>
							{cwd}
						</div>
					)}
				</div>

				<div className="mb-3">
					<div className="mb-1.5 flex items-center gap-2">
						<div className="meta">Model</div>
						{workspaceDefaultModel ? (
							<span className="font-mono text-2xs text-ink-4">
								workspace default: {workspaceDefaultModel.provider}/{workspaceDefaultModel.id}
							</span>
						) : (
							<span className="font-mono text-2xs text-ink-4">falls back to the global/SDK default</span>
						)}
					</div>
					<div className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1.5">
						<Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Filter by name, id, or provider — leave empty to use the default"
							className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none"
						/>
						{modelsLoading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-3" /> : null}
					</div>
					<div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-line">
						<button
							type="button"
							onClick={() => {
								setModel(undefined);
								setModelTouched(true);
							}}
							className={cn(
								"flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm transition-colors",
								!model ? "bg-accent-soft/40 text-accent" : "text-ink-2 hover:bg-paper-3/60",
							)}
						>
							<span className="flex-1">Use default{workspaceDefaultModel ? " (workspace override above)" : ""}</span>
							{!model ? <Check className="h-4 w-4 shrink-0" /> : null}
						</button>
						{modelsError ? (
							<div className="px-3 py-3 font-mono text-2xs text-danger">{modelsError}</div>
						) : (
							grouped.map((g) => (
								<div key={g.provider}>
									<div className="border-b border-line bg-paper-2 px-3 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
										{g.provider}
									</div>
									{g.items.map((m) => {
										const active = model?.provider === m.provider && model?.id === m.id;
										return (
											<button
												key={`${m.provider}/${m.id}`}
												type="button"
												onClick={() => {
													setModel({ provider: m.provider, id: m.id });
													setModelTouched(true);
												}}
												className={cn(
													"flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm last:border-b-0 transition-colors",
													active ? "bg-accent-soft/40 text-accent" : "text-ink hover:bg-paper-3/60",
												)}
											>
												<span className="min-w-0 flex-1 truncate">{m.label}</span>
												{m.contextWindow ? (
													<span className="shrink-0 font-mono text-2xs text-ink-3">
														ctx {formatContext(m.contextWindow)}
													</span>
												) : null}
												{active ? <Check className="h-4 w-4 shrink-0" /> : null}
											</button>
										);
									})}
								</div>
							))
						)}
						{!modelsLoading && !modelsError && grouped.length === 0 ? (
							<div className="px-3 py-3 text-center text-xs text-ink-3">
								No matching models with configured auth ({availableCount} available total).
							</div>
						) : null}
					</div>
				</div>

				<label className="flex items-center gap-2 text-sm text-ink-2">
					<input
						type="checkbox"
						checked={planMode}
						onChange={(e) => setPlanMode(e.target.checked)}
						className="h-3.5 w-3.5"
					/>
					Start in Plan Mode
				</label>

				{showInitialPrompt ? (
					<div className="mt-3">
						<div className="meta mb-1.5">Initial prompt (optional)</div>
						<textarea
							value={initialPrompt}
							onChange={(e) => setInitialPrompt(e.target.value)}
							rows={3}
							placeholder="Give the agent an instruction to start with — combined with /start (if configured) into one turn, not sent automatically."
							className="field w-full resize-none px-2 py-1.5 text-sm"
						/>
					</div>
				) : null}

				{error ? (
					<div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
			</div>

			<div className="flex items-center justify-end gap-2 border-t border-line bg-paper-2/60 px-3 py-2">
				<button type="button" onClick={onCancel} className="btn-ghost h-8 px-3 text-xs" disabled={busy}>
					Cancel
				</button>
				<button
					type="button"
					onClick={() => void confirm()}
					disabled={busy || (isCustomCwd && !cwd)}
					className={cn("btn-primary h-8 px-3 text-xs", busy && "opacity-60")}
				>
					{busy ? "Starting…" : confirmLabel}
				</button>
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
		</Modal>
	);
}
