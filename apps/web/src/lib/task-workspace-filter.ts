import { useCallback, useEffect, useState } from "react";

import type { Task } from "@omp-deck/protocol";

const STORAGE_KEY = "omp-deck:tasks:workspace-filter";

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

function readStoredWorkspace(): string {
	if (typeof sessionStorage === "undefined") return "";
	try {
		return sessionStorage.getItem(STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

function storeWorkspace(cwd: string): void {
	if (typeof sessionStorage === "undefined") return;
	try {
		if (cwd) sessionStorage.setItem(STORAGE_KEY, cwd);
		else sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// Disabled storage or private mode: retain the selection in memory only.
	}
}

/** Browser-session workspace selection, reset only after task workspaces load. */
export function useTaskWorkspaceFilter(
	workspaces: ReadonlyArray<string>,
	loaded: boolean,
): [string, (cwd: string) => void] {
	const [selectedCwd, setSelectedCwd] = useState(readStoredWorkspace);

	useEffect(() => {
		if (loaded && selectedCwd && !workspaces.includes(selectedCwd)) {
			setSelectedCwd("");
			storeWorkspace("");
		}
	}, [loaded, selectedCwd, workspaces]);

	const select = useCallback((cwd: string) => {
		setSelectedCwd(cwd);
		storeWorkspace(cwd);
	}, []);

	return [selectedCwd, select];
}
