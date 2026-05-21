/**
 * YAML <-> RoutineSpec round-tripping for the visual builder.
 *
 * The builder is a different rendering of the same source-of-truth as the
 * Spec tab: form edits mutate a `RoutineSpec` object, which gets serialized
 * to YAML on save; valid YAML edits parse back into a `RoutineSpec`.
 *
 * We use the `yaml` package's plain parse/stringify (not the Document API)
 * because comments aren't a V1 promise — V2 visual mode can preserve them
 * when we have a reason to.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
	validateRoutineSpec,
	type RoutineDeckAction,
	type RoutineSpec,
	type RoutineStep,
	type RoutineTrigger,
	type ValidationError,
} from "@omp-deck/protocol";

export interface ParseResult {
	ok: boolean;
	spec?: RoutineSpec;
	yamlError?: { message: string; line?: number };
	schemaErrors?: ValidationError[];
}

/** Parse + validate. Returns `{ok:false}` with whichever error layer fired. */
export function parseSpec(yamlText: string): ParseResult {
	let raw: unknown;
	try {
		raw = parseYaml(yamlText);
	} catch (e) {
		const err = e as { message?: string; linePos?: Array<{ line: number }> };
		const message = err.message ?? String(e);
		const line = err.linePos?.[0]?.line;
		const yamlError: ParseResult["yamlError"] =
			typeof line === "number" ? { message, line } : { message };
		return { ok: false, yamlError };
	}
	const result = validateRoutineSpec(raw);
	if (!result.valid) {
		return { ok: false, schemaErrors: result.errors };
	}
	return { ok: true, spec: raw as RoutineSpec };
}

/** Serialize a RoutineSpec to YAML. Stable key order, 2-space indent. */
export function stringifySpec(spec: RoutineSpec): string {
	// `yaml` sorts maps in insertion order — we feed it in the canonical
	// top-level shape so saved files look the same as the daily-briefing
	// template.
	const ordered = orderSpec(spec);
	return stringifyYaml(ordered, {
		indent: 2,
		lineWidth: 100,
		minContentWidth: 20,
		// Block style is closer to a hand-authored file than flow.
		defaultStringType: "PLAIN",
		defaultKeyType: "PLAIN",
	});
}

function orderSpec(spec: RoutineSpec): Record<string, unknown> {
	const out: Record<string, unknown> = { name: spec.name };
	if (spec.description) out.description = spec.description;
	out.trigger = spec.trigger;
	if (spec.timezone) out.timezone = spec.timezone;
	if (spec.concurrency) out.concurrency = spec.concurrency;
	if (spec.budget) out.budget = spec.budget;
	if (spec.state) out.state = spec.state;
	if (spec.tags && spec.tags.length > 0) out.tags = spec.tags;
	out.steps = spec.steps;
	return out;
}

/** Empty starting spec for "New routine" in builder mode. */
export function emptyV1Spec(): RoutineSpec {
	return {
		name: "untitled-routine",
		trigger: [{ manual: {} }],
		concurrency: "skip",
		steps: [],
	};
}

/** Scaffold a fresh step of the given type — every required field present. */
export function scaffoldStep(
	type: RoutineStep["type"],
	existingIds: string[],
	presetAction?: RoutineDeckAction,
): RoutineStep {
	const id = pickUniqueId(pickBaseId(type, presetAction), existingIds);
	switch (type) {
		case "run":
			return { id, type: "run", command: "echo hello" };
		case "agent":
			return { id, type: "agent", prompt: "Summarize the following:\n\n{{ steps.X.json }}" };
		case "write":
			return {
				id,
				type: "write",
				path: "inbox/captures/{{ run.date }}-{{ run.id }}.md",
				content: "# {{ run.date }}\n\n",
			};
		case "http":
			return { id, type: "http", method: "GET", url: "http://127.0.0.1:8787/api/tasks" };
		case "deck":
			switch (presetAction ?? "create_inbox_item") {
				case "create_inbox_item":
					return {
						id,
						type: "deck",
						action: "create_inbox_item",
						kind: "capture",
						title: "routine-output-{{ run.date }}",
						body: "{{ steps.X.stdout }}",
						source: "routine:{{ run.id }}",
					};
				case "create_task":
					return {
						id,
						type: "deck",
						action: "create_task",
						title: "Follow up on {{ run.date }}",
						body: "{{ steps.X.stdout }}",
					};
				case "move_task":
					return {
						id,
						type: "deck",
						action: "move_task",
						task_ref: "T-1",
						state_ref: "done",
						index: 0,
					};
				case "promote_inbox_item_to_task":
					return {
						id,
						type: "deck",
						action: "promote_inbox_item_to_task",
						inbox_ref: "i_...",
					};
			}
		case "mcp":
			return { id, type: "mcp", server: "filesystem", tool: "read_text_file", args: {} };
		case "transform":
			return { id, type: "transform", body: "return { ok: true };" };
		case "wait":
			return { id, type: "wait", duration_secs: 5 };
		case "set_state":
			return { id, type: "set_state", state: { last_run_date: "{{ run.date }}" } };
	}
}

