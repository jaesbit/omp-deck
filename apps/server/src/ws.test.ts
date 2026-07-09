import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentBridge, CreateSessionOpts, EventListener, SessionHandle } from "./bridge/types.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { closeDb, openDb } from "./db/index.ts";
import { setInternalTaskModel } from "./db/server-settings.ts";
import type { ConnectionData } from "./ws.ts";
import { WsHub } from "./ws.ts";

type TestSocket = {
	data: ConnectionData;
	sent: string[];
	send(payload: string): void;
};

function makeSocket(hub: WsHub): TestSocket {
	const socket: TestSocket = {
		data: hub.createConnectionData(),
		sent: [],
		send(payload) {
			this.sent.push(payload);
		},
	};
	hub.onOpen(socket as unknown as ServerWebSocket<ConnectionData>);
	return socket;
}

function frames(socket: TestSocket): Array<{ type: string; [key: string]: unknown }> {
	return socket.sent.map((payload) => JSON.parse(payload) as { type: string; [key: string]: unknown });
}

function fakeBridge(): {
	bridge: AgentBridge;
	emitSessionEvent(event: unknown): void;
	removed: Array<{ sessionId: string; connectionId: string }>;
} {
	const listeners = new Set<EventListener>();
	const removed: Array<{ sessionId: string; connectionId: string }> = [];
	const handle = {
		sessionId: "session-1",
		sessionFile: undefined,
		cwd: "/workspace",
		subscribe(listener: EventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		snapshot() {
			return {};
		},
		getHistory() {
			return { messages: [], startIndex: 0 };
		},
	};

	return {
		bridge: {
			getSession: (sessionId: string) => (sessionId === "session-1" ? handle : undefined),
			trackSubscriberAdded() {},
			trackSubscriberRemoved(sessionId: string, connectionId: string) {
				removed.push({ sessionId, connectionId });
			},
			subscribeUiFrames() {
				return () => {};
			},
			subscribePlanModeFrames() {
				return () => {};
			},
		} as unknown as AgentBridge,
		emitSessionEvent(event: unknown) {
			for (const listener of listeners) listener(event as never);
		},
		removed,
	};
}

const noopSkills = {} as ConstructorParameters<typeof WsHub>[1];

describe("WsHub subscription ownership", () => {
	test("delivers task changes only while that connection explicitly subscribes to tasks", async () => {
		const { bridge } = fakeBridge();
		const hub = new WsHub(bridge, noopSkills);
		const taskView = makeSocket(hub);
		const chatOnly = makeSocket(hub);
		try {
			taskView.sent.length = 0;
			chatOnly.sent.length = 0;

			// The raw wire payload deliberately exercises the public WebSocket
			// boundary; task subscription must not be inferred from a session
			// subscription or from merely having an open connection.
			await hub.onMessage(
				taskView as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe_tasks" }),
			);
			taskView.sent.length = 0;

			broadcastBus.broadcast({ type: "tasks_changed" });

			expect(frames(taskView)).toEqual([{ type: "tasks_changed" }]);
			expect(frames(chatOnly)).toEqual([]);

			await hub.onMessage(
				taskView as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "unsubscribe_tasks" }),
			);
			taskView.sent.length = 0;
			broadcastBus.broadcast({ type: "tasks_changed" });

			expect(frames(taskView)).toEqual([]);
		} finally {
			hub.onClose(taskView as unknown as ServerWebSocket<ConnectionData>);
			hub.onClose(chatOnly as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("unsubscribe stops session-event delivery and releases the reaper ownership pin", async () => {
		const { bridge, emitSessionEvent, removed } = fakeBridge();
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			socket.sent.length = 0;
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
			);
			socket.sent.length = 0;

			emitSessionEvent({ type: "agent_start" });
			expect(frames(socket)).toEqual([
				{ type: "session_event", sessionId: "session-1", event: { type: "agent_start" } },
			]);

			socket.sent.length = 0;
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "unsubscribe", sessionId: "session-1" }),
			);
			socket.sent.length = 0;
			emitSessionEvent({ type: "agent_end" });

			expect(frames(socket)).toEqual([]);
			expect(removed).toEqual([{ sessionId: "session-1", connectionId: socket.data.connectionId }]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});
});

