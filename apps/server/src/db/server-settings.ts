/**
 * Generic global key/value settings store (T-61). Unlike
 * `workspace-preferences.ts` / `auto-work.ts`, these settings are not keyed
 * by workspace cwd — one value per key, server-wide.
 *
 * First (and so far only) consumer is `deckBaseUrl`, exposed as typed
 * helpers below. Add more typed wrappers around `getServerSetting` /
 * `setServerSetting` as new global settings show up rather than growing
 * ad-hoc tables per setting.
 */

import type { Config } from "../config.ts";
import { getDb, nowIso } from "./index.ts";

const DECK_BASE_URL_KEY = "deckBaseUrl";

interface Row {
	value: string;
}

/** Raw KV read. Returns `undefined` when `key` has never been set. */
export function getServerSetting(key: string): string | undefined {
	const row = getDb().query<Row, [string]>("SELECT value FROM server_settings WHERE key = ?").get(key) as
		| Row
		| null;
	return row?.value;
}

/** Raw KV upsert. */
export function setServerSetting(key: string, value: string): void {
	getDb()
		.prepare<unknown, [string, string, string]>(
			`INSERT INTO server_settings (key, value, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.run(key, value, nowIso());
}

/** Deletes `key`, reverting any dependent typed getter back to its computed default. */
export function deleteServerSetting(key: string): void {
	getDb().prepare<unknown, [string]>("DELETE FROM server_settings WHERE key = ?").run(key);
}

/**
 * The base URL used to build session deep links (e.g. from the auto-work
 * completion flow — see `buildSessionUrl` in `../deck-links.ts`). Falls back
 * to `http://localhost:${config.port}` when nothing has been persisted, so
 * the feature works out of the box on a fresh install.
 */
export function getDeckBaseUrl(config: Config): { deckBaseUrl: string; isCustom: boolean } {
	const stored = getServerSetting(DECK_BASE_URL_KEY);
	if (stored !== undefined && stored !== "") {
		return { deckBaseUrl: stored, isCustom: true };
	}
	return { deckBaseUrl: `http://localhost:${config.port}`, isCustom: false };
}

/** `value: null` (or empty string) clears the override, reverting to the computed default. */
export function setDeckBaseUrl(config: Config, value: string | null): { deckBaseUrl: string; isCustom: boolean } {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") {
		deleteServerSetting(DECK_BASE_URL_KEY);
	} else {
		setServerSetting(DECK_BASE_URL_KEY, trimmed);
	}
	return getDeckBaseUrl(config);
}
