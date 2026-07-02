import type { GoalModeContextWire } from "@omp-deck/protocol";

import { logger } from "../log.ts";

const log = logger("bridge:goal-mode");
const GOAL_TOOL = "goal";
const CONTINUATION_DELAY_MS = 800;

type GoalStatus = GoalModeContextWire["status"];

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: {
		id: string;
		objective: string;
		status: GoalStatus;
		tokenBudget?: number;
		tokensUsed: number;
		timeUsedSeconds: number;
		createdAt: number;
		updatedAt: number;
	};
}

interface GoalRuntimeSurface {
	createGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalModeState>;
	pauseGoal(): Promise<GoalModeState | undefined>;
	resumeGoal(): Promise<GoalModeState>;
	dropGoal(): Promise<unknown>;
	onBudgetMutated(tokenBudget: number | undefined): Promise<GoalModeState | undefined>;
	onThreadResumed(): Promise<GoalModeState | undefined>;
	buildContinuationPrompt(): string | undefined;
}

export interface GoalModeSessionSurface {
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): Promise<void>;
	getGoalModeState(): GoalModeState | undefined;
	setGoalModeState(state: GoalModeState | undefined): void;
	readonly goalRuntime: GoalRuntimeSurface;
	readonly isStreaming: boolean;
	abort(): Promise<void>;
	promptCustomMessage(
		message: { customType: string; content: string; display: boolean; attribution: "agent" },
		options?: { streamingBehavior?: "steer" | "followUp" },
	): Promise<void>;
}

export type GoalAction =
	| { action: "create"; objective: string; tokenBudget?: number }
	| { action: "pause" }
	| { action: "resume" }
	| { action: "cancel" }
	| { action: "set_budget"; tokenBudget?: number };

/** Owns the SDK goal lifecycle for one deck session. */
export class GoalModeBridge {
	private previousTools: string[] | undefined;
	private continuationTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(
		private readonly session: GoalModeSessionSurface,
		private readonly exitPlanMode: () => Promise<void>,
	) {}

	getContext(): GoalModeContextWire | undefined {
		const state = this.session.getGoalModeState();
		if (!state) return undefined;
		const { goal } = state;
		return {
			enabled: state.enabled,
			objective: goal.objective,
			status: goal.status,
			tokenBudget: goal.tokenBudget,
			tokensUsed: goal.tokensUsed,
			timeUsedSeconds: goal.timeUsedSeconds,
			reason: state.reason,
		};
	}

	async restore(state: GoalModeState | undefined): Promise<void> {
		if (!state) return;
		this.session.setGoalModeState(state);
		const restored = await this.session.goalRuntime.onThreadResumed();
		if (restored?.enabled) {
			this.previousTools = this.session.getActiveToolNames().filter((name) => name !== GOAL_TOOL);
			await this.session.setActiveToolsByName([...this.previousTools, GOAL_TOOL]);
		}
	}

	async act(action: GoalAction): Promise<void> {
		if (this.disposed) throw new Error("Goal Mode is unavailable because the session is disposed.");
		switch (action.action) {
			case "create":
				await this.exitPlanMode();
				await this.enter(action.objective, action.tokenBudget);
				return;
			case "pause":
				await this.pause();
				return;
			case "resume":
				await this.exitPlanMode();
				await this.resume();
				return;
			case "cancel":
				await this.cancel();
				return;
			case "set_budget":
				if (!this.session.getGoalModeState()?.enabled) throw new Error("No active goal.");
				await this.session.goalRuntime.onBudgetMutated(action.tokenBudget);
		}
	}

	async pauseForPlanMode(): Promise<void> {
		if (this.session.getGoalModeState()?.enabled) await this.pause();
	}

	observe(event: { type?: string }): void {
		if (event.type === "agent_end") this.scheduleContinuation();
	}

	dispose(): void {
		this.disposed = true;
		this.cancelContinuation();
	}

	private async enter(objective: string, tokenBudget?: number): Promise<void> {
		if (this.session.getGoalModeState()) throw new Error("A goal already exists. Cancel it before creating another.");
		const previousTools = this.session.getActiveToolNames().filter((name) => name !== GOAL_TOOL);
		const state = await this.session.goalRuntime.createGoal({ objective, tokenBudget });
		await this.session.setActiveToolsByName([...previousTools, GOAL_TOOL]);
		this.previousTools = previousTools;
		this.session.setGoalModeState(state);
		await this.session.promptCustomMessage(
			{ customType: "goal-start", content: objective, display: false, attribution: "agent" },
			this.session.isStreaming ? { streamingBehavior: "followUp" } : undefined,
		);
	}

	private async pause(): Promise<void> {
		this.cancelContinuation();
		const state = this.session.getGoalModeState();
		if (!state?.enabled) throw new Error("No active goal to pause.");
		await this.session.goalRuntime.pauseGoal();
		await this.restoreTools();
	}

	private async resume(): Promise<void> {
		const state = this.session.getGoalModeState();
		if (!state || state.enabled || state.goal.status !== "paused") throw new Error("No paused goal to resume.");
		const previousTools = this.session.getActiveToolNames().filter((name) => name !== GOAL_TOOL);
		const resumed = await this.session.goalRuntime.resumeGoal();
		await this.session.setActiveToolsByName([...previousTools, GOAL_TOOL]);
		this.previousTools = previousTools;
		this.session.setGoalModeState(resumed);
		this.scheduleContinuation();
	}

	private async cancel(): Promise<void> {
		this.cancelContinuation();
		if (!this.session.getGoalModeState()) throw new Error("No goal to cancel.");
		if (this.session.isStreaming) await this.session.abort();
		await this.session.goalRuntime.dropGoal();
		await this.restoreTools();
	}

	private async restoreTools(): Promise<void> {
		if (this.previousTools) await this.session.setActiveToolsByName(this.previousTools);
		this.previousTools = undefined;
	}

	private scheduleContinuation(): void {
		this.cancelContinuation();
		if (this.disposed || this.session.isStreaming || !this.session.getGoalModeState()?.enabled) return;
		const prompt = this.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.continuationTimer = setTimeout(() => {
			this.continuationTimer = undefined;
			if (this.disposed || this.session.isStreaming || !this.session.getGoalModeState()?.enabled) return;
			void this.session
				.promptCustomMessage(
					{ customType: "goal-continuation", content: prompt, display: false, attribution: "agent" },
				)
				.catch((error) => log.warn("goal continuation failed", error));
		}, CONTINUATION_DELAY_MS);
	}

	private cancelContinuation(): void {
		if (!this.continuationTimer) return;
		clearTimeout(this.continuationTimer);
		this.continuationTimer = undefined;
	}
}
