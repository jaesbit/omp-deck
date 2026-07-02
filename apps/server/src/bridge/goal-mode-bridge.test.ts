import { beforeEach, describe, expect, test } from "bun:test";

import { GoalModeBridge, type GoalModeState, type GoalModeSessionSurface } from "./goal-mode-bridge.ts";

class StubSession implements GoalModeSessionSurface {
	isStreaming = false;
	activeTools = ["read", "write"];
	state: GoalModeState | undefined;
	customMessages: Array<{ customType: string; content: string; display: boolean; attribution?: "agent" }> = [];
	abortCalls = 0;
	goalRuntime = {
		createGoal: async ({ objective, tokenBudget }: { objective: string; tokenBudget?: number }) => {
			this.state = this.makeState(objective, tokenBudget, true, "active");
			return this.state;
		},
		pauseGoal: async () => {
			if (!this.state) return undefined;
			this.state = { ...this.state, enabled: false, goal: { ...this.state.goal, status: "paused" } };
			return this.state;
		},
		resumeGoal: async () => {
			if (!this.state) throw new Error("No paused goal.");
			this.state = { ...this.state, enabled: true, goal: { ...this.state.goal, status: "active" } };
			return this.state;
		},
		dropGoal: async () => {
			this.state = undefined;
		},
		onBudgetMutated: async (tokenBudget: number | undefined) => {
			if (!this.state) return undefined;
			this.state = { ...this.state, goal: { ...this.state.goal, tokenBudget } };
			return this.state;
		},
		onThreadResumed: async () => {
			if (this.state?.enabled) await this.goalRuntime.pauseGoal();
			return this.state;
		},
		buildContinuationPrompt: () => (this.state?.enabled ? "continue" : undefined),
	};

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		this.activeTools = [...toolNames];
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.state;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.state = state;
	}

	async abort(): Promise<void> {
		this.abortCalls++;
	}
	async promptCustomMessage(message: { customType: string; content: string; display: boolean; attribution?: "agent" }): Promise<void> {
		this.customMessages.push(message);
	}

	private makeState(objective: string, tokenBudget: number | undefined, enabled: boolean, status: "active" | "paused"): GoalModeState {
		return {
			enabled,
			mode: "active",
			goal: {
				id: "g1",
				objective,
				status,
				tokenBudget,
				tokensUsed: 12,
				timeUsedSeconds: 3,
				createdAt: 1,
				updatedAt: 1,
			},
		};
	}
}

describe("GoalModeBridge", () => {
	let session: StubSession;
	let planExits: number;
	let bridge: GoalModeBridge;

	beforeEach(() => {
		session = new StubSession();
		planExits = 0;
		bridge = new GoalModeBridge(session, async () => {
			planExits++;
		});
	});

	test("creates a goal, installs the goal tool, and exposes budget progress", async () => {
		await bridge.act({ action: "create", objective: "Ship Goal Mode", tokenBudget: 100 });

		expect(planExits).toBe(1);
		expect(session.activeTools).toEqual(["read", "write", "goal"]);
		expect(session.customMessages).toEqual([
			{ customType: "goal-start", content: "Ship Goal Mode", display: false, attribution: "agent" },
		]);
		expect(bridge.getContext()).toEqual({
			enabled: true,
			objective: "Ship Goal Mode",
			status: "active",
			tokenBudget: 100,
			tokensUsed: 12,
			timeUsedSeconds: 3,
		});
	});

	test("pauses for Plan Mode and restores tools without dropping the goal", async () => {
		await bridge.act({ action: "create", objective: "Keep state" });
		await bridge.pauseForPlanMode();

		expect(session.activeTools).toEqual(["read", "write"]);
		expect(bridge.getContext()).toMatchObject({ enabled: false, status: "paused", objective: "Keep state" });
	});

	test("resumes a paused goal after exiting Plan Mode", async () => {
		await bridge.act({ action: "create", objective: "Resume safely" });
		await bridge.act({ action: "pause" });
		await bridge.act({ action: "resume" });

		expect(planExits).toBe(2);
		expect(session.activeTools).toEqual(["read", "write", "goal"]);
		expect(bridge.getContext()).toMatchObject({ enabled: true, status: "active" });
	});

	test("cancels a paused or active goal and always restores tools", async () => {
		await bridge.act({ action: "create", objective: "Cancel me" });
		session.isStreaming = true;
		await bridge.act({ action: "cancel" });

		expect(session.abortCalls).toBe(1);
		expect(session.activeTools).toEqual(["read", "write"]);
		expect(bridge.getContext()).toBeUndefined();
	});

	test("restores a persisted active goal as paused after reconnect", async () => {
		await bridge.act({ action: "create", objective: "Reconnect" });
		const persisted = session.getGoalModeState()!;
		session.activeTools = ["read", "write"];
		const reconnect = new GoalModeBridge(session, async () => {});
		await reconnect.restore(persisted);

		expect(reconnect.getContext()).toMatchObject({ enabled: false, status: "paused", objective: "Reconnect" });
		expect(session.activeTools).toEqual(["read", "write"]);
	});
});
