import { describe, expect, test } from "bun:test";

import type { Task } from "@omp-deck/protocol";

import { filterTasksByWorkspace, taskWorkspaces } from "./task-workspace-filter";

function task(id: string, cwd?: string): Task {
	return {
		id,
		displayId: Number(id),
		title: id,
		body: "",
		stateId: "backlog",
		orderInState: 1000,
		cwd,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		stateEnteredAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("task workspace filter", () => {
	test("lists only distinct configured task workspaces in stable order", () => {
		const tasks = [task("1", "/work/z"), task("2"), task("3", "/work/a"), task("4", "/work/z")];
		expect(taskWorkspaces(tasks)).toEqual(["/work/a", "/work/z"]);
	});

	test("all-workspaces selection retains cwd-less tasks", () => {
		const tasks = [task("1", "/work/a"), task("2")];
		expect(filterTasksByWorkspace(tasks, "")).toEqual(tasks);
	});

	test("workspace selection matches the exact task cwd", () => {
		const a = task("1", "/work/a");
		const child = task("2", "/work/a-child");
		expect(filterTasksByWorkspace([a, child, task("3")], "/work/a")).toEqual([a]);
	});
});