/**
 * The subscribe path routes session events through a per-subscriber
 * StreamCoalescer (default 1s interval): streaming updates are throttled to
 * a leading-edge emit + one flush per interval, everything else passes
 * through immediately. These cases only assert the synchronous paths — the
 * timer schedule itself is covered in stream-coalescer.test.ts.
 */
describe("WsHub stream coalescing", () => {
	test("delivers the first streaming update, buffers the burst, and drops it when message_end supersedes", async () => {
		const { bridge, emitSessionEvent } = fakeBridge();
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
			);
			socket.sent.length = 0;

			const u1 = { type: "message_update", message: { role: "assistant", content: "He" } };
			const u2 = { type: "message_update", message: { role: "assistant", content: "Hello" } };
			const end = { type: "message_end", message: { role: "assistant", content: "Hello!" } };

			// Leading edge: the first update after subscribe goes out synchronously.
			emitSessionEvent(u1);
			expect(frames(socket)).toEqual([{ type: "session_event", sessionId: "session-1", event: u1 }]);

			// The second update within the interval is held back.
			emitSessionEvent(u2);
			expect(frames(socket)).toEqual([{ type: "session_event", sessionId: "session-1", event: u1 }]);

			// message_end supersedes the buffered update: the end frame arrives,
			// the intermediate u2 never does.
			emitSessionEvent(end);
			expect(frames(socket)).toEqual([
				{ type: "session_event", sessionId: "session-1", event: u1 },
				{ type: "session_event", sessionId: "session-1", event: end },
			]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("a non-coalescible event passes through immediately, flushing the buffered update ahead of itself", async () => {
		const { bridge, emitSessionEvent } = fakeBridge();
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
			);
			socket.sent.length = 0;

			const u1 = { type: "message_update", message: { role: "assistant", content: "a" } };
			const u2 = { type: "message_update", message: { role: "assistant", content: "ab" } };
			const start = { type: "agent_start" };

			emitSessionEvent(u1); // leading edge — synchronous
			emitSessionEvent(u2); // buffered
			emitSessionEvent(start); // passthrough — must flush u2 first

			expect(frames(socket)).toEqual([
				{ type: "session_event", sessionId: "session-1", event: u1 },
				{ type: "session_event", sessionId: "session-1", event: u2 },
				{ type: "session_event", sessionId: "session-1", event: start },
			]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});
});

/**
 * T-78: `WsHub#maybeAutoTitleSession`, the fire-and-forget hook fired from
 * the top of `handlePrompt`. Needs a real on-disk DB (unlike the rest of
 * this file) because `getInternalTaskModel()` / `generateSessionTitle()`
 * read the `internalTaskModel` server setting directly. The fake one-shot
 * title session's terminal event fires synchronously inside `subscribe()`
 * (no real timer), so the whole chain resolves on the microtask queue —
 * every assertion below synchronizes on either the `sessions_changed`
 * broadcast it ends with, or (for the negative cases, which never reach
 * that broadcast) on a `snapshot()` call plus a microtask flush.
 */
describe("WsHub auto-title-on-first-prompt", () => {
	let dbDir: string;

	beforeEach(() => {
		dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-ws-auto-title-db-"));
		openDb({ path: path.join(dbDir, "deck.db") });
	});

	afterEach(() => {
		closeDb();
		fs.rmSync(dbDir, { recursive: true, force: true });
	});

	function fakePromptBridge(opts: { sessionName?: string; titleResponse?: string } = {}): {
		bridge: AgentBridge;
		promptCalls: string[];
		setNameCalls: string[];
		createSessionCalls: CreateSessionOpts[];
		snapshotCalled: Promise<void>;
	} {
		const promptCalls: string[] = [];
		const setNameCalls: string[] = [];
		const createSessionCalls: CreateSessionOpts[] = [];
		const snapshotCalled = Promise.withResolvers<void>();

		const handle = {
			sessionId: "session-1",
			sessionFile: undefined,
			cwd: "/workspace",
			subscribe(_listener: EventListener) {
				return () => {};
			},
			snapshot() {
				snapshotCalled.resolve();
				return opts.sessionName ? { sessionName: opts.sessionName } : {};
			},
			getHistory() {
				return { messages: [], startIndex: 0 };
			},
			async prompt(text: string) {
				promptCalls.push(text);
			},
			async setName(name: string) {
				setNameCalls.push(name);
			},
		};

		// The one-shot session `generateSessionTitle` spins up internally for
		// the title-generation turn. Its terminal event fires synchronously
		// from `subscribe()` (see `session-title.test.ts`'s `FakeSessionHandle`
		// for why a real timer would deadlock the sequential-await shape of
		// `generateSessionTitle`), so this whole path never touches real time.
		const titleTurnEnded = Promise.withResolvers<void>();
		const titleHandle = {
			sessionId: "title-session-1",
			subscribe(listener: EventListener) {
				listener({ type: "turn_end" } as never);
				titleTurnEnded.resolve();
				return () => {};
			},
			async prompt() {
				await titleTurnEnded.promise;
			},
			async snapshot() {
				return { messages: [{ role: "assistant", content: opts.titleResponse ?? "Generated Title" }] };
			},
		};

		return {
			bridge: {
				getSession: (sessionId: string) => (sessionId === "session-1" ? handle : undefined),
				trackSubscriberAdded() {},
				trackSubscriberRemoved() {},
				subscribeUiFrames() {
					return () => {};
				},
				subscribePlanModeFrames() {
					return () => {};
				},
				bumpActivity() {},
				async createSession(createOpts: CreateSessionOpts) {
					createSessionCalls.push(createOpts);
					return titleHandle as unknown as SessionHandle;
				},
				async deleteSession() {
					return { deleted: true };
				},
			} as unknown as AgentBridge,
			promptCalls,
			setNameCalls,
			createSessionCalls,
			snapshotCalled: snapshotCalled.promise,
		};
	}

	test("triggers title generation on the first prompt, renaming the session and broadcasting sessions_changed", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const { bridge, setNameCalls, createSessionCalls } = fakePromptBridge({ titleResponse: "Fix The Login Bug" });
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			const sessionsChanged = new Promise<void>((resolve) => {
				const stop = broadcastBus.subscribe((frame) => {
					if (frame.type === "sessions_changed") {
						stop();
						resolve();
					}
				});
			});

			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "Fix the login bug please" }),
			);
			await sessionsChanged;

			expect(createSessionCalls).toHaveLength(1);
			expect(setNameCalls).toEqual(["Fix The Login Bug"]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("never renames a session that already has a sessionName", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const { bridge, setNameCalls, createSessionCalls, snapshotCalled } = fakePromptBridge({
			sessionName: "Already Named",
		});
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "Hello" }),
			);
			await snapshotCalled;
			// Flush the microtask hops between `snapshot()` resolving and the
			// early `if (snapshot.sessionName) return` landing right after it.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(setNameCalls).toEqual([]);
			expect(createSessionCalls).toEqual([]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("a second prompt on the same session never re-triggers generation", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const { bridge, createSessionCalls } = fakePromptBridge({ titleResponse: "First Title" });
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			const sessionsChanged = new Promise<void>((resolve) => {
				const stop = broadcastBus.subscribe((frame) => {
					if (frame.type === "sessions_changed") {
						stop();
						resolve();
					}
				});
			});
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "First message" }),
			);
			await sessionsChanged;
			expect(createSessionCalls).toHaveLength(1);

			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "Second message" }),
			);

			expect(createSessionCalls).toHaveLength(1);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("attempts no title generation at all when internalTaskModel is unset, leaving the normal prompt flow unchanged", async () => {
		const { bridge, setNameCalls, createSessionCalls, promptCalls } = fakePromptBridge();
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "Hello" }),
			);

			expect(promptCalls).toEqual(["Hello"]);
			expect(createSessionCalls).toEqual([]);
			expect(setNameCalls).toEqual([]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});
});
