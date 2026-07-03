/**
 * T-106 — verify the deck bridge synthesizes a `todo_phases_set` event after
 * every `todo` `tool_execution_end`, so the Inspector TodoPanel
 * reflects in-turn changes without waiting for the SDK's reminder cycle.
 *
 * Tests the synthesis logic in isolation by replicating the listener shape
 * from `InProcessAgentBridge.attach()`'s `session.subscribe` callback —
 * spinning up a full `AgentSession` is overkill for what's effectively a
 * 5-line event filter. The integration risk (does the listener actually get
 * wired up?) is covered by the broader plan-mode-bridge.test.ts suite,
 * which already exercises the same subscribe path.
 */
import { describe, expect, it } from "bun:test";

/**
 * Replica of the synthesis logic from `apps/server/src/bridge/in-process.ts`
 * inside `attach()`. Keep this in sync with that code path; if the bridge
 * changes shape this test will need to follow.
 */
function makeListener(args: {
	emit: (event: { type: string; [k: string]: unknown }) => void;
	getTodoPhases: () => unknown[] | undefined;
}): (event: { type?: string; [k: string]: unknown }) => void {
	return (event) => {
		const type = event.type;
		if (type === "tool_execution_end") {
			const toolName = (event as { toolName?: string }).toolName;
			if (toolName === "todo") {
				const phases = args.getTodoPhases();
				if (Array.isArray(phases)) {
					args.emit({ type: "todo_phases_set", todoPhases: phases });
				}
			}
		}
	};
}

describe("todo_phases_set synthesis", () => {
	it("emits todo_phases_set after a todo tool_execution_end", () => {
		const emitted: Array<{ type: string; [k: string]: unknown }> = [];
		const phases = [
			{ id: "p1", name: "Phase 1", tasks: [{ content: "do thing", status: "pending" }] },
		];
		const listener = makeListener({
			emit: (e) => emitted.push(e),
			getTodoPhases: () => phases,
		});

		listener({ type: "tool_execution_end", toolName: "todo", toolCallId: "tc1" });

		expect(emitted.length).toBe(1);
		expect(emitted[0]?.type).toBe("todo_phases_set");
		expect(emitted[0]?.todoPhases).toBe(phases);
	});

	it("does not emit for other tool_execution_end events", () => {
		const emitted: Array<{ type: string; [k: string]: unknown }> = [];
		const listener = makeListener({
			emit: (e) => emitted.push(e),
			getTodoPhases: () => [{ id: "p", tasks: [] }],
		});

		listener({ type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" });
		listener({ type: "tool_execution_end", toolName: "read", toolCallId: "tc2" });
		listener({ type: "tool_execution_end", toolName: "edit", toolCallId: "tc3" });

		expect(emitted.length).toBe(0);
	});

	it("skips synthesis when getTodoPhases returns undefined or non-array", () => {
		const emitted: Array<{ type: string; [k: string]: unknown }> = [];
		// undefined
		makeListener({
			emit: (e) => emitted.push(e),
			getTodoPhases: () => undefined,
		})({ type: "tool_execution_end", toolName: "todo" });

		// not-an-array (defensive: SDK shouldn't ever do this but the bridge
		// must not crash if it does)
		makeListener({
			emit: (e) => emitted.push(e),
			getTodoPhases: () => ({}) as unknown as unknown[],
		})({ type: "tool_execution_end", toolName: "todo" });

		expect(emitted.length).toBe(0);
	});

	it("does not interfere with unrelated event types", () => {
		const emitted: Array<{ type: string; [k: string]: unknown }> = [];
		const listener = makeListener({
			emit: (e) => emitted.push(e),
			getTodoPhases: () => [{ id: "p", tasks: [] }],
		});

		listener({ type: "turn_end" });
		listener({ type: "message_start", message: {} });
		listener({ type: "agent_end" });
		listener({ type: "tool_execution_start", toolName: "todo" });

		expect(emitted.length).toBe(0);
	});

	it("emits once per todo tool_execution_end call", () => {
		const emitted: Array<{ type: string; [k: string]: unknown }> = [];
		const listener = makeListener({
			emit: (e) => emitted.push(e),
			getTodoPhases: () => [{ id: "p", tasks: [] }],
		});

		listener({ type: "tool_execution_end", toolName: "todo" });
		listener({ type: "tool_execution_end", toolName: "todo" });
		listener({ type: "tool_execution_end", toolName: "todo" });

		expect(emitted.length).toBe(3);
		for (const e of emitted) expect(e.type).toBe("todo_phases_set");
	});
});
