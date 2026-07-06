import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { AgentBridge, EventListener } from "./bridge/types.ts";
import { broadcastBus } from "./broadcast-bus.ts";
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
