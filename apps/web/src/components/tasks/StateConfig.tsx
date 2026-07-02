import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { Task, TaskState } from "@omp-deck/protocol";
import type { ProjectColorMap } from "@/lib/project-colors";
import { tasksApi } from "@/lib/tasks-api";

interface Props {
	states: TaskState[];
	tasks: Task[];
	projectColors: ProjectColorMap;
	onProjectColorChange: (cwd: string, color: string | undefined) => void;
	onClose: () => void;
	onChanged: () => void;
}

const PRESET_COLORS = [
	"#6e6a62",
	"#9a3412",
	"#b45309",
	"#15803d",
	"#6b21a8",
	"#0e7490",
	"#991b1b",
];

/** Inline drawer to manage kanban columns: add / rename / recolor / delete. */
export function StateConfig({
	states,
	tasks,
	projectColors,
	onProjectColorChange,
	onClose,
	onChanged,
}: Props) {
	const [newName, setNewName] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | undefined>();
	const projectCwds = useMemo(() => {
		const cwds = new Set<string>();
		for (const task of tasks) {
			if (task.cwd) cwds.add(task.cwd);
		}
		return [...cwds].sort();
	}, [tasks]);

	useEffect(() => setErr(undefined), [states.length]);

	async function add(): Promise<void> {
		const name = newName.trim();
		if (!name) return;
		setBusy(true);
		try {
			await tasksApi.createState({ name });
			setNewName("");
			onChanged();
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function rename(state: TaskState, name: string): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed || trimmed === state.name) return;
		try {
			await tasksApi.updateState(state.id, { name: trimmed });
			onChanged();
		} catch (e) {
			setErr(String(e));
		}
	}

	async function recolor(state: TaskState, color: string): Promise<void> {
		try {
			await tasksApi.updateState(state.id, { color });
			onChanged();
		} catch (e) {
			setErr(String(e));
		}
	}

	async function remove(state: TaskState): Promise<void> {
		if (state.isDefault) return;
		if (!confirm(`Delete column "${state.name}"? Tasks will move to the default column.`)) return;
		try {
			await tasksApi.removeState(state.id);
			onChanged();
		} catch (e) {
			setErr(String(e));
		}
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">Board</div>
				<button
					type="button"
					onClick={onClose}
					className="btn-ghost ml-auto h-7 w-7 p-0"
					aria-label="Close"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto p-3">
				<ul className="space-y-3">
					{states.map((s) => (
						<li key={s.id} className="border border-line bg-paper-2 px-3 py-2">
							<div className="flex items-center gap-2">
								<input
									defaultValue={s.name}
									onBlur={(e) => void rename(s, e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") (e.target as HTMLInputElement).blur();
									}}
									className="field h-7 flex-1 px-2 text-sm"
								/>
								{s.isDefault ? (
									<span className="font-mono text-2xs text-ink-4">default</span>
								) : (
									<button
										type="button"
										onClick={() => void remove(s)}
										className="text-ink-3 hover:text-danger"
										aria-label="Delete column"
										title="Delete column"
									>
										<Trash2 className="h-3.5 w-3.5" />
									</button>
								)}
							</div>
							<div className="mt-2 flex items-center gap-1.5">
								{PRESET_COLORS.map((c) => (
									<button
										key={c}
										type="button"
										onClick={() => void recolor(s, c)}
										title={c}
										aria-label={`Set color ${c}`}
										className={
											"h-4 w-4 rounded-full border border-line-strong"
										}
										style={{
											backgroundColor: c,
											boxShadow:
												s.color === c ? "0 0 0 2px var(--paper), 0 0 0 3px var(--ink)" : undefined,
										}}
									/>
								))}
							</div>
						</li>
					))}
				</ul>

				<div className="mt-4 border border-line bg-paper-2 px-3 py-2">
					<div className="meta">Project colors</div>
					<p className="mt-1 text-xs text-ink-3">
						Map a workspace to a color. Unmapped workspaces have no card marker.
					</p>
					{projectCwds.length === 0 ? (
						<div className="mt-2 text-xs text-ink-4">No task workspaces yet.</div>
					) : (
						<ul className="mt-3 space-y-2">
							{projectCwds.map((cwd) => {
								const color = projectColors[cwd];
								return (
									<li key={cwd} className="flex items-center gap-2">
										<input
											type="color"
											value={color ?? "#6e6a62"}
											onChange={(event) => onProjectColorChange(cwd, event.target.value)}
											aria-label={`Set project color for ${cwd}`}
											className="h-7 w-7 shrink-0 cursor-pointer rounded border border-line bg-paper p-0.5"
										/>
										<span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-2" title={cwd}>
											{cwd}
										</span>
										{color ? (
											<button
												type="button"
												onClick={() => onProjectColorChange(cwd, undefined)}
												className="btn-ghost h-7 px-2 text-2xs"
											>
												Clear
											</button>
										) : (
											<span className="font-mono text-2xs text-ink-4">unset</span>
										)}
									</li>
								);
							})}
						</ul>
					)}
				</div>

				<div className="mt-4 border border-line bg-paper-2 px-3 py-2">
					<div className="meta mb-1.5">Add column</div>
					<div className="flex items-center gap-1.5">
						<input
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void add();
							}}
							placeholder="Column name"
							className="field h-7 flex-1 px-2 text-sm"
						/>
						<button
							type="button"
							onClick={() => void add()}
							disabled={busy || newName.trim().length === 0}
							className="btn-primary h-7 px-2 text-xs"
						>
							<Plus className="h-3.5 w-3.5" />
							Add
						</button>
					</div>
				</div>

				{err ? <div className="mt-3 text-xs text-danger">{err}</div> : null}
			</div>
		</div>
	);
}
