/**
 * Tests for server-side session-title generation (T-78).
 *
 * Same fake-session-handle/fake-bridge shape as `generateBranchSlugWithModel`
 * / `decideSqueezeTiming` in `auto-work/engine.test.ts` (one-shot disposable
 * session, no real LLM call) — see that file's `FakeSessionHandle`/
 * `fakeBridge` for the precedent this mirrors. `getInternalTaskModel()` and
 * `getTask()` go through a real on-disk sqlite DB (same convention as
 * `routes-settings-deck-base-url.test.ts`) since `generateSessionTitle`
 * reads both directly rather than through the bridge.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentBridge, CreateSessionOpts, EventListener, SessionHandle } from "./bridge/types.ts";
import { closeDb, openDb } from "./db/index.ts";
import { setInternalTaskModel } from "./db/server-settings.ts";
import { createTask } from "./db/tasks.ts";
import { generateSessionTitle } from "./session-title.ts";

let dbDir: string;

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-session-title-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
});

afterEach(() => {
	closeDb();
	fs.rmSync(dbDir, { recursive: true, force: true });
});

/**
 * A one-shot fake session handle whose single subscriber gets the terminal
 * event delivered synchronously, deterministically, with no real timer.
 * `session-title.ts` awaits `session.prompt()` directly (no `startTurn`
 * callback passed to `waitForAutoWorkSessionTerminal`), so a handle that
 * never emits a terminal event would deadlock `generateSessionTitle`
 * forever — every fixture below always emits one, synchronously from
 * `subscribe()`, before `prompt()` is ever called.
 */
class FakeSessionHandle {
	readonly sessionId: string;
	private readonly turnEnded = Promise.withResolvers<void>();
	readonly prompts: string[] = [];

	constructor(
		sessionId: string,
		private readonly assistantResponse: string = "",
		private readonly terminalEvent: Parameters<EventListener>[0] = { type: "turn_end" },
	) {
		this.sessionId = sessionId;
	}

	subscribe(listener: EventListener): () => void {
		listener(this.terminalEvent);
		this.turnEnded.resolve();
		return () => {};
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		await this.turnEnded.promise;
	}

	async snapshot(): Promise<{ messages: Array<{ role: string; content: unknown }> }> {
		return { messages: [{ role: "assistant", content: this.assistantResponse }] };
	}
}

function fakeBridge(
	handle: FakeSessionHandle,
	opts: {
		createSessionCalls?: CreateSessionOpts[];
		createSessionError?: Error;
		deleteSessionCalls?: string[];
		deleteSessionError?: Error;
	} = {},
): AgentBridge {
	return {
		async createSession(createOpts: CreateSessionOpts) {
			if (opts.createSessionError) throw opts.createSessionError;
			opts.createSessionCalls?.push(createOpts);
			return handle as unknown as SessionHandle;
		},
		async deleteSession(sessionId: string) {
			opts.deleteSessionCalls?.push(sessionId);
			if (opts.deleteSessionError) throw opts.deleteSessionError;
			return { deleted: true };
		},
	} as unknown as AgentBridge;
}