function pickUniqueId(base: string, existing: string[]): string {
	const taken = new Set(existing);
	if (!taken.has(base)) return base;
	for (let n = 2; n < 1000; n += 1) {
		const candidate = `${base}_${n}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}_${Date.now()}`;
}

function pickBaseId(type: RoutineStep["type"], presetAction?: RoutineDeckAction): string {
	if (type !== "deck") return type;
	switch (presetAction ?? "create_inbox_item") {
		case "create_inbox_item":
			return "create_inbox_item";
		case "create_task":
			return "create_task";
		case "move_task":
			return "move_task";
		case "promote_inbox_item_to_task":
			return "promote_inbox_item_to_task";
	}
}


/** Apply a partial patch to one step inside the spec, returning a new spec. */
export function replaceStep(
	spec: RoutineSpec,
	index: number,
	next: RoutineStep,
): RoutineSpec {
	const steps = spec.steps.slice();
	steps[index] = next;
	return { ...spec, steps };
}

export function insertStep(spec: RoutineSpec, step: RoutineStep, at?: number): RoutineSpec {
	const steps = spec.steps.slice();
	if (at === undefined || at >= steps.length) {
		steps.push(step);
	} else {
		steps.splice(at, 0, step);
	}
	return { ...spec, steps };
}

export function removeStep(spec: RoutineSpec, index: number): RoutineSpec {
	const steps = spec.steps.slice();
	steps.splice(index, 1);
	return { ...spec, steps };
}

export function moveStep(spec: RoutineSpec, from: number, to: number): RoutineSpec {
	if (from === to || from < 0 || to < 0 || from >= spec.steps.length || to >= spec.steps.length) {
		return spec;
	}
	const steps = spec.steps.slice();
	const [moved] = steps.splice(from, 1);
	if (!moved) return spec;
	steps.splice(to, 0, moved);
	return { ...spec, steps };
}

export function replaceTriggers(spec: RoutineSpec, triggers: RoutineTrigger[]): RoutineSpec {
	return { ...spec, trigger: triggers };
}

export function updateSettings(
	spec: RoutineSpec,
	patch: Partial<Pick<RoutineSpec, "name" | "description" | "concurrency" | "timezone" | "budget" | "tags" | "state">>,
): RoutineSpec {
	const next: RoutineSpec = { ...spec };
	if (patch.name !== undefined) next.name = patch.name;
	if (patch.description !== undefined) next.description = patch.description;
	if (patch.concurrency !== undefined) next.concurrency = patch.concurrency;
	if (patch.timezone !== undefined) next.timezone = patch.timezone;
	if (patch.budget !== undefined) next.budget = patch.budget;
	if (patch.tags !== undefined) next.tags = patch.tags;
	if (patch.state !== undefined) next.state = patch.state;
	return next;
}

export interface StepTemplateDescriptor {
	key: string;
	value: RoutineStep["type"];
	label: string;
	help: string;
	presetAction?: RoutineDeckAction;
}

export const STEP_TYPE_DESCRIPTIONS: ReadonlyArray<StepTemplateDescriptor> = [
	{ key: "run", value: "run", label: "run", help: "Shell out to a command, capture stdout/stderr." },
	{ key: "agent", value: "agent", label: "agent", help: "Prompt the omp SDK. Costs LLM tokens." },
	{ key: "http", value: "http", label: "http", help: "GET/POST against a URL. Internal calls get an HMAC bearer." },
	{ key: "create_inbox_item", value: "deck", label: "create inbox item", help: "Create a native deck inbox item without hand-rolling /api/inbox.", presetAction: "create_inbox_item" },
	{ key: "create_task", value: "deck", label: "create task", help: "Create a kanban task using deck-native semantics.", presetAction: "create_task" },
	{ key: "move_task", value: "deck", label: "move task", help: "Move an existing task to another state by T-id or task id.", presetAction: "move_task" },
	{ key: "promote_inbox_item_to_task", value: "deck", label: "promote inbox item", help: "Promote an inbox item into a task with the standard provenance footer.", presetAction: "promote_inbox_item_to_task" },
	{ key: "write", value: "write", label: "write", help: "Write a templated string to a file." },
	{ key: "transform", value: "transform", label: "transform", help: "JS expression in a sandbox; sets context.steps.X.json." },
	{ key: "set_state", value: "set_state", label: "set_state", help: "Upsert keys into the routine's persistent state." },
	{ key: "wait", value: "wait", label: "wait", help: "Sleep N seconds. Useful between polling steps." },
	{ key: "mcp", value: "mcp", label: "mcp", help: "Invoke an MCP server tool. V1.5 — currently stubbed." },
];
