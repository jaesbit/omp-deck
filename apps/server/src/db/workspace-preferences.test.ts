/**
 * Unit tests for the workspace-preferences DB layer (T-42). Boots a fresh
 * on-disk SQLite database under `os.tmpdir()` per test so migrations run
 * end-to-end, same pattern as `tasks.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./index.ts";
import {
	getWorkspacePreference,
	listWorkspacePreferences,
	setWorkspacePreference,
} from "./workspace-preferences.ts";

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
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-workspace-prefs-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

describe("workspace preferences", () => {
	test("getWorkspacePreference returns undefined when no override exists", () => {
		bootDb();
		expect(getWorkspacePreference("/tmp/nowhere")).toBeUndefined();
	});

	test("setWorkspacePreference stores and round-trips a model override", () => {
		bootDb();
		const pref = setWorkspacePreference("/tmp/project-a", { provider: "anthropic", id: "claude-x" });
		expect(pref.cwd).toBe("/tmp/project-a");
		expect(pref.model).toEqual({ provider: "anthropic", id: "claude-x" });

		const fetched = getWorkspacePreference("/tmp/project-a");
		expect(fetched?.model).toEqual({ provider: "anthropic", id: "claude-x" });
	});

	test("setWorkspacePreference upserts — a second call replaces the model", () => {
		bootDb();
		setWorkspacePreference("/tmp/project-b", { provider: "openai", id: "gpt-x" });
		setWorkspacePreference("/tmp/project-b", { provider: "anthropic", id: "claude-y" });
		expect(getWorkspacePreference("/tmp/project-b")?.model).toEqual({
			provider: "anthropic",
			id: "claude-y",
		});
		expect(listWorkspacePreferences().filter((p) => p.cwd === "/tmp/project-b")).toHaveLength(1);
	});

	test("setWorkspacePreference(cwd, null) clears the override", () => {
		bootDb();
		setWorkspacePreference("/tmp/project-c", { provider: "anthropic", id: "claude-z" });
		expect(getWorkspacePreference("/tmp/project-c")).toBeDefined();

		setWorkspacePreference("/tmp/project-c", null);
		expect(getWorkspacePreference("/tmp/project-c")).toBeUndefined();
	});

	test("listWorkspacePreferences returns every stored override, sorted by cwd", () => {
		bootDb();
		setWorkspacePreference("/tmp/z-project", { provider: "p", id: "m1" });
		setWorkspacePreference("/tmp/a-project", { provider: "p", id: "m2" });
		const all = listWorkspacePreferences();
		expect(all.map((p) => p.cwd)).toEqual(["/tmp/a-project", "/tmp/z-project"]);
	});
});