describe("generateSessionTitle", () => {
	test("returns undefined and never touches the bridge when internalTaskModel is unset", async () => {
		const handle = new FakeSessionHandle("sess_unused", "Should Never Be Used");
		const createSessionCalls: CreateSessionOpts[] = [];
		const deleteSessionCalls: string[] = [];

		const result = await generateSessionTitle(fakeBridge(handle, { createSessionCalls, deleteSessionCalls }), {
			cwd: "/tmp/ws",
			firstMessage: "Fix the login bug",
		});

		expect(result).toBeUndefined();
		expect(createSessionCalls).toEqual([]);
		expect(deleteSessionCalls).toEqual([]);
	});

	test("returns the sanitized first line of the model's response, stripping wrapping quotes", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const handle = new FakeSessionHandle(
			"sess_happy",
			'"Fix the login flow"\nextra reasoning the title generator should ignore',
		);

		const result = await generateSessionTitle(fakeBridge(handle), {
			cwd: "/tmp/ws",
			firstMessage: "Fix the login bug",
		});

		expect(result).toBe("Fix the login flow");
	});

	test("passes the configured model and cwd through to createSession, suppressing auto-start", async () => {
		setInternalTaskModel({ provider: "openai", id: "gpt-title" });
		const handle = new FakeSessionHandle("sess_model", "Some Title");
		const createSessionCalls: CreateSessionOpts[] = [];

		await generateSessionTitle(fakeBridge(handle, { createSessionCalls }), {
			cwd: "/tmp/model-ws",
			firstMessage: "Whatever",
		});

		expect(createSessionCalls).toHaveLength(1);
		expect(createSessionCalls[0]).toMatchObject({
			cwd: "/tmp/model-ws",
			suppressAutoStart: true,
			model: { provider: "openai", id: "gpt-title" },
		});
	});

	test("resolves a task id embedded in the first message and folds its title/body into the prompt", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const task = createTask({ title: "Fix the login flow", body: "Steps to repro..." });
		const handle = new FakeSessionHandle("sess_task_ctx", "T-1: Fix the login flow");

		await generateSessionTitle(fakeBridge(handle), {
			cwd: "/tmp/ws",
			firstMessage: `Please look at GET /api/tasks/${task.id} and fix it`,
		});

		expect(handle.prompts).toHaveLength(1);
		expect(handle.prompts[0]).toContain(`Linked kanban task: T-${task.displayId}: Fix the login flow`);
		expect(handle.prompts[0]).toContain("Steps to repro...");
	});

	test("a task-id-shaped substring embedded in a longer alphanumeric run does not spuriously match (TASK_ID_PATTERN is an exact 18-char boundary)", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const task = createTask({ title: "Should not be linked" });
		const handle = new FakeSessionHandle("sess_task_too_long", "Some Title");

		const result = await generateSessionTitle(fakeBridge(handle), {
			cwd: "/tmp/ws",
			// `task.id` (18 chars after `t_`) followed immediately by more
			// alnum chars, no word boundary at position 18 — must not match.
			firstMessage: `See ${task.id}extra for details`,
		});

		expect(result).toBe("Some Title");
		expect(handle.prompts[0]).not.toContain("Linked kanban task");
	});

	test("a first message without a task id builds a plain prompt with no linked-task context, and does not crash", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const handle = new FakeSessionHandle("sess_no_task", "Some Title");

		const result = await generateSessionTitle(fakeBridge(handle), {
			cwd: "/tmp/ws",
			firstMessage: "Just a normal message with no task reference",
		});

		expect(result).toBe("Some Title");
		expect(handle.prompts).toHaveLength(1);
		expect(handle.prompts[0]).not.toContain("Linked kanban task");
	});

	test("returns undefined and still cleans up the session when the turn ends without completing (aborted)", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const handle = new FakeSessionHandle("sess_aborted", "Should be ignored", {
			type: "turn_end",
			message: { stopReason: "aborted" },
		});
		const deleteSessionCalls: string[] = [];

		const result = await generateSessionTitle(fakeBridge(handle, { deleteSessionCalls }), {
			cwd: "/tmp/ws",
			firstMessage: "Hi",
		});

		expect(result).toBeUndefined();
		expect(deleteSessionCalls).toEqual(["sess_aborted"]);
	});

	test("returns undefined without throwing when bridge.createSession fails, and skips cleanup (nothing was created)", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const handle = new FakeSessionHandle("sess_unused", "Some Title");
		const deleteSessionCalls: string[] = [];

		const result = await generateSessionTitle(
			fakeBridge(handle, { createSessionError: new Error("bridge unavailable"), deleteSessionCalls }),
			{ cwd: "/tmp/ws", firstMessage: "Hi" },
		);

		expect(result).toBeUndefined();
		expect(deleteSessionCalls).toEqual([]);
	});

	for (const [name, response] of [
		["empty", ""],
		["whitespace-only", "   \n   "],
		["entirely punctuation", "```"],
	] as const) {
		test(`returns undefined when the model response is ${name}, and still cleans up the session`, async () => {
			setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
			const handle = new FakeSessionHandle("sess_empty", response);
			const deleteSessionCalls: string[] = [];

			const result = await generateSessionTitle(fakeBridge(handle, { deleteSessionCalls }), {
				cwd: "/tmp/ws",
				firstMessage: "Hi",
			});

			expect(result).toBeUndefined();
			expect(deleteSessionCalls).toEqual(["sess_empty"]);
		});
	}

	test("deleteSession is called on a successful run too, keyed to the created session id", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const handle = new FakeSessionHandle("sess_cleanup_ok", "Some Title");
		const deleteSessionCalls: string[] = [];

		await generateSessionTitle(fakeBridge(handle, { deleteSessionCalls }), { cwd: "/tmp/ws", firstMessage: "Hi" });

		expect(deleteSessionCalls).toEqual(["sess_cleanup_ok"]);
	});

	test("a rejecting deleteSession does not propagate out of generateSessionTitle", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const handle = new FakeSessionHandle("sess_cleanup_fails", "Some Title");

		const result = await generateSessionTitle(
			fakeBridge(handle, { deleteSessionError: new Error("cleanup transport died") }),
			{ cwd: "/tmp/ws", firstMessage: "Hi" },
		);

		expect(result).toBe("Some Title");
	});
});
