import { useEffect, useMemo, useState } from "react";
import { Archive, Bot, CheckCircle2, Circle, Link2, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import type { Task, TaskPriority, TaskState } from "@omp-deck/protocol";

import { MarkdownEdit } from "@/components/MarkdownEdit";
import { Modal } from "@/components/ui/Modal";
import { candidateDependencyTasks, resolveDependencyTasks, resolveDependentTasks } from "@/lib/task-dependencies";
import { cn } from "@/lib/utils";

const PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4", "P5"];

interface Props {
	task: Task | null;
	states: TaskState[];
	/** Full task list, used to resolve dependency titles/state (T-57). */
	allTasks: Task[];
	onClose: () => void;
	onSave: (patch: {
		title?: string;
		body?: string;
		stateId?: string;
		cwd?: string;
		priority?: TaskPriority;
		dependsOn?: string[];
	}) => void;
	onDelete: () => void;
	onArchive: () => void;
	onOpenInChat: () => void;
	/** Same-flavor launch as `onOpenInChat` but with a short `T-<id>` reference
	 * draft instead of the full title+body (T-44) — the agent re-reads the
	 * task itself via `GET /api/tasks` instead of paying for the body twice. */
	onSendToAgent: () => void;
}

/**
 * Centered modal for full task detail / edit. Title is a large inline-editable
 * input; body uses MarkdownEdit (rendered by default, click to edit). The
 * action bar mirrors the inbox reader for consistency: state-change on the
 * left, archive / delete / Send-to-agent / Open-in-chat / close on the right.
 */
export function TaskModal({
	task,
	states,
	allTasks,
	onClose,
	onSave,
	onDelete,
	onArchive,
	onOpenInChat,
	onSendToAgent,
}: Props) {
	const open = task !== null;

	// Local mirror of editable fields so we can commit on blur without
	// thrashing the API on every keystroke.
	const [title, setTitle] = useState("");
	const [stateId, setStateId] = useState("");
	const [cwd, setCwd] = useState("");

	useEffect(() => {
		if (!task) return;
		setTitle(task.title);
		setStateId(task.stateId);
		setCwd(task.cwd ?? "");
	}, [task]);

	// Resolved-to-full-Task dependency lists for the picker (T-57); pure logic
	// lives in task-dependencies.ts so it has plain unit tests.
	const dependencyTasks = useMemo(
		() => (task ? resolveDependencyTasks(task, allTasks) : []),
		[task, allTasks],
	);
	const candidateTasks = useMemo(
		() => (task ? candidateDependencyTasks(task, allTasks) : []),
		[task, allTasks],
	);
	const dependentTasks = useMemo(
		() => (task ? resolveDependentTasks(task, allTasks) : []),
		[task, allTasks],
	);

	if (!task) return null;

	function commitTitle(): void {
		if (!task) return;
		if (title !== task.title) onSave({ title });
	}
	function commitState(next: string): void {
		setStateId(next);
		if (!task || next === task.stateId) return;
		onSave({ stateId: next });
	}
	function commitPriority(next: TaskPriority): void {
		if (!task || next === task.priority) return;
		onSave({ priority: next });
	}
	function commitCwd(): void {
		if (!task) return;
		const next = cwd.trim() || undefined;
		if ((task.cwd ?? "") !== (next ?? "")) onSave({ cwd: next });
	}
	function addDependency(depId: string): void {
		if (!task || !depId || task.dependsOn.includes(depId)) return;
		onSave({ dependsOn: [...task.dependsOn, depId] });
	}
	function removeDependency(depId: string): void {
		if (!task) return;
		onSave({ dependsOn: task.dependsOn.filter((id) => id !== depId) });
	}

	const isArchived = Boolean(task.archivedAt);

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-3xl">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
				<span
					className="flex h-8 shrink-0 items-center rounded-md border border-line bg-paper-2 px-2.5 font-mono text-sm font-semibold uppercase tracking-meta text-ink-2"
					title={task.id}
				>
					T-{task.displayId}
				</span>
				<select
					value={stateId}
					onChange={(e) => commitState(e.target.value)}
					className="field h-8 px-2 font-mono text-2xs uppercase tracking-meta"
				>
					{states.map((s) => (
						<option key={s.id} value={s.id}>
							{s.name}
						</option>
					))}
				</select>
				<div
					className="h-2 w-2 rounded-full"
					style={{
						backgroundColor:
							states.find((s) => s.id === stateId)?.color ?? "var(--ink-3, #6e6a62)",
					}}
				/>
				<select
					value={task.priority}
					onChange={(e) => commitPriority(e.target.value as TaskPriority)}
					title="Priority — P0 highest, P5 lowest"
					className="field h-8 px-2 font-mono text-2xs uppercase tracking-meta"
				>
					{PRIORITIES.map((p) => (
						<option key={p} value={p}>
							{p}
						</option>
					))}
				</select>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<IconAction
						label={isArchived ? "Unarchive" : "Archive"}
						icon={isArchived ? RotateCcw : Archive}
						onClick={onArchive}
					/>
					<IconAction label="Delete" icon={Trash2} tone="danger" onClick={onDelete} />
					<button
						type="button"
						onClick={onSendToAgent}
						className="btn-ghost h-8 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-sm"
						title="Assign a short T-N reference as the first prompt — the agent reads the full task itself"
					>
						<Bot className="h-4 w-4 shrink-0" />
						<span>Assign to agent</span>
					</button>
					<button
						type="button"
						onClick={onOpenInChat}
						className="btn-primary h-8 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-sm"
						title="Open this task as a new chat session"
					>
						<MessageSquarePlus className="h-4 w-4 shrink-0" />
						<span>Open in chat</span>
					</button>
					<IconAction label="Close" icon={X} onClick={onClose} />
				</div>
			</header>

			<div className="shrink-0 border-b border-line px-6 pt-5 pb-3">
				<input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={commitTitle}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					}}
					placeholder="Untitled task"
					className={cn(
						"w-full bg-transparent text-xl font-semibold text-ink placeholder:text-ink-4 focus:outline-none",
						isArchived && "text-ink-3 line-through",
					)}
				/>
				<div className="mt-1 grid grid-cols-[max-content_1fr_max-content_1fr] gap-x-4 gap-y-1 font-mono text-2xs text-ink-3">
					<span className="text-ink-4">created</span>
					<span>{new Date(task.createdAt).toLocaleString()}</span>
					<span className="text-ink-4">updated</span>
					<span>{new Date(task.updatedAt).toLocaleString()}</span>
					<span className="text-ink-4">cwd</span>
					<span className="col-span-3">
						<input
							value={cwd}
							onChange={(e) => setCwd(e.target.value)}
							onBlur={commitCwd}
							placeholder="(defaults to server cwd)"
							className="w-full bg-transparent font-mono text-2xs text-ink placeholder:text-ink-4 focus:outline-none"
						/>
					</span>
					{isArchived ? (
						<>
							<span className="text-warn">archived</span>
							<span>{new Date(task.archivedAt!).toLocaleString()}</span>
						</>
					) : null}
				</div>
			</div>

			<div className="shrink-0 border-b border-line px-6 py-3">
				<div className="mb-2 flex items-center gap-1.5 font-mono text-2xs uppercase tracking-meta text-ink-4">
					<Link2 className="h-3.5 w-3.5" />
					<span>Depends on</span>
				</div>
				<div className="flex flex-wrap items-center gap-1.5">
					{dependencyTasks.map((dep) => {
						const depState = states.find((s) => s.id === dep.stateId);
						const isDone = depState?.name.toLowerCase() === "done";
						return (
							<span
								key={dep.id}
								className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper-2 py-1 pl-2 pr-1 text-xs text-ink-2"
								title={dep.title}
							>
								{isDone ? (
									<CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
								) : (
									<Circle
										className="h-3.5 w-3.5 shrink-0"
										style={{ color: depState?.color ?? "var(--ink-3, #6e6a62)" }}
									/>
								)}
								<span className="font-mono text-2xs text-ink-4">T-{dep.displayId}</span>
								<span className="max-w-[16rem] truncate">{dep.title || "Untitled task"}</span>
								<span className="text-2xs text-ink-4">{depState?.name ?? "?"}</span>
								<button
									type="button"
									onClick={() => removeDependency(dep.id)}
									aria-label={`Remove dependency T-${dep.displayId}`}
									className="flex h-4 w-4 items-center justify-center rounded-sm text-ink-4 hover:bg-danger/10 hover:text-danger"
								>
									<X className="h-3 w-3" />
								</button>
							</span>
						);
					})}
					{candidateTasks.length > 0 ? (
						<select
							value=""
							onChange={(e) => addDependency(e.target.value)}
							className="field h-7 px-2 text-2xs"
							aria-label="Add dependency"
						>
							<option value="">+ Add dependency…</option>
							{candidateTasks.map((c) => (
								<option key={c.id} value={c.id}>
									T-{c.displayId} {c.title || "Untitled task"}
								</option>
							))}
						</select>
					) : dependencyTasks.length === 0 ? (
						<span className="text-2xs text-ink-4">No other tasks to depend on yet.</span>
					) : null}
				</div>
			</div>
			{dependentTasks.length > 0 && (
				<div className="shrink-0 border-b border-line px-6 py-3">
					<div className="mb-2 flex items-center gap-1.5 font-mono text-2xs uppercase tracking-meta text-ink-4">
						<Link2 className="h-3.5 w-3.5" />
						<span>Required by</span>
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						{dependentTasks.map((dep) => {
							const depState = states.find((s) => s.id === dep.stateId);
							const isDone = depState?.name.toLowerCase() === "done";
							return (
								<span
									key={dep.id}
									className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper-2 py-1 px-2 text-xs text-ink-2"
									title={dep.title}
								>
									{isDone ? (
										<CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
									) : (
										<Circle
											className="h-3.5 w-3.5 shrink-0"
											style={{ color: depState?.color ?? "var(--ink-3, #6e6a62)" }}
										/>
									)}
									<span className="font-mono text-2xs text-ink-4">T-{dep.displayId}</span>
									<span className="max-w-[16rem] truncate">{dep.title || "Untitled task"}</span>
									<span className="text-2xs text-ink-4">{depState?.name ?? "?"}</span>
								</span>
							);
						})}
					</div>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
				<MarkdownEdit
					value={task.body}
					onChange={(next) => onSave({ body: next })}
					placeholder="Click to add notes — markdown supported. Use this for context, acceptance criteria, links."
				/>
			</div>
		</Modal>
	);
}

function IconAction({
	label,
	icon: Icon,
	onClick,
	tone = "default",
}: {
	label: string;
	icon: typeof Trash2;
	onClick: () => void;
	tone?: "default" | "danger";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={cn(
				"flex h-8 w-8 items-center justify-center rounded-md transition-colors",
				tone === "danger"
					? "text-ink-3 hover:bg-danger/10 hover:text-danger"
					: "text-ink-3 hover:bg-paper-3 hover:text-ink",
			)}
		>
			<Icon className="h-4 w-4" />
		</button>
	);
}
