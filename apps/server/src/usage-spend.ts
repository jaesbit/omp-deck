/**
 * Per-account (workspace) spend aggregation — `GET /api/usage/spend` (T-98).
 *
 * "Account" maps to a workspace `cwd`: the deck has no separate
 * account/tenant concept, and `cwd` is the only per-entity grouping key
 * `SessionSummary`/transcripts carry, so it is the natural aggregation unit
 * for the subscriptions view's per-account spend.
 *
 * Reuses the same cost field as `usage-sessions.ts`
 * (`message.usage.cost.total`, USD) — no new reporting pipeline. Buckets are
 * calendar-aligned in UTC:
 *   - day   — today, UTC 00:00–24:00.
 *   - week  — this week, ISO week starting Monday 00:00 UTC.
 *   - month — this month, UTC calendar month-to-date.
 * All three are computed in one pass over the sessions touched since the
 * month bucket started (the widest of the three windows), keyed by each
 * assistant message's own timestamp — a session straddling a bucket
 * boundary splits its cost correctly instead of landing entirely in one
 * side. This lets the client switch granularity instantly with no refetch.
 */

import type { AgentBridge } from "./bridge/types.ts";
import type { AccountSpendEntry, SpendSummaryResponse } from "@omp-deck/protocol";
import type { Config } from "./config.ts";
import { deriveLabel } from "./workspace-label.ts";
import { logger } from "./log.ts";

const log = logger("usage-spend");

interface TranscriptLine {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		usage?: { cost?: { total?: number } };
	};
}

/** Start of the UTC calendar day containing `at`. */
export function dayStartUtc(at: Date): Date {
	return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Start of the UTC ISO week (Monday) containing `at`. */
export function weekStartUtc(at: Date): Date {
	const day = dayStartUtc(at);
	const dow = day.getUTCDay(); // 0=Sun..6=Sat
	const daysSinceMonday = (dow + 6) % 7; // Mon->0, Tue->1, ..., Sun->6
	day.setUTCDate(day.getUTCDate() - daysSinceMonday);
	return day;
}

/** Start of the UTC calendar month containing `at`. */
export function monthStartUtc(at: Date): Date {
	return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

interface BucketStarts {
	day: Date;
	week: Date;
	month: Date;
}

interface BucketSums {
	day: number;
	week: number;
	month: number;
}

/** Sum `usage.cost.total` per bucket across one transcript's assistant messages. */
async function sumTranscriptCosts(filePath: string, starts: BucketStarts): Promise<BucketSums> {
	const sums: BucketSums = { day: 0, week: 0, month: 0 };
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		log.warn(`could not read transcript ${filePath}`, err);
		return sums;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: TranscriptLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // tolerate a partially-flushed last line
		}
		if (parsed.type !== "message" || parsed.message?.role !== "assistant" || !parsed.timestamp) continue;
		const cost = parsed.message.usage?.cost?.total;
		if (typeof cost !== "number") continue;
		const ts = new Date(parsed.timestamp);
		if (Number.isNaN(ts.getTime()) || ts < starts.month) continue;
		sums.month += cost;
		if (ts >= starts.week) sums.week += cost;
		if (ts >= starts.day) sums.day += cost;
	}
	return sums;
}

/**
 * Aggregates spend per workspace for the current day/week/month buckets.
 *
 * @param now  Override for "current time" — injected by tests; defaults to
 *             `new Date()`.
 */
export async function getAccountSpendSummary(bridge: AgentBridge, config: Config, now: Date = new Date()): Promise<SpendSummaryResponse> {
	const starts: BucketStarts = {
		day: dayStartUtc(now),
		week: weekStartUtc(now),
		month: monthStartUtc(now),
	};

	const sessions = await bridge.listSessions({});

	// A session confirmed untouched since the month bucket opened can't
	// contribute cost to any of the three windows — skip parsing its
	// transcript entirely. Bounds the per-request I/O to this month's
	// activity. Fails OPEN (keeps the session) when `updatedAt` is missing
	// or unparseable rather than silently dropping it: some bridge
	// implementations leave `SessionSummary.updatedAt` as `""`, and treating
	// that as "definitely before this month" would zero out real spend.
	const relevant = sessions.filter((s) => {
		if (!s.updatedAt) return true;
		const updated = new Date(s.updatedAt);
		return Number.isNaN(updated.getTime()) || updated >= starts.month;
	});

	const totals = new Map<string, BucketSums>();
	await Promise.all(
		relevant.map(async (s) => {
			if (!s.cwd) return;
			const sums = await sumTranscriptCosts(s.path, starts);
			const acc = totals.get(s.cwd) ?? { day: 0, week: 0, month: 0 };
			acc.day += sums.day;
			acc.week += sums.week;
			acc.month += sums.month;
			totals.set(s.cwd, acc);
		}),
	);

	// Always include every known workspace — default + configured extras plus
	// any workspace that has ever run a session — even at zero spend this
	// month, matching `/workspaces` (routes.ts) so the account list is stable
	// across the deck instead of accounts disappearing when idle.
	const known = new Set<string>([config.defaultCwd, ...config.extraWorkspaces]);
	for (const s of sessions) if (s.cwd) known.add(s.cwd);

	const accounts: AccountSpendEntry[] = Array.from(known)
		.map((cwd) => {
			const sums = totals.get(cwd) ?? { day: 0, week: 0, month: 0 };
			return { cwd, label: deriveLabel(cwd), ...sums };
		})
		.sort((a, b) => b.month - a.month || a.label.localeCompare(b.label));

	return {
		dayStart: starts.day.toISOString(),
		weekStart: starts.week.toISOString(),
		monthStart: starts.month.toISOString(),
		accounts,
	};
}
