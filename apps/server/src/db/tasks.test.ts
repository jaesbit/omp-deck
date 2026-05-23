/**
 * Unit tests for the kanban tasks/state DB layer. Boots a fresh on-disk
 * SQLite database under `os.tmpdir()` per test so the migrations run end-to-end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./index.ts";
import { createState, listStates, reorderStates } from "./tasks.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Windows SQLite handles can lag past close(); leaking a temp dir is
			// fine, failing the suite is not.
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-tasks-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

describe("reorderStates", () => {
	test("renumbers positions in the supplied order with 100-unit gaps", () => {
		bootDb();
		// Add a fifth column on top of the four seeded by 001-init.sql.
		const upNext = createState({ name: "up-next", color: "#888888" });
		const before = listStates().map((s) => s.id);
		expect(before).toEqual(["s_backlog", "s_active", "s_blocked", "s_done", upNext.id]);

		const after = reorderStates(["s_done", "s_blocked", "s_active", "s_backlog", upNext.id]);
		expect(after.map((s) => s.id)).toEqual([
			"s_done",
			"s_blocked",
			"s_active",
			"s_backlog",
			upNext.id,
		]);
		expect(after.map((s) => s.position)).toEqual([100, 200, 300, 400, 500]);
	});

	test("rejects a missing id without mutating task_states", () => {
		bootDb();
		const original = listStates();
		expect(() => reorderStates(["s_done", "s_blocked", "s_active"])).toThrow(/expected 4 ids/);
		expect(listStates()).toEqual(original);
	});

	test("rejects an unknown id", () => {
		bootDb();
		const original = listStates();
		expect(() =>
			reorderStates(["s_done", "s_blocked", "s_active", "s_does_not_exist"]),
		).toThrow(/unknown state id/);
		expect(listStates()).toEqual(original);
	});

	test("rejects a duplicate id", () => {
		bootDb();
		const original = listStates();
		expect(() => reorderStates(["s_done", "s_done", "s_blocked", "s_active"])).toThrow(
			/duplicate state id/,
		);
		expect(listStates()).toEqual(original);
	});
});
