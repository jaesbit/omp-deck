/**
 * Browser-session view-state persistence (T-72).
 *
 * `usePersistedViewState(key, defaultValue)` is a drop-in replacement for
 * `useState(defaultValue)` for filter/sort/scope fields whose values should
 * survive page refreshes within the same browser tab.
 *
 * Storage: `sessionStorage` — same semantics as the existing workspace-filter
 * hook this generalises. State is tab-local and cleared when the tab closes.
 *
 * Key format: "view.field", e.g. "tasks.priorityFilter", "inbox.filter".
 * Values must be JSON-serialisable (all filter/sort fields are string or boolean).
 */

import { useCallback, useState } from "react";

const PREFIX = "omp-deck:view:";

function readSession<T>(key: string, defaultValue: T): T {
	if (typeof sessionStorage === "undefined") return defaultValue;
	try {
		const raw = sessionStorage.getItem(PREFIX + key);
		return raw !== null ? (JSON.parse(raw) as T) : defaultValue;
	} catch {
		return defaultValue;
	}
}

function writeSession(key: string, value: unknown): void {
	if (typeof sessionStorage === "undefined") return;
	try {
		if (value === null || value === undefined || value === "" || value === false) {
			sessionStorage.removeItem(PREFIX + key);
		} else {
			sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
		}
	} catch {
		// Private mode or storage full — in-memory state still works.
	}
}

/**
 * Persists a single filter/sort/scope field in `sessionStorage`.
 * The returned setter has the same signature as a `useState` setter.
 */
export function usePersistedViewState<T>(
	key: string,
	defaultValue: T,
): [T, (next: T) => void] {
	const [value, setValueRaw] = useState<T>(() => readSession(key, defaultValue));

	const setValue = useCallback(
		(next: T) => {
			setValueRaw(next);
			writeSession(key, next);
		},
		[key],
	);

	return [value, setValue];
}
