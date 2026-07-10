/**
 * Unit tests for per-account (workspace) spend aggregation:
 * `getAccountSpendSummary` plus its UTC bucket-boundary helpers
 * (`dayStartUtc` / `weekStartUtc` / `monthStartUtc`) from `./usage-spend.ts`.
 *
 * The HTTP route (`GET /usage/spend`) is exercised separately in
 * routes-usage.test.ts — this file only calls the aggregation function
 * directly, always with a fixed injected `now` so bucket boundaries never
 * depend on the real system clock.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentBridge } from "./bridge/types.ts";
import type { AccountSpendEntry, SessionSummary } from "@omp-deck/protocol";
import type { Config } from "./config.ts";
import { dayStartUtc, getAccountSpendSummary, monthStartUtc, weekStartUtc } from "./usage-spend.ts";

function fakeBridge(sessions: SessionSummary[]): AgentBridge {
	return {
		async createSession() {
			throw new Error("not exercised");
		},
		async resumeSession() {
			throw new Error("not exercised");
		},
		getSession() {
			return undefined;
		},
		async listSessions() {
			return sessions;
		},
		async deleteSession() {
			return { deleted: false };
		},
		trackSubscriberAdded() {},
		trackSubscriberRemoved() {},
		bumpActivity() {},
		async listModels() {
			return [];
		},
	} as unknown as AgentBridge;
}

function fakeConfig(overrides: Partial<Config> = {}): Config {
	return { defaultCwd: "/home/user/project", extraWorkspaces: [] as string[], ...overrides } as Config;
}

function findAccount(accounts: AccountSpendEntry[], cwd: string): AccountSpendEntry {
	const found = accounts.find((a) => a.cwd === cwd);
	if (!found) throw new Error(`expected an account entry for ${cwd}, got: ${accounts.map((a) => a.cwd).join(", ")}`);
	return found;
}

// Friday — deliberately not a bucket boundary itself, so day/week/month
// starts are all distinct from `NOW` and from each other.
const NOW = new Date("2026-07-10T15:30:00.000Z");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-usage-spend-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(fileName: string, lines: unknown[]): string {
	const filePath = path.join(dir, fileName);
	writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return filePath;
}

describe("dayStartUtc / weekStartUtc / monthStartUtc", () => {
	test("dayStartUtc returns UTC midnight of the given day", () => {
		expect(dayStartUtc(NOW).toISOString()).toBe("2026-07-10T00:00:00.000Z");
	});

	test("weekStartUtc returns the Monday of the given day's ISO week", () => {
		// NOW is a Friday — the week's Monday is 4 days earlier.
		expect(weekStartUtc(NOW).toISOString()).toBe("2026-07-06T00:00:00.000Z");
	});

	test("weekStartUtc on a Monday returns that same day", () => {
		const monday = new Date("2026-07-06T00:00:00.000Z");
		expect(weekStartUtc(monday).toISOString()).toBe("2026-07-06T00:00:00.000Z");
	});

	test("weekStartUtc rolls a Sunday back to the *previous* Monday, not forward", () => {
		// 2026-07-12 is a Sunday, the last day of the Mon-Jul-06..Sun-Jul-12 week.
		const sunday = new Date("2026-07-12T08:00:00.000Z");
		expect(weekStartUtc(sunday).toISOString()).toBe("2026-07-06T00:00:00.000Z");
		// Sanity: it must NOT treat Sunday as the start of the *next* week.
		expect(weekStartUtc(sunday).toISOString()).not.toBe("2026-07-13T00:00:00.000Z");
	});

	test("monthStartUtc returns UTC midnight on the 1st of the given month", () => {
		expect(monthStartUtc(NOW).toISOString()).toBe("2026-07-01T00:00:00.000Z");
	});

	test("a timestamp on the 1st at 00:00:00.000Z is its own day/month start, but week start may differ", () => {
		// 2026-08-01T00:00:00.000Z is a Saturday: it IS the start of its own
		// UTC day and UTC month, but the ISO (Monday-start) week it falls in
		// began earlier, on 2026-07-27.
		const monthBoundary = new Date("2026-08-01T00:00:00.000Z");
		expect(dayStartUtc(monthBoundary).toISOString()).toBe("2026-08-01T00:00:00.000Z");
		expect(monthStartUtc(monthBoundary).toISOString()).toBe("2026-08-01T00:00:00.000Z");
		expect(weekStartUtc(monthBoundary).toISOString()).toBe("2026-07-27T00:00:00.000Z");
	});
});

describe("getAccountSpendSummary", () => {
	test("sums cost.total per account and splits across day/week/month when messages straddle bucket boundaries", async () => {
		const cwd = "/workspaces/alpha";
		const filePath = writeTranscript("alpha.jsonl", [
			{ type: "session", id: "s-alpha" },
			{ type: "message", timestamp: "2026-07-10T09:00:00.000Z", message: { role: "user", content: "hi" } },
			{ type: "message", timestamp: "2026-07-10T09:05:00.000Z", message: { role: "assistant" } },
			// Before the month bucket started — must be excluded entirely.
			{
				type: "message",
				timestamp: "2026-06-15T00:00:00.000Z",
				message: { role: "assistant", usage: { cost: { total: 0.2 } } },
			},
			// Within the month, before this week's Monday — month only.
			{
				type: "message",
				timestamp: "2026-07-02T00:00:00.000Z",
				message: { role: "assistant", usage: { cost: { total: 0.07 } } },
			},
			// Within this week, before today — week + month.
			{
				type: "message",
				timestamp: "2026-07-08T12:00:00.000Z",
				message: { role: "assistant", usage: { cost: { total: 0.1 } } },
			},
			// Within today — day + week + month.
			{
				type: "message",
				timestamp: "2026-07-10T10:00:00.000Z",
				message: { role: "assistant", usage: { cost: { total: 0.05 } } },
			},
			{ type: "custom", id: "x" },
		]);
		const session: SessionSummary = {
			id: "s-alpha",
			path: filePath,
			cwd,
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-10T10:00:00.000Z",
			messageCount: 7,
		};

		const result = await getAccountSpendSummary(fakeBridge([session]), fakeConfig({ defaultCwd: cwd }), NOW);
		const entry = findAccount(result.accounts, cwd);

		expect(entry.day).toBeCloseTo(0.05, 6);
		expect(entry.week).toBeCloseTo(0.15, 6);
		expect(entry.month).toBeCloseTo(0.22, 6);
		expect(entry.day).toBeLessThan(entry.week);
		expect(entry.week).toBeLessThanOrEqual(entry.month);
		expect(entry.label).toBe("alpha");
	});

	test("keeps totals independent across two different cwd accounts (no cross-account bleed)", async () => {
		const cwdOne = "/workspaces/one";
		const cwdTwo = "/workspaces/two";
		const pathOne = writeTranscript("one.jsonl", [
			{ type: "message", timestamp: "2026-07-10T11:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.12 } } } },
		]);
		const pathTwo = writeTranscript("two.jsonl", [
			{ type: "message", timestamp: "2026-07-10T11:30:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.34 } } } },
		]);
		const sessions: SessionSummary[] = [
			{
				id: "s-one",
				path: pathOne,
				cwd: cwdOne,
				createdAt: "2026-07-01T00:00:00.000Z",
				updatedAt: "2026-07-10T11:00:00.000Z",
				messageCount: 1,
			},
			{
				id: "s-two",
				path: pathTwo,
				cwd: cwdTwo,
				createdAt: "2026-07-01T00:00:00.000Z",
				updatedAt: "2026-07-10T11:30:00.000Z",
				messageCount: 1,
			},
		];

		const result = await getAccountSpendSummary(
			fakeBridge(sessions),
			fakeConfig({ defaultCwd: cwdOne, extraWorkspaces: [cwdTwo] }),
			NOW,
		);

		expect(result.accounts).toHaveLength(2);
		const one = findAccount(result.accounts, cwdOne);
		const two = findAccount(result.accounts, cwdTwo);
		expect(one.day).toBeCloseTo(0.12, 6);
		expect(one.week).toBeCloseTo(0.12, 6);
		expect(one.month).toBeCloseTo(0.12, 6);
		expect(two.day).toBeCloseTo(0.34, 6);
		expect(two.week).toBeCloseTo(0.34, 6);
		expect(two.month).toBeCloseTo(0.34, 6);
	});

	test("a session untouched since before the month start is skipped and does not inflate other accounts", async () => {
		const oldCwd = "/workspaces/old";
		const otherCwd = "/workspaces/other";
		// If this transcript were (incorrectly) read, it would contribute 9.99
		// to every bucket — proves the `updatedAt < monthStart` skip actually
		// prevents the read, not just zeroes the result after the fact.
		const oldPath = writeTranscript("old.jsonl", [
			{ type: "message", timestamp: "2026-07-10T12:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 9.99 } } } },
		]);
		const otherPath = writeTranscript("other.jsonl", [
			{ type: "message", timestamp: "2026-07-10T12:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.42 } } } },
		]);
		const sessions: SessionSummary[] = [
			{
				id: "s-old",
				path: oldPath,
				cwd: oldCwd,
				createdAt: "2026-06-01T00:00:00.000Z",
				// Strictly before the month bucket (2026-07-01T00:00:00.000Z).
				updatedAt: "2026-06-15T00:00:00.000Z",
				messageCount: 1,
			},
			{
				id: "s-other",
				path: otherPath,
				cwd: otherCwd,
				createdAt: "2026-07-01T00:00:00.000Z",
				updatedAt: "2026-07-10T12:00:00.000Z",
				messageCount: 1,
			},
		];

		const result = await getAccountSpendSummary(
			fakeBridge(sessions),
			fakeConfig({ defaultCwd: oldCwd, extraWorkspaces: [otherCwd] }),
			NOW,
		);

		const old = findAccount(result.accounts, oldCwd);
		expect(old.day).toBe(0);
		expect(old.week).toBe(0);
		expect(old.month).toBe(0);

		const other = findAccount(result.accounts, otherCwd);
		expect(other.day).toBeCloseTo(0.42, 6);
		expect(other.week).toBeCloseTo(0.42, 6);
		expect(other.month).toBeCloseTo(0.42, 6);
	});

	test("a configured workspace with zero sessions still appears with day/week/month all 0", async () => {
		const withSessionCwd = "/workspaces/withsession";
		const emptyCwd = "/workspaces/empty";
		const filePath = writeTranscript("withsession.jsonl", [
			{ type: "message", timestamp: "2026-07-10T12:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
		]);
		const session: SessionSummary = {
			id: "s-withsession",
			path: filePath,
			cwd: withSessionCwd,
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-10T12:00:00.000Z",
			messageCount: 1,
		};

		const result = await getAccountSpendSummary(
			fakeBridge([session]),
			fakeConfig({ defaultCwd: withSessionCwd, extraWorkspaces: [emptyCwd] }),
			NOW,
		);

		expect(result.accounts).toHaveLength(2);
		const empty = findAccount(result.accounts, emptyCwd);
		expect(empty.day).toBe(0);
		expect(empty.week).toBe(0);
		expect(empty.month).toBe(0);
		expect(empty.label).toBe("empty");
	});

	test("accounts are sorted by month spend descending", async () => {
		const high = "/workspaces/high";
		const mid = "/workspaces/mid";
		const low = "/workspaces/low";
		const highPath = writeTranscript("high.jsonl", [
			{ type: "message", timestamp: "2026-07-10T12:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 1.0 } } } },
		]);
		const midPath = writeTranscript("mid.jsonl", [
			{ type: "message", timestamp: "2026-07-10T12:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
		]);
		const lowPath = writeTranscript("low.jsonl", [
			{ type: "message", timestamp: "2026-07-10T12:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.1 } } } },
		]);
		// Deliberately out of sorted order in the input list.
		const sessions: SessionSummary[] = [
			{ id: "s-low", path: lowPath, cwd: low, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-10T12:00:00.000Z", messageCount: 1 },
			{ id: "s-high", path: highPath, cwd: high, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-10T12:00:00.000Z", messageCount: 1 },
			{ id: "s-mid", path: midPath, cwd: mid, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-10T12:00:00.000Z", messageCount: 1 },
		];

		const result = await getAccountSpendSummary(
			fakeBridge(sessions),
			fakeConfig({ defaultCwd: high, extraWorkspaces: [mid, low] }),
			NOW,
		);

		expect(result.accounts.map((a) => a.cwd)).toEqual([high, mid, low]);
	});

	test("tolerates a missing/unreadable transcript file without throwing, leaving that session's contribution at 0", async () => {
		const badCwd = "/workspaces/bad";
		const goodCwd = "/workspaces/good";
		const goodPath = writeTranscript("good.jsonl", [
			{ type: "message", timestamp: "2026-07-10T12:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
		]);
		const sessions: SessionSummary[] = [
			{
				id: "s-bad",
				path: path.join(dir, "does-not-exist.jsonl"),
				cwd: badCwd,
				createdAt: "2026-07-01T00:00:00.000Z",
				updatedAt: "2026-07-10T12:00:00.000Z",
				messageCount: 0,
			},
			{
				id: "s-good",
				path: goodPath,
				cwd: goodCwd,
				createdAt: "2026-07-01T00:00:00.000Z",
				updatedAt: "2026-07-10T12:00:00.000Z",
				messageCount: 1,
			},
		];

		const result = await getAccountSpendSummary(
			fakeBridge(sessions),
			fakeConfig({ defaultCwd: badCwd, extraWorkspaces: [goodCwd] }),
			NOW,
		);

		const bad = findAccount(result.accounts, badCwd);
		expect(bad.day).toBe(0);
		expect(bad.week).toBe(0);
		expect(bad.month).toBe(0);

		const good = findAccount(result.accounts, goodCwd);
		expect(good.day).toBeCloseTo(0.25, 6);
		expect(good.week).toBeCloseTo(0.25, 6);
		expect(good.month).toBeCloseTo(0.25, 6);
	});

	test("a session with an empty or unparseable updatedAt is NOT silently dropped (fails open, keeps real spend)", async () => {
		const emptyUpdatedCwd = "/workspaces/empty-updated-at";
		const unparseableUpdatedCwd = "/workspaces/unparseable-updated-at";
		const emptyPath = writeTranscript("empty-updated-at.jsonl", [
			{ type: "message", timestamp: "2026-07-10T12:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.18 } } } },
		]);
		const unparseablePath = writeTranscript("unparseable-updated-at.jsonl", [
			{ type: "message", timestamp: "2026-07-10T12:00:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.29 } } } },
		]);
		const sessions: SessionSummary[] = [
			{
				id: "s-empty-updated-at",
				path: emptyPath,
				cwd: emptyUpdatedCwd,
				createdAt: "2026-07-01T00:00:00.000Z",
				updatedAt: "",
				messageCount: 1,
			},
			{
				id: "s-unparseable-updated-at",
				path: unparseablePath,
				cwd: unparseableUpdatedCwd,
				createdAt: "2026-07-01T00:00:00.000Z",
				updatedAt: "not-a-date",
				messageCount: 1,
			},
		];

		const result = await getAccountSpendSummary(
			fakeBridge(sessions),
			fakeConfig({ defaultCwd: emptyUpdatedCwd, extraWorkspaces: [unparseableUpdatedCwd] }),
			NOW,
		);

		const emptyUpdated = findAccount(result.accounts, emptyUpdatedCwd);
		expect(emptyUpdated.day).toBeCloseTo(0.18, 6);
		expect(emptyUpdated.week).toBeCloseTo(0.18, 6);
		expect(emptyUpdated.month).toBeCloseTo(0.18, 6);

		const unparseableUpdated = findAccount(result.accounts, unparseableUpdatedCwd);
		expect(unparseableUpdated.day).toBeCloseTo(0.29, 6);
		expect(unparseableUpdated.week).toBeCloseTo(0.29, 6);
		expect(unparseableUpdated.month).toBeCloseTo(0.29, 6);
	});

	test("dayStart/weekStart/monthStart are ISO-8601 strings matching the injected now's computed bucket starts", async () => {
		const result = await getAccountSpendSummary(fakeBridge([]), fakeConfig(), NOW);

		const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
		expect(result.dayStart).toMatch(iso8601);
		expect(result.weekStart).toMatch(iso8601);
		expect(result.monthStart).toMatch(iso8601);

		expect(result.dayStart).toBe(dayStartUtc(NOW).toISOString());
		expect(result.weekStart).toBe(weekStartUtc(NOW).toISOString());
		expect(result.monthStart).toBe(monthStartUtc(NOW).toISOString());
		expect(result.dayStart).toBe("2026-07-10T00:00:00.000Z");
		expect(result.weekStart).toBe("2026-07-06T00:00:00.000Z");
		expect(result.monthStart).toBe("2026-07-01T00:00:00.000Z");
	});
});
