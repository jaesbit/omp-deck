/**
 * Unit tests for the generic server-settings KV layer and the typed
 * deck-base-url helpers built on top of it (T-61). Boots a fresh on-disk
 * SQLite database per test, same pattern as `workspace-preferences.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Config } from "../config.ts";
import { closeDb, openDb } from "./index.ts";
import {
	deleteServerSetting,
	getDeckBaseUrl,
	getServerSetting,
	setDeckBaseUrl,
	setServerSetting,
} from "./server-settings.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-server-settings-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

function fakeConfig(port: number): Config {
	return { port } as Config;
}

describe("server-settings KV layer", () => {
	test("getServerSetting returns undefined for an unset key", () => {
		bootDb();
		expect(getServerSetting("nope")).toBeUndefined();
	});

	test("setServerSetting stores and round-trips a value", () => {
		bootDb();
		setServerSetting("foo", "bar");
		expect(getServerSetting("foo")).toBe("bar");
	});

	test("setServerSetting upserts — a second call replaces the value", () => {
		bootDb();
		setServerSetting("foo", "bar");
		setServerSetting("foo", "baz");
		expect(getServerSetting("foo")).toBe("baz");
	});

	test("deleteServerSetting clears a key", () => {
		bootDb();
		setServerSetting("foo", "bar");
		deleteServerSetting("foo");
		expect(getServerSetting("foo")).toBeUndefined();
	});
});

describe("getDeckBaseUrl / setDeckBaseUrl", () => {
	test("falls back to http://localhost:<port> when unset", () => {
		bootDb();
		const result = getDeckBaseUrl(fakeConfig(8787));
		expect(result).toEqual({ deckBaseUrl: "http://localhost:8787", isCustom: false });
	});

	test("uses the configured port in the computed default", () => {
		bootDb();
		expect(getDeckBaseUrl(fakeConfig(9999)).deckBaseUrl).toBe("http://localhost:9999");
	});

	test("setDeckBaseUrl persists a custom value and GET reflects it", () => {
		bootDb();
		const config = fakeConfig(8787);
		const set = setDeckBaseUrl(config, "https://deck.example.com");
		expect(set).toEqual({ deckBaseUrl: "https://deck.example.com", isCustom: true });
		expect(getDeckBaseUrl(config)).toEqual({ deckBaseUrl: "https://deck.example.com", isCustom: true });
	});

	test("setDeckBaseUrl trims whitespace", () => {
		bootDb();
		const config = fakeConfig(8787);
		setDeckBaseUrl(config, "  https://deck.example.com  ");
		expect(getDeckBaseUrl(config).deckBaseUrl).toBe("https://deck.example.com");
	});

	test("setDeckBaseUrl(config, null) clears the override, reverting to the computed default", () => {
		bootDb();
		const config = fakeConfig(8787);
		setDeckBaseUrl(config, "https://deck.example.com");
		const cleared = setDeckBaseUrl(config, null);
		expect(cleared).toEqual({ deckBaseUrl: "http://localhost:8787", isCustom: false });
	});

	test("setDeckBaseUrl(config, '') also clears the override", () => {
		bootDb();
		const config = fakeConfig(8787);
		setDeckBaseUrl(config, "https://deck.example.com");
		setDeckBaseUrl(config, "");
		expect(getDeckBaseUrl(config).isCustom).toBe(false);
	});

	test("persists across a simulated server restart (close + reopen the DB file)", () => {
		dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-server-settings-db-"));
		const dbPath = path.join(dbDir, "deck.db");
		openDb({ path: dbPath });
		const config = fakeConfig(8787);
		setDeckBaseUrl(config, "https://deck.example.com");

		closeDb();
		openDb({ path: dbPath });

		expect(getDeckBaseUrl(config)).toEqual({ deckBaseUrl: "https://deck.example.com", isCustom: true });
	});
});
