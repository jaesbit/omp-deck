/**
 * Per-session token/cost usage — `GET /api/usage/sessions`. Needed by the
 * cost-estimation task later in the Auto Work chain.
 *
 * Session discovery reuses `AgentBridge.listSessions` (the same call
 * `GET /api/sessions` uses) rather than re-walking `~/.omp/agent/sessions`
 * ourselves. Each session's `.jsonl` transcript is then read directly:
 * `SessionSummary` carries message counts but not token/cost totals, and
 * there's no existing aggregation utility for that — so this is the one new
 * piece of parsing, kept intentionally minimal (line-by-line JSON.parse,
 * summing the `usage` field the SDK already writes on every assistant
 * message; see a sample record shape in the PR description).
 */

import type { AgentBridge } from "./bridge/types.ts";
import type { SessionUsageSummary } from "@omp-deck/protocol";
import { logger } from "./log.ts";

const log = logger("usage-sessions");

interface AssistantUsage {
	totalTokens?: number;
	cost?: { total?: number };
}

interface TranscriptLine {
	type?: string;
	message?: {
		role?: string;
		usage?: AssistantUsage;
	};
}

/** Sum `usage.totalTokens` / `usage.cost.total` across every assistant message in one transcript file. */
async function aggregateTranscriptUsage(filePath: string): Promise<{ totalTokens: number; costUsd: number }> {
	let totalTokens = 0;
	let costUsd = 0;
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		log.warn(`could not read transcript ${filePath}`, err);
		return { totalTokens, costUsd };
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: TranscriptLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // tolerate a partially-flushed last line
		}
		if (parsed.type !== "message" || parsed.message?.role !== "assistant") continue;
		const usage = parsed.message.usage;
		if (!usage) continue;
		if (typeof usage.totalTokens === "number") totalTokens += usage.totalTokens;
		if (typeof usage.cost?.total === "number") costUsd += usage.cost.total;
	}
	return { totalTokens, costUsd };
}

/**
 * Lists the `limit` most-recently-updated sessions across all workspaces with
 * their aggregated token/cost usage. Reads transcripts in parallel.
 */
export async function listSessionUsage(bridge: AgentBridge, limit: number): Promise<SessionUsageSummary[]> {
	const sessions = await bridge.listSessions({});
	const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
	return Promise.all(
		sorted.map(async (s) => {
			const { totalTokens, costUsd } = await aggregateTranscriptUsage(s.path);
			return {
				id: s.id,
				path: s.path,
				cwd: s.cwd,
				title: s.title,
				updatedAt: s.updatedAt,
				totalTokens,
				costUsd,
				messageCount: s.messageCount,
			};
		}),
	);
}
