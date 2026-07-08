import { useEffect } from "react";

import type { Task } from "@omp-deck/protocol";

import { usePersistedViewState } from "./use-persisted-view-state";

/** Returns distinct task workspaces in stable display order. */
export function taskWorkspaces(tasks: ReadonlyArray<Task>): string[] {
	const workspaces = new Set<string>();
	for (const task of tasks) {
		if (task.cwd) workspaces.add(task.cwd);
	}
	return [...workspaces].sort((left, right) => left.localeCompare(right));
}

/** Empty selection is the all-workspaces view. Tasks without a cwd stay there. */
export function filterTasksByWorkspace(tasks: ReadonlyArray<Task>, cwd: string): Task[] {
	return cwd ? tasks.filter((task) => task.cwd === cwd) : [...tasks];
}

/** Per-session workspace selection, restored when the session is re-opened.
 * Resets to "all workspaces" if the stored cwd is no longer in the task list. */
export function useTaskWorkspaceFilter(
	workspaces: ReadonlyArray<string>,
	loaded: boolean,
): [string, (cwd: string) => void] {
	const [selectedCwd, setSelectedCwd] = usePersistedViewState("tasks.workspace", "");

	useEffect(() => {
		if (loaded && selectedCwd && !workspaces.includes(selectedCwd)) {
			setSelectedCwd("");
		}
	}, [loaded, selectedCwd, workspaces, setSelectedCwd]);

	return [selectedCwd, setSelectedCwd];
}
