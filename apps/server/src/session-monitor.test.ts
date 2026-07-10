import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { SessionSnapshot, SessionSummary } from "@omp-deck/protocol"

import type { AgentBridge, SessionHandle } from "./bridge/types.ts"
import { listSessionMonitor } from "./session-monitor.ts"

let tempDir: string

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-session-monitor-"))
})

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true })
})

function session(id: string, transcriptPath: string, cwd: string): SessionSummary {
	return {
		id,
		path: transcriptPath,
		cwd,
		createdAt: "2026-07-10T10:00:00.000Z",
		updatedAt: "2026-07-10T10:05:00.000Z",
		messageCount: 3,
	}
}

function writeTranscript(name: string, records: unknown[]): string {
	const transcriptPath = path.join(tempDir, name)
	fs.writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8")
	return transcriptPath
}

function liveHandle(snapshot: SessionSnapshot): SessionHandle {
	return {
		sessionId: snapshot.sessionId,
		sessionFile: snapshot.sessionFile,
		cwd: snapshot.cwd,
		snapshot: async () => snapshot,
	} as SessionHandle
}

/** Minimal deterministic bridge surface exercised by `listSessionMonitor`. */
class SessionMonitorBridge {
	readonly listCalls: Array<{ cwd?: string }> = []
	private readonly liveSessions: Map<string, SessionHandle>

	constructor(
		private readonly sessions: SessionSummary[],
		liveSessions: Iterable<readonly [string, SessionHandle]> = [],
	) {
		this.liveSessions = new Map(liveSessions)
	}

	async listSessions(opts: { cwd?: string }): Promise<SessionSummary[]> {
		this.listCalls.push(opts)
		return opts.cwd ? this.sessions.filter((candidate) => candidate.cwd === opts.cwd) : this.sessions
	}

	getSession(sessionId: string): SessionHandle | undefined {
		return this.liveSessions.get(sessionId)
	}
}

function asAgentBridge(bridge: SessionMonitorBridge): AgentBridge {
	return bridge as unknown as AgentBridge
}

describe("listSessionMonitor", () => {
	test("classifies a persisted terminal error and preserves its displayable message tail", async () => {
		const cwd = "/workspaces/deploy"
		const transcriptPath = writeTranscript("terminal-error.jsonl", [
			{ type: "session", version: 3, id: "terminal-error", cwd },
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Deploy the current build" }] },
			},
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Starting deployment" }] },
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "deploy",
					content: [{ type: "text", text: "Deployment API returned 503" }],
					isError: true,
				},
			},
			{ type: "agent_end", stopReason: "error" },
		])
		const persisted = session("terminal-error", transcriptPath, cwd)

		const [entry] = await listSessionMonitor(asAgentBridge(new SessionMonitorBridge([persisted])))

		expect(entry).toEqual({
			...persisted,
			status: "error",
			error: "Agent turn ended with an error.",
			recentMessages: [
				{ role: "user", text: "Deploy the current build" },
				{ role: "assistant", text: "Starting deployment" },
				{ role: "tool", text: "Deployment API returned 503", isError: true },
			],
		})
	})

	test("classifies a persisted session ending normally as completed", async () => {
		const cwd = "/workspaces/review"
		const transcriptPath = writeTranscript("completed.jsonl", [
			{ type: "session", version: 3, id: "completed", cwd },
			{ type: "message", message: { role: "user", content: "Review the diff" } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "The diff is ready to merge" }] },
			},
			{ type: "agent_end", stopReason: "stop" },
		])
		const persisted = session("completed", transcriptPath, cwd)

		const [entry] = await listSessionMonitor(asAgentBridge(new SessionMonitorBridge([persisted])))

		expect(entry).toEqual({
			...persisted,
			status: "completed",
			recentMessages: [
				{ role: "user", text: "Review the diff" },
				{ role: "assistant", text: "The diff is ready to merge" },
			],
		})
	})

	test("uses a live streaming snapshot instead of a persisted transcript tail", async () => {
		const cwd = "/workspaces/live"
		const transcriptPath = writeTranscript("live.jsonl", [
			{ type: "session", version: 3, id: "live", cwd },
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "Disk transcript must not be used" }],
					isError: true,
				},
			},
			{ type: "agent_end", stopReason: "error" },
		])
		const persisted = session("live", transcriptPath, cwd)
		const snapshot: SessionSnapshot = {
			sessionId: "live",
			sessionFile: transcriptPath,
			cwd,
			isStreaming: true,
			messages: [
				{ role: "user", content: [{ type: "text", text: "Continue the migration" }] },
				{ role: "assistant", content: [{ type: "text", text: "Migrating the final table" }] },
			],
			todoPhases: [],
		}
		const bridge = new SessionMonitorBridge([persisted], [["live", liveHandle(snapshot)]])

		const [entry] = await listSessionMonitor(asAgentBridge(bridge))

		expect(entry.status).toBe("active")
		expect(entry.recentMessages).toEqual([
			{ role: "user", text: "Continue the migration" },
			{ role: "assistant", text: "Migrating the final table" },
		])
	})

	test("forwards a cwd filter to the bridge before monitoring persisted sessions", async () => {
		const selectedCwd = "/workspaces/selected"
		const selected = session(
			"selected",
			writeTranscript("selected.jsonl", [
				{ type: "session", version: 3, id: "selected", cwd: selectedCwd },
				{ type: "message", message: { role: "user", content: "Selected workspace" } },
			]),
			selectedCwd,
		)
		const excludedCwd = "/workspaces/excluded"
		const excluded = session(
			"excluded",
			writeTranscript("excluded.jsonl", [
				{ type: "session", version: 3, id: "excluded", cwd: excludedCwd },
				{ type: "message", message: { role: "user", content: "Other workspace" } },
			]),
			excludedCwd,
		)
		const bridge = new SessionMonitorBridge([selected, excluded])

		const entries = await listSessionMonitor(asAgentBridge(bridge), selectedCwd)

		expect(bridge.listCalls).toEqual([{ cwd: selectedCwd }])
		expect(entries.map((entry) => entry.id)).toEqual(["selected"])
	})
})
