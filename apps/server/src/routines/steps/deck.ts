import type { RoutineStep } from "@omp-deck/protocol";

import { createInbox, getInbox, updateInbox } from "../../db/inbox.ts";
import {
	createTask,
	findStateByName,
	findTaskByDisplayOrId,
	getDefaultState,
	getState,
	moveTask,
} from "../../db/tasks.ts";
import { renderString } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";

type DeckStep = Extract<RoutineStep, { type: "deck" }>;

export async function executeDeckStep(
	step: DeckStep,
	context: RunContext,
	_signal: AbortSignal,
): Promise<StepResult> {
	const startedMs = Date.now();
	try {
		switch (step.action) {
			case "create_inbox_item": {
				const item = createInbox({
					kind: step.kind,
					title: renderString(step.title, context as unknown as Record<string, unknown>),
					body:
						step.body === undefined
							? undefined
							: renderString(step.body, context as unknown as Record<string, unknown>),
					source:
						step.source === undefined
							? undefined
							: renderString(step.source, context as unknown as Record<string, unknown>),
				});
				return ok(
					startedMs,
					`created inbox item ${item.id} (${item.kind}): ${item.title}`,
					item,
				);
			}
			case "create_task": {
				const stateId =
					step.state_ref === undefined
						? undefined
						: resolveStateRef(renderString(step.state_ref, context as unknown as Record<string, unknown>));
				const task = createTask({
					title: renderString(step.title, context as unknown as Record<string, unknown>),
					body:
						step.body === undefined
							? undefined
							: renderString(step.body, context as unknown as Record<string, unknown>),
					stateId,
					cwd:
						step.cwd === undefined
							? undefined
							: renderString(step.cwd, context as unknown as Record<string, unknown>),
				});
				return ok(startedMs, `created task T-${task.displayId}: ${task.title}`, task);
			}
			case "move_task": {
				const taskRef = renderString(step.task_ref, context as unknown as Record<string, unknown>);
				const stateRef = renderString(step.state_ref, context as unknown as Record<string, unknown>);
				const task = findTaskByDisplayOrId(taskRef);
				if (!task) return fail(startedMs, `task not found: ${taskRef}`);
				const moved = moveTask(task.id, resolveStateRef(stateRef), step.index ?? 0);
				if (!moved) return fail(startedMs, `move failed for task: ${taskRef}`);
				return ok(startedMs, `moved task T-${moved.displayId} -> ${moved.stateId} @${step.index ?? 0}`, moved);
			}
			case "promote_inbox_item_to_task": {
				const inboxRef = renderString(step.inbox_ref, context as unknown as Record<string, unknown>);
				const item = getInbox(inboxRef);
				if (!item) return fail(startedMs, `inbox item not found: ${inboxRef}`);
				const stateId =
					step.state_ref === undefined
						? getDefaultState().id
						: resolveStateRef(renderString(step.state_ref, context as unknown as Record<string, unknown>));
				const stamp = new Date(item.createdAt).toISOString().slice(0, 10);
				const provenance = `_Promoted from inbox · ${item.kind} · ${stamp} · ${item.id}_`;
				const taskBody = item.body.trim().length > 0 ? `${item.body}\n\n---\n${provenance}` : provenance;
				const task = createTask({ title: item.title, body: taskBody, stateId });
				const shouldMark = step.mark_processed !== false;
				const inbox = shouldMark ? updateInbox(item.id, { processed: true }) ?? item : item;
				return ok(startedMs, `promoted inbox ${item.id} -> T-${task.displayId}`, { task, inbox });
			}
		}
	} catch (err) {
		return fail(startedMs, String(err));
	}
}

function resolveStateRef(ref: string): string {
	const exact = getState(ref);
	if (exact) return exact.id;
	const byName = findStateByName(ref);
	if (byName) return byName.id;
	throw new Error(`unknown state_ref: ${ref}`);
}

function ok(startedMs: number, stdoutExcerpt: string, json: unknown): StepResult {
	return {
		status: "success",
		stdoutExcerpt,
		stderrExcerpt: "",
		json,
		durationMs: Date.now() - startedMs,
	};
}

function fail(startedMs: number, error: string): StepResult {
	return {
		status: "failed",
		stdoutExcerpt: "",
		stderrExcerpt: "",
		error,
		durationMs: Date.now() - startedMs,
	};
}
