/**
 * Tests for the per-subscriber stream coalescer that throttles
 * `message_update` / `tool_execution_update` frames on the session WS.
 *
 * The clock is fully faked (`jest.useFakeTimers` advances `Date.now()` in
 * lockstep with timer callbacks in Bun), so the leading-edge / trailing-flush
 * schedule is asserted deterministically — no real sleeps.
 *
 * Events carry a test-only `tag` field (the protocol event type is an open
 * record) so assertions read as compact delivery sequences.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { AgentSessionEventJson } from "@omp-deck/protocol";

import { StreamCoalescer } from "./stream-coalescer.ts";

const INTERVAL_MS = 20;

function msgUpdate(role: string, tag: string): AgentSessionEventJson {
	return { type: "message_update", message: { role, content: tag }, tag };
}

function msgEnd(role: string, tag: string): AgentSessionEventJson {
	return { type: "message_end", message: { role, content: tag }, tag };
}

function toolUpdate(toolCallId: string, tag: string): AgentSessionEventJson {
	return { type: "tool_execution_update", toolCallId, tag };
}

function toolEnd(toolCallId: string, tag: string): AgentSessionEventJson {
	return { type: "tool_execution_end", toolCallId, tag };
}

function harness(): { tags: () => string[]; coalescer: StreamCoalescer } {
	const emitted: AgentSessionEventJson[] = [];
	const coalescer = new StreamCoalescer((event) => emitted.push(event), INTERVAL_MS);
	return { tags: () => emitted.map((e) => String(e.tag)), coalescer };
}

describe("StreamCoalescer", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	test("first update after a quiet period is delivered synchronously; the burst behind it is not", () => {
		const { tags, coalescer } = harness();

		coalescer.push(msgUpdate("assistant", "u1"));
		expect(tags()).toEqual(["u1"]);

		coalescer.push(msgUpdate("assistant", "u2"));
		coalescer.push(msgUpdate("assistant", "u3"));
		expect(tags()).toEqual(["u1"]);

		coalescer.dispose();
	});

	test("trailing flush delivers only the latest update per slot, exactly once per interval", () => {
		const { tags, coalescer } = harness();

		coalescer.push(msgUpdate("assistant", "u1"));
		coalescer.push(msgUpdate("assistant", "u2"));
		coalescer.push(msgUpdate("assistant", "u3"));

		// Timer is armed for the remainder of the interval — not a full one.
		jest.advanceTimersByTime(INTERVAL_MS - 1);
		expect(tags()).toEqual(["u1"]);
		jest.advanceTimersByTime(1);
		expect(tags()).toEqual(["u1", "u3"]);

		// One flush per buffered burst — an idle interval emits nothing more.
		jest.advanceTimersByTime(INTERVAL_MS * 3);
		expect(tags()).toEqual(["u1", "u3"]);

		coalescer.dispose();
	});

	test("leading edge re-arms once a full interval passes with an empty buffer", () => {
		const { tags, coalescer } = harness();

		coalescer.push(msgUpdate("assistant", "u1"));
		jest.advanceTimersByTime(INTERVAL_MS);

		coalescer.push(msgUpdate("assistant", "u2"));
		expect(tags()).toEqual(["u1", "u2"]);

		coalescer.dispose();
	});

	test("slots are independent (message role / toolCallId); a passthrough event flushes the buffer first, in insertion order", () => {
		const { tags, coalescer } = harness();

		coalescer.push(msgUpdate("assistant", "asst-1")); // leading edge
		coalescer.push(msgUpdate("assistant", "asst-2")); // buffered slot msg:assistant
		coalescer.push(msgUpdate("user", "user-1")); // buffered slot msg:user
		coalescer.push(toolUpdate("t1", "t1-v1")); // buffered slot tool:t1
		coalescer.push(toolUpdate("t2", "t2-v1")); // buffered slot tool:t2
		coalescer.push(toolUpdate("t1", "t1-v2")); // replaces t1-v1, keeps t1's position
		expect(tags()).toEqual(["asst-1"]);

		coalescer.push({ type: "turn_start", tag: "turn" });
		expect(tags()).toEqual(["asst-1", "asst-2", "user-1", "t1-v2", "t2-v1", "turn"]);

		// The flush consumed the buffer and cancelled the timer.
		jest.advanceTimersByTime(INTERVAL_MS * 2);
		expect(tags()).toEqual(["asst-1", "asst-2", "user-1", "t1-v2", "t2-v1", "turn"]);

		coalescer.dispose();
	});

	test("non-coalescible events pass through synchronously even with an empty buffer mid-interval", () => {
		const { tags, coalescer } = harness();

		coalescer.push(msgUpdate("assistant", "u1"));
		coalescer.push({ type: "agent_start", tag: "start" });
		expect(tags()).toEqual(["u1", "start"]);

		coalescer.dispose();
	});

	test("message_end drops the pending update of the same role but still flushes other slots", () => {
		const { tags, coalescer } = harness();

		coalescer.push(msgUpdate("assistant", "u1")); // leading edge
		coalescer.push(msgUpdate("assistant", "u2")); // superseded by the end below
		coalescer.push(toolUpdate("t1", "t1-v1")); // unrelated slot — must survive

		coalescer.push(msgEnd("assistant", "end"));
		expect(tags()).toEqual(["u1", "t1-v1", "end"]);

		// The superseded update is gone for good, not merely delayed.
		jest.advanceTimersByTime(INTERVAL_MS * 2);
		expect(tags()).toEqual(["u1", "t1-v1", "end"]);

		coalescer.dispose();
	});

	test("tool_execution_end drops only the pending update with the same toolCallId", () => {
		const { tags, coalescer } = harness();

		coalescer.push(toolUpdate("t1", "t1-v1")); // leading edge
		coalescer.push(toolUpdate("t1", "t1-v2")); // superseded by end(t1)
		coalescer.push(toolUpdate("t2", "t2-v1")); // different id — must survive

		coalescer.push(toolEnd("t1", "t1-end"));
		expect(tags()).toEqual(["t1-v1", "t2-v1", "t1-end"]);

		jest.advanceTimersByTime(INTERVAL_MS * 2);
		expect(tags()).toEqual(["t1-v1", "t2-v1", "t1-end"]);

		coalescer.dispose();
	});

	test("dispose cancels the pending flush and silences every later push", () => {
		const { tags, coalescer } = harness();

		coalescer.push(msgUpdate("assistant", "u1")); // leading edge
		coalescer.push(msgUpdate("assistant", "u2")); // buffered behind a live timer

		coalescer.dispose();
		jest.advanceTimersByTime(INTERVAL_MS * 5);
		expect(tags()).toEqual(["u1"]);

		coalescer.push(msgUpdate("assistant", "u3"));
		coalescer.push({ type: "agent_start", tag: "start" });
		expect(tags()).toEqual(["u1"]);

		coalescer.dispose(); // idempotent
		expect(tags()).toEqual(["u1"]);
	});
});
