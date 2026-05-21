import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createInbox, getInbox, listInbox } from "../../db/inbox.ts";
import { closeDb, openDb } from "../../db/index.ts";
import { createTask, findStateByName, getTask, listTasks } from "../../db/tasks.ts";
import type { RunContext } from "../types.ts";
import { executeDeckStep } from "./deck.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Windows SQLite handle release can lag slightly after close(); leaking a
			// temp test dir is fine, failing the suite is not.
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-step-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

function ctx(): RunContext {
	return {
		run: {
			id: "run_test_01",
			started: "2026-05-21T00:00:00.000Z",
			iso_started: "2026-05-21T00:00:00.000Z",
			date: "2026-05-21",
			trigger_kind: "manual",
		},
		trigger: {},
		steps: {},
		env: {},
		secrets: {},
		state: {},
	};
}

describe("executeDeckStep", () => {
	test("create_inbox_item creates a native inbox item", async () => {
		bootDb();
		const result = await executeDeckStep(
			{
				id: "capture",
				type: "deck",
				action: "create_inbox_item",
				kind: "capture",
				title: "Morning briefing - {{ run.date }}",
				body: "hello from {{ run.id }}",
				source: "routine:test",
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		const items = listInbox({ includeProcessed: true });
		expect(items.some((i) => i.title === "Morning briefing - 2026-05-21")).toBe(true);
		expect(result.json).toMatchObject({ kind: "capture", source: "routine:test" });
	});

	test("create_task resolves state_ref by name", async () => {
		bootDb();
		const result = await executeDeckStep(
			{
				id: "task",
				type: "deck",
				action: "create_task",
				title: "Follow up {{ run.date }}",
				body: "from {{ run.id }}",
				state_ref: "backlog",
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		const task = result.json as ReturnType<typeof getTask>;
		expect(task?.title).toBe("Follow up 2026-05-21");
		expect(task?.body).toBe("from run_test_01");
		expect(task?.stateId).toBe(findStateByName("backlog")?.id);
	});

	test("move_task accepts T-N refs and moves to target state/index", async () => {
		bootDb();
		const done = findStateByName("done");
		if (!done) throw new Error("done state missing");
		const created = createTask({ title: "Move me" });
		const result = await executeDeckStep(
			{
				id: "move",
				type: "deck",
				action: "move_task",
				task_ref: `T-${created.displayId}`,
				state_ref: "done",
				index: 0,
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		const moved = getTask(created.id);
		expect(moved?.stateId).toBe(done.id);
	});

	test("promote_inbox_item_to_task creates task and marks inbox processed by default", async () => {
		bootDb();
		const item = createInbox({ kind: "capture", title: "Promote me", body: "hello" });
		const result = await executeDeckStep(
			{
				id: "promote",
				type: "deck",
				action: "promote_inbox_item_to_task",
				inbox_ref: item.id,
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		const promoted = result.json as { task: { title: string }; inbox: { processedAt?: string } };
		expect(promoted.task.title).toBe("Promote me");
		expect(promoted.inbox.processedAt).toBeDefined();
		expect(getInbox(item.id)?.processedAt).toBeDefined();
		expect(listTasks().some((t) => t.title === "Promote me")).toBe(true);
	});
});
