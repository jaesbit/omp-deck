/**
 * Pure helpers backing the TaskModal dependency picker (T-57). Extracted out
 * of the component so the id-resolution/filtering logic has plain unit tests
 * instead of needing a hook-rendering harness (same rationale as
 * `model-catalog.ts`'s `groupModels()`).
 */
import type { Task } from "@omp-deck/protocol";

/**
 * Resolve `task.dependsOn` ids to their full `Task` objects, in the order
 * they were added. Silently drops ids that no longer resolve — e.g. a stale
 * in-memory snapshot racing a dependency's deletion (the DB cascade already
 * cleaned up the edge server-side).
 */
export function resolveDependencyTasks(task: Task, allTasks: Task[]): Task[] {
	const byId = new Map(allTasks.map((t) => [t.id, t]));
	const resolved: Task[] = [];
	for (const depId of task.dependsOn) {
		const dep = byId.get(depId);
		if (dep) resolved.push(dep);
	}
	return resolved;
}

/**
 * Tasks eligible to be added as a new dependency of `task`: every other
 * non-archived task not already listed, sorted by display id for a stable
 * picker order.
 */
export function candidateDependencyTasks(task: Task, allTasks: Task[]): Task[] {
	const existing = new Set(task.dependsOn);
	return allTasks
		.filter((t) => t.id !== task.id && !existing.has(t.id) && !t.archivedAt)
		.sort((a, b) => a.displayId - b.displayId);
}
