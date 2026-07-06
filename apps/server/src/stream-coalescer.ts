import type { AgentSessionEventJson } from "@omp-deck/protocol";

import { logger } from "./log.ts";

const log = logger("stream-coalescer");

/**
 * Flush cadence for coalesced streaming events. During an assistant turn the
 * SDK emits `message_update` per token (each carrying the FULL accumulated
 * message content) and `tool_execution_update` per output chunk — tens of
 * frames per second whose payload grows with the message. One second of
 * latency on streaming text is imperceptible next to the multi-second turn
 * time, while state-changing events (message_start/end, tool start/end,
 * turn lifecycle, …) still pass through immediately.
 */
export const STREAM_FLUSH_INTERVAL_MS = 1000;

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Per-subscriber throttle for the session event stream.
 *
 * `message_update` and `tool_execution_update` are idempotent latest-state
 * snapshots (the reducer on the other end replaces, never appends), so
 * intermediate frames can be dropped losslessly: only the most recent one
 * per slot is kept and flushed at most once per `intervalMs`. Every other
 * event type is delivered immediately — after flushing any buffered updates
 * so relative ordering the reducer depends on is preserved (e.g. a buffered
 * `message_update` must never land after the `message_start` of the NEXT
 * assistant message).
 *
 * Supersede rules: a `message_end` replaces the content of the last
 * assistant message wholesale, so a pending `message_update` for the same
 * role is dropped rather than flushed; likewise `tool_execution_end` drops
 * a pending `tool_execution_update` for the same toolCallId.
 */
export class StreamCoalescer {
	/** Latest coalescible event per slot, insertion-ordered. */
	private pending = new Map<string, AgentSessionEventJson>();
	private timer: TimerHandle | null = null;
	private lastFlushAt = 0;
	private disposed = false;

	constructor(
		private readonly emit: (event: AgentSessionEventJson) => void,
		private readonly intervalMs: number = STREAM_FLUSH_INTERVAL_MS,
	) {}

	push(event: AgentSessionEventJson): void {
		if (this.disposed) return;
		switch (event.type) {
			case "message_update":
				this.enqueue(`msg:${messageRole(event)}`, event);
				return;
			case "tool_execution_update":
				this.enqueue(`tool:${String(event.toolCallId ?? "")}`, event);
				return;
			case "message_end":
				this.pending.delete(`msg:${messageRole(event)}`);
				break;
			case "tool_execution_end":
				this.pending.delete(`tool:${String(event.toolCallId ?? "")}`);
				break;
		}
		// Non-coalescible event: deliver buffered updates first, then the
		// event itself, so downstream ordering is preserved.
		this.flush();
		this.emit(event);
	}

	private enqueue(key: string, event: AgentSessionEventJson): void {
		const now = Date.now();
		// Leading edge: an update arriving after a quiet period goes out
		// immediately (first token appears without the full interval lag);
		// the burst that follows is what gets throttled.
		if (this.pending.size === 0 && now - this.lastFlushAt >= this.intervalMs) {
			this.lastFlushAt = now;
			this.emit(event);
			return;
		}
		this.pending.set(key, event);
		if (this.timer === null) {
			const delay = Math.max(0, this.lastFlushAt + this.intervalMs - now);
			this.timer = setTimeout(() => {
				this.timer = null;
				// A thrown error inside a Bun timer callback kills the whole
				// process — degrade to a logged miss instead.
				try {
					this.flush();
				} catch (err) {
					log.warn(`coalesced flush failed`, err);
				}
			}, delay);
		}
	}

	private flush(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.pending.size === 0) return;
		const events = [...this.pending.values()];
		this.pending.clear();
		this.lastFlushAt = Date.now();
		for (const event of events) {
			this.emit(event);
		}
	}

	/** Drop buffered events and cancel the timer. Idempotent. */
	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.pending.clear();
	}
}

function messageRole(event: AgentSessionEventJson): string {
	const msg = event.message;
	if (msg && typeof msg === "object" && "role" in msg) {
		const role = (msg as Record<string, unknown>).role;
		if (typeof role === "string") return role;
	}
	return "";
}
