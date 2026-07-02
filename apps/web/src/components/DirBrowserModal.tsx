import { useEffect, useState } from "react";
import { ArrowUp, Folder, Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";

interface Props {
	open: boolean;
	/** Directory to open on first render. Falls back to $HOME server-side when omitted/invalid. */
	initialPath?: string;
	onClose: () => void;
	/** Called with the currently browsed (absolute) path when the user confirms. */
	onSelect: (path: string) => void;
}

/**
 * Folder-only browser for picking an absolute workspace path from the
 * server's filesystem. Backed by `GET /fs/browse`, which is sandboxed to
 * $HOME the same way `/fs/complete` is — this can never list `/etc` or a
 * sibling user's home. Used by both `Sidebar` and `SessionPicker` so a new
 * workspace path can be picked without typing it blind.
 */
export function DirBrowserModal({ open, initialPath, onClose, onSelect }: Props) {
	const [path, setPath] = useState<string>("");
	const [parent, setParent] = useState<string | null>(null);
	const [dirs, setDirs] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function load(target: string | undefined): Promise<void> {
		setLoading(true);
		setError(null);
		try {
			const resp = await api.browseDir(target);
			setPath(resp.path);
			setParent(resp.parent);
			setDirs(resp.dirs);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		if (!open) return;
		void load(initialPath?.trim() || undefined);
		// Only re-run when the dialog opens, not on every initialPath keystroke —
		// the browser has its own internal navigation once mounted.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	if (!open) return null;

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-md" heightClass="max-h-[70vh]">
			<div className="flex items-center justify-between border-b border-line bg-paper-2/60 px-3 py-2">
				<div className="meta">Choose a folder</div>
			</div>

			<div className="border-b border-line px-3 py-2">
				<div className="truncate font-mono text-2xs text-ink-3" title={path}>
					{path || "…"}
				</div>
			</div>

			<div className="flex-1 overflow-y-auto px-1 py-1">
				{loading ? (
					<div className="flex items-center justify-center gap-2 py-8 text-ink-3">
						<Loader2 className="h-4 w-4 animate-spin" />
						<span className="text-xs">Loading…</span>
					</div>
				) : error ? (
					<div className="px-3 py-6 text-center text-xs text-danger">{error}</div>
				) : (
					<>
						{parent !== null ? (
							<button
								type="button"
								onClick={() => void load(parent)}
								className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-paper-3/60"
							>
								<ArrowUp className="h-3.5 w-3.5 shrink-0 text-ink-3" />
								<span className="text-ink-3">..</span>
							</button>
						) : null}
						{dirs.length === 0 ? (
							<div className="px-3 py-6 text-center font-mono text-2xs text-ink-3">
								No subfolders here.
							</div>
						) : (
							dirs.map((name) => (
								<button
									key={name}
									type="button"
									onClick={() => void load(`${path}/${name}`)}
									className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-paper-3/60"
								>
									<Folder className="h-3.5 w-3.5 shrink-0 text-ink-3" />
									<span className="flex-1 truncate text-ink">{name}</span>
								</button>
							))
						)}
					</>
				)}
			</div>

			<div className="flex items-center justify-end gap-2 border-t border-line bg-paper-2/60 px-3 py-2">
				<button type="button" onClick={onClose} className="btn-ghost h-8 px-3 text-xs">
					Cancel
				</button>
				<button
					type="button"
					disabled={!path || loading || !!error}
					onClick={() => onSelect(path)}
					className={cn("btn-primary h-8 px-3 text-xs", (!path || loading || !!error) && "opacity-60")}
				>
					Use this folder
				</button>
			</div>
		</Modal>
	);
}
