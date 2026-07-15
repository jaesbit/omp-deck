import { useEffect, useState } from "react";
import { GitBranch, X } from "lucide-react";
import type { SessionTreeEntryWire, SessionTreeNodeWire, SessionTreeResponse } from "@omp-deck/protocol";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn, formatTimestamp } from "@/lib/utils";

interface Props {
	open: boolean;
	sessionId: string;
	onClose: () => void;
}

const KIND_LABEL: Record<SessionTreeEntryWire["kind"], string> = {
	user_message: "Usuario",
	assistant_message: "Asistente",
	tool_message: "Herramienta",
	message: "Mensaje",
	thinking_level_change: "Thinking",
	model_change: "Modelo",
	service_tier_change: "Service tier",
	compaction: "Compactación",
	branch_summary: "Resumen de rama",
	custom: "Extensión",
	custom_message: "Extensión",
	label: "Marcador",
	title_change: "Título",
	ttsr_injection: "TTSR",
	mcp_tool_selection: "MCP",
	session_init: "Init",
	mode_change: "Modo",
};

/**
 * Timeline of a session's append-only entry tree (T-31). Read-only browsing
 * plus "Bifurcar" on any entry, which creates a brand-new session rooted at
 * that point via `POST /sessions/:id/branch` — the source session's history
 * is never touched, so it stays safe to return to from the Sidebar or the
 * header's Switch dropdown.
 */
export function SessionTreeModal({ open, sessionId, onClose }: Props) {
	const branchSession = useStore((s) => s.branchSession);
	const createSession = useStore((s) => s.createSession);
	const [tree, setTree] = useState<SessionTreeResponse | undefined>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [busyEntryId, setBusyEntryId] = useState<string | undefined>();

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		setError(undefined);
		api
			.sessionTree(sessionId)
			.then((res) => {
				if (!cancelled) setTree(res);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, sessionId]);

	async function fork(entryId: string): Promise<void> {
		setBusyEntryId(entryId);
		setError(undefined);
		try {
			await branchSession(sessionId, entryId);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyEntryId(undefined);
		}
	}

	async function goToParent(): Promise<void> {
		if (!tree?.parentSessionPath) return;
		try {
			await createSession({ cwd: tree.cwd, resumeFromPath: tree.parentSessionPath });
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-2xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<GitBranch className="h-4 w-4 text-ink-3" />
				<div className="meta">Árbol de sesión</div>
				<div className="flex-1" />
				<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
					<X className="h-4 w-4" />
				</Button>
			</div>

			{tree?.parentSessionPath ? (
				<div className="flex items-center gap-2 border-b border-line bg-paper-2/60 px-3 py-2 font-mono text-2xs text-ink-3">
					<span>Esta sesión es una bifurcación de otra.</span>
					<button type="button" className="text-accent hover:underline" onClick={() => void goToParent()}>
						Ir a la sesión origen
					</button>
				</div>
			) : null}

			{error ? (
				<div className="mx-3 my-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			<div className="max-h-[65vh] overflow-y-auto px-2 py-2">
				{loading ? (
					<div className="px-3 py-6 text-center text-sm text-ink-3">Cargando árbol...</div>
				) : null}
				{!loading && tree && tree.roots.length === 0 ? (
					<div className="px-3 py-6 text-center text-sm text-ink-3">Sesión vacía.</div>
				) : null}
				{tree?.roots.map((node) => (
					<TreeNode
						key={node.entry.id}
						node={node}
						depth={0}
						leafId={tree.leafId}
						busyEntryId={busyEntryId}
						onFork={fork}
					/>
				))}
			</div>
		</Modal>
	);
}

function TreeNode({
	node,
	depth,
	leafId,
	busyEntryId,
	onFork,
}: {
	node: SessionTreeNodeWire;
	depth: number;
	leafId: string | null;
	busyEntryId: string | undefined;
	onFork: (entryId: string) => void | Promise<void>;
}) {
	const { entry } = node;
	const onActiveBranch = entry.id === leafId;
	const busy = busyEntryId === entry.id;
	return (
		<div>
			<div
				className={cn(
					"group flex items-start gap-2 rounded-md px-2 py-1.5",
					onActiveBranch ? "bg-accent-soft/40" : "hover:bg-paper-3/60",
				)}
				style={{ marginLeft: depth * 16 }}
			>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
							{KIND_LABEL[entry.kind]}
						</span>
						{entry.label ? (
							<span className="rounded border border-line bg-paper-2 px-1 py-px font-mono text-2xs text-ink-3">
								{entry.label}
							</span>
						) : null}
						{onActiveBranch ? (
							<span className="rounded border border-accent/40 bg-accent/10 px-1 py-px font-mono text-2xs uppercase tracking-meta text-accent">
								activa
							</span>
						) : null}
						<span className="font-mono text-2xs text-ink-4">{formatTimestamp(entry.timestamp)}</span>
					</div>
					<div className="mt-0.5 truncate text-sm text-ink">{entry.preview}</div>
				</div>
				<button
					type="button"
					disabled={busy}
					onClick={() => void onFork(entry.id)}
					className="shrink-0 rounded-md border border-line px-2 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3 opacity-0 transition-opacity hover:border-accent/40 hover:text-accent group-hover:opacity-100 disabled:opacity-50"
					title="Crea una sesión nueva a partir de este punto — no modifica esta sesión"
				>
					{busy ? "..." : "Bifurcar"}
				</button>
			</div>
			{node.children.map((child) => (
				<TreeNode
					key={child.entry.id}
					node={child}
					depth={depth + 1}
					leafId={leafId}
					busyEntryId={busyEntryId}
					onFork={onFork}
				/>
			))}
		</div>
	);
}
