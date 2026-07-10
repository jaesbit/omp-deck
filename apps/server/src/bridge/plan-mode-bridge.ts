/**
 * Per-session bridge for omp plan mode.
 *
 * Mirrors the TUI's `InteractiveMode.#enterPlanMode` lifecycle on top of
 * the deck's WebSocket protocol:
 *
 *   1. Client sends `set_plan_mode {enabled:true}` → `enter()`:
 *      - snapshot active tools, splice in `resolve` if missing
 *      - `setActiveToolsByName(planTools)`
 *      - `setPlanModeState({ enabled, planFilePath, workflow })`
 *      - `setStandingResolveHandler(#handlePlanResolve)`
 *      - broadcast `plan_mode_changed{enabled:true}`
 *
 *   2. Agent works under plan-mode restrictions (SDK's
 *      `#enforcePlanModeToolDecision` blocks writes via the system
 *      prompt + tool-decision intercept), writes `local://PLAN.md`,
 *      calls `resolve apply`. The SDK invokes our standing handler
 *      via `runResolveInvocation`.
 *
 *   3. `#handlePlanResolve`'s `apply` callback:
 *      - validates plan-mode is still active
 *      - reads the plan file via `local://` resolver
 *      - derives a title via `resolvePlanTitle` (handles issue #1179
 *        empty-`extra.title` corner case)
 *      - broadcasts `plan_proposed` to the deck UI
 *      - **blocks** on a Promise the deck UI settles via
 *        `plan_response` → `respond(proposalId, response)`
 *
 *   4. On approve: write edited content (if any), rename PLAN.md to
 *      the title-derived final path, exit plan mode (restoring the
 *      previous tool set + clearing handler + clearing SDK state),
 *      and queue the SDK's `planModeApprovedPrompt` as a follow-up
 *      so the next turn executes the plan with full tools.
 *
 *   5. On reject: exit plan mode and surface a clear rejection
 *      message to the agent.
 *
 *   6. On cancel (user toggles plan mode off mid-approval) or session
 *      dispose: reject the pending promise so the resolve tool
 *      returns with an error the agent can recover from.
 *
 * SDK reference impl: `@oh-my-pi/pi-coding-agent/src/modes/interactive-mode.ts`
 * (`#enterPlanMode`, `#runPlanApprovalResolve`, `#exitPlanMode`,
 * `#approvePlan`).
 */
import * as fs from "node:fs/promises";

import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	type PlanApprovalDetails,
	resolvePlanTitle,
} from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { type ResolveToolDetails, runResolveInvocation } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type {
	ModelRef,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	PlanModeModelOverrideWire,
	ServerFrame,
} from "@omp-deck/protocol";

import type { PlanApprovalResponse } from "./types.ts";

import { logger } from "../log.ts";

const log = logger("bridge:plan-mode");

/** Canonical plan file URL. The SDK's `resolve` tool, the TUI, and the
 *  plan-mode system prompt all use this exact path; do not vary per-session. */
const PLAN_FILE_URL = "local://PLAN.md";

/** Tool the SDK requires for plan-mode submission. Spliced into the active
 *  tool set on enter if it isn't already there. */
const RESOLVE_TOOL = "resolve";

/** Workflow flavor passed to `setPlanModeState`. MVP only supports
 *  `"parallel"`; `"iterative"` (TUI-only) is explicitly out of scope. */
const PLAN_WORKFLOW = "parallel" as const;

/**
 * Pre-rendered companion to
 * `@oh-my-pi/pi-coding-agent/src/prompts/system/plan-mode-approved.md`
 * with the deck's fixed branches baked in:
 *   - `contextPreserved: true` (deck never compacts at the plan boundary;
 *     deferred to v1.1 — see design doc §"open questions" #2)
 *   - `tools` includes `todo` (deck's session tool set always has it)
 *
 * Inlined because the SDK's `exports` map doesn't expose `.md` assets, and
 * we want a stable contract that's visible alongside the lifecycle code
 * rather than a fragile runtime fetch. **Mirror SDK changes here on
 * upgrade.** Diff against the upstream file when bumping
 * `@oh-my-pi/pi-coding-agent`.
 */
const PLAN_APPROVED_PROMPT_TEMPLATE = `<critical>
Plan approved. You MUST execute it now.
</critical>

Finalized plan artifact: \`{{planFilePath}}\`
Context preserved. Use conversation history when useful; the finalized plan is the source of truth if it conflicts with earlier exploration.

## Plan

{{planContent}}

<instruction>
You MUST execute this plan step by step from \`{{planFilePath}}\`. You have full tool access.
You MUST verify each step before proceeding to the next.
Before execution, initialize todo tracking with \`todo\`.
After each completed step, immediately update \`todo\`.
If \`todo\` fails, fix the payload and retry before continuing.
</instruction>

<critical>
You MUST keep going until complete. This matters.
</critical>
`;

type PlanModeChangedFrame = Extract<ServerFrame, { type: "plan_mode_changed" }>;
type PlanProposedFrame = Extract<ServerFrame, { type: "plan_proposed" }>;
type PlanProposalResolvedFrame = Extract<ServerFrame, { type: "plan_proposal_resolved" }>;
export type PlanModeFrame = PlanModeChangedFrame | PlanProposedFrame | PlanProposalResolvedFrame;

type FrameListener = (frame: PlanModeFrame) => void;

interface PendingApproval {
	proposalId: string;
	planFilePath: string;
	planContent: string;
	suggestedTitle: string;
	suggestedFinalPath: string;
	resolve: (resp: PlanApprovalResponse) => void;
	reject: (err: Error) => void;
}

/**
 * Minimal `AgentSession` surface this bridge needs. Listed here as a
 * structural interface so tests can substitute a hand-rolled fake without
 * spinning up the full SDK.
 */
export interface PlanModeSessionSurface {
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): Promise<void>;
	setPlanModeState(state: { enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined): void;
	setStandingResolveHandler(
		handler: ((input: unknown) => Promise<unknown> | unknown) | null,
	): void;
	markPlanReferenceSent(): void;
	readonly isStreaming: boolean;
	prompt(
		text: string,
		options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" },
	): Promise<void>;
}

/** Model+thinking configuration for the plan-role override. */
export interface PlanModelConfig {
	provider: string;
	id: string;
	/** Thinking level to apply with the plan model, or undefined for the default. */
	thinking?: string;
}

/**
 * Injected controller the bridge uses to read + drive the session's model.
 * Kept separate from `PlanModeSessionSurface` so the model-switch path can be
 * tested with a fake independent of the plan-mode tool/state surface, and so
 * the whole feature is inert (no-op) when the host omits the controller.
 *
 * `setModelTemporary` MUST switch the active model WITHOUT persisting it as the
 * session's default (mirrors the SDK's `AgentSession.setModelTemporary`), so
 * exit can restore the user's original model.
 */
export interface PlanModelController {
	/** Configured plan-role model, or null when no override is set (feature off). */
	getConfig(): PlanModelConfig | null;
	/** The session's currently active model, or undefined when none is selected. */
	currentModel(): ModelRef | undefined;
	/** The session's currently configured thinking level, or undefined. */
	currentThinking(): string | undefined;
	/** Whether the session is mid-stream — switches MUST be deferred if so. */
	isStreaming(): boolean;
	/** Temporarily switch the active model (+ optional thinking). Throws on failure. */
	setModelTemporary(model: ModelRef, thinking?: string): Promise<void>;
	/** Set only the thinking level (used when the plan model equals the current). */
	setThinkingLevel(thinking: string | undefined): void;
}

export interface PlanModeBridgeArgs {
	sessionId: string;
	session: PlanModeSessionSurface;
	/** SDK `sessionManager.getArtifactsDir()` — feeds `local://` resolution. */
	getArtifactsDir: () => string | null;
	/** SDK `sessionManager.getSessionId()` — feeds `local://` resolution. */
	getSessionId: () => string | null;
	/** Controls the plan-role model override. Omit to disable model switching. */
	planModel?: PlanModelController;
}

/** Bridge over the SDK's plan-mode primitives, scoped to one session. */
export class PlanModeBridge {
	private readonly sessionId: string;
	private readonly session: PlanModeSessionSurface;
	private readonly getArtifactsDir: () => string | null;
	private readonly getSessionId: () => string | null;
	private readonly planModel: PlanModelController | undefined;
	private readonly listeners = new Set<FrameListener>();
	private nextProposalCounter = 1;
	private enabled = false;
	private planFilePath: string = PLAN_FILE_URL;
	private previousTools: string[] = [];
	private pendingApproval: PendingApproval | undefined;
	private disposed = false;
	/**
	 * Persistent (pre-plan) model + thinking captured on enter, restored on
	 * exit. Set while a plan-model override is active OR its switch/restore is
	 * deferred, so `getPersistentModelState()` can keep the snapshot's session
	 * model showing the user's model rather than the temporary plan model.
	 */
	private previousModelState: { model: ModelRef; thinking?: string } | undefined;
	/** Deferred model switch (enter apply or exit restore) applied on the next
	 *  `agent_end` when the session was streaming at the transition. */
	private pendingModelSwitch: { model: ModelRef; thinking?: string } | undefined;
	/** The plan model currently applied (not deferred) — feeds the wire override. */
	private activeModelOverride: { model: ModelRef; thinking?: string } | undefined;

	constructor(args: PlanModeBridgeArgs) {
		this.sessionId = args.sessionId;
		this.session = args.session;
		this.getArtifactsDir = args.getArtifactsDir;
		this.getSessionId = args.getSessionId;
		this.planModel = args.planModel;
	}

	// ─── Snapshot + replay surface (consumed by InProcessAgentBridge) ─────

	isEnabled(): boolean {
		return this.enabled;
	}

	hasPendingApproval(): boolean {
		return this.pendingApproval !== undefined;
	}

	getPlanModeContext(): PlanModeContextWire | undefined {
		if (!this.enabled) return undefined;
		const modelOverride = this.#modelOverrideWire();
		return {
			enabled: true,
			planFilePath: this.planFilePath,
			...(modelOverride ? { modelOverride } : {}),
		};
	}

	/**
	 * Persistent (pre-plan) model + thinking, exposed so the snapshot can keep
	 * reporting the user's model as the session model while a temporary plan
	 * model is active (or its switch/restore is deferred). `undefined` when no
	 * override is in effect.
	 */
	getPersistentModelState(): { model: ModelRef; thinking?: string } | undefined {
		return this.previousModelState;
	}

	/** Wire shape of the effective plan-model override, or undefined when none
	 *  is applied/pending for the current plan-mode session. */
	#modelOverrideWire(): PlanModeModelOverrideWire | undefined {
		if (!this.enabled) return undefined;
		const applied = this.activeModelOverride;
		if (applied) {
			return { model: applied.model, ...(applied.thinking ? { thinking: applied.thinking } : {}), pending: false };
		}
		const pending = this.pendingModelSwitch;
		if (pending) {
			return { model: pending.model, ...(pending.thinking ? { thinking: pending.thinking } : {}), pending: true };
		}
		return undefined;
	}

	getPendingPlanApproval(): PendingPlanApprovalWire | undefined {
		const p = this.pendingApproval;
		if (!p) return undefined;
		return {
			proposalId: p.proposalId,
			planFilePath: p.planFilePath,
			planContent: p.planContent,
			suggestedTitle: p.suggestedTitle,
			suggestedFinalPath: p.suggestedFinalPath,
		};
	}

	/** Replay frames sent verbatim to a late subscriber so a page-reload
	 *  during plan mode immediately re-renders the pill + any open card. */
	getReplayFrames(): PlanModeFrame[] {
		const out: PlanModeFrame[] = [];
		if (this.enabled) {
			out.push(this.#planModeChangedFrame());
		}
		const p = this.pendingApproval;
		if (p) {
			out.push({
				type: "plan_proposed",
				sessionId: this.sessionId,
				proposalId: p.proposalId,
				planFilePath: p.planFilePath,
				planContent: p.planContent,
				suggestedTitle: p.suggestedTitle,
				suggestedFinalPath: p.suggestedFinalPath,
			});
		}
		return out;
	}

	subscribeFrames(listener: FrameListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────

	/** Enter plan mode. Idempotent — re-entry is a no-op. */
	async enter(): Promise<void> {
		if (this.disposed || this.enabled) return;

		const previousTools = this.session.getActiveToolNames();
		const planTools = previousTools.includes(RESOLVE_TOOL)
			? previousTools
			: [...previousTools, RESOLVE_TOOL];
		await this.session.setActiveToolsByName(planTools);

		this.previousTools = previousTools;
		this.planFilePath = PLAN_FILE_URL;
		this.enabled = true;

		this.session.setPlanModeState({
			enabled: true,
			planFilePath: this.planFilePath,
			workflow: PLAN_WORKFLOW,
		});
		this.session.setStandingResolveHandler((input) => this.#handlePlanResolve(input));

		// Switch to the configured plan-role model (deferred if streaming). A
		// failure here MUST NOT break plan mode — #applyPlanModel swallows it.
		await this.#applyPlanModel();

		this.#broadcast(this.#planModeChangedFrame());
		log.info(`plan mode entered for ${this.sessionId}`);
	}

	/**
	 * Exit plan mode. Idempotent. Rejects any pending approval first so the
	 * standing handler unblocks with a clear error the agent can surface as
	 * the resolve tool's failure result.
	 *
	 * `reason` differentiates user-cancel (Shift+Tab off, Reject click) from
	 * server-side cleanup (session disposed, approve path that already did
	 * the rename + synthetic prompt).
	 */
	async exit(
		reason: "user_cancelled" | "session_disposed" | "approved" | "rejected" = "user_cancelled",
	): Promise<void> {
		if (this.disposed && reason !== "session_disposed") return;
		if (!this.enabled && !this.pendingApproval) return;

		if (this.pendingApproval) {
			const pending = this.pendingApproval;
			this.pendingApproval = undefined;
			if (reason === "user_cancelled" || reason === "session_disposed") {
				const message =
					reason === "user_cancelled"
						? "Plan approval cancelled: user exited plan mode."
						: "Plan approval abandoned: session disposed.";
				pending.reject(new Error(message));
				this.#broadcast({
					type: "plan_proposal_resolved",
					sessionId: this.sessionId,
					proposalId: pending.proposalId,
					outcome: reason === "user_cancelled" ? "rejected" : "expired",
				});
			}
		}

		if (this.enabled) {
			if (this.previousTools.length > 0) {
				try {
					await this.session.setActiveToolsByName(this.previousTools);
				} catch (err) {
					log.warn(`tool restore failed during exit for ${this.sessionId}`, err);
				}
			}
			this.session.setStandingResolveHandler(null);
			this.session.setPlanModeState(undefined);

			// Restore the persistent model (deferred if streaming). Best-effort:
			// a restore failure MUST NOT throw out of exit.
			await this.#restorePlanModel();

			this.enabled = false;
			this.previousTools = [];

			this.#broadcast(this.#planModeChangedFrame());
		}

		log.info(`plan mode exited for ${this.sessionId} (${reason})`);
	}

	/**
	 * Settle the pending approval. Returns `"unknown"` when the proposalId
	 * does not match the live pending entry (already-resolved by a sibling
	 * tab; the caller surfaces a 409 + the client rolls back optimistic UI).
	 */
	respond(proposalId: string, response: PlanApprovalResponse): "settled" | "unknown" {
		const pending = this.pendingApproval;
		if (!pending || pending.proposalId !== proposalId) {
			return "unknown";
		}
		// Do NOT clear pendingApproval here — the apply callback clears it
		// after the promise resolves so any concurrent respond() racing
		// with the resolve still sees "settled" until the callback exits.
		pending.resolve(response);
		return "settled";
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		// Fire-and-forget — dispose is sync; the SDK call chain in exit() is
		// best-effort during teardown.
		void this.exit("session_disposed");
		this.listeners.clear();
	}

	/**
	 * Apply a deferred model switch after the current stream ends. The host
	 * calls this on `agent_end`. Handles both the enter-time switch (session
	 * was streaming on enter) and the exit-time restore. Best-effort: a failure
	 * is logged and the pending switch dropped.
	 */
	async flushPendingModelSwitch(): Promise<void> {
		const controller = this.planModel;
		const pending = this.pendingModelSwitch;
		if (!controller || !pending) return;
		this.pendingModelSwitch = undefined;
		try {
			await controller.setModelTemporary(pending.model, pending.thinking);
		} catch (err) {
			log.warn(`deferred plan model switch failed for ${this.sessionId}`, err);
			if (!this.enabled) this.previousModelState = undefined;
			return;
		}
		if (this.enabled) {
			// Enter-time switch flushed: the plan model is now live.
			this.activeModelOverride = { model: pending.model, ...(pending.thinking ? { thinking: pending.thinking } : {}) };
			this.#broadcast(this.#planModeChangedFrame());
		} else {
			// Exit-time restore flushed: back on the persistent model.
			this.previousModelState = undefined;
		}
	}

	// ─── Internal ─────────────────────────────────────────────────────────

	#broadcast(frame: PlanModeFrame): void {
		for (const listener of this.listeners) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`plan-mode frame listener threw`, err);
			}
		}
	}

	/** Build the `plan_mode_changed` frame for the current state, including the
	 *  effective model override when one is applied/pending. */
	#planModeChangedFrame(): PlanModeChangedFrame {
		const override = this.#modelOverrideWire();
		return {
			type: "plan_mode_changed",
			sessionId: this.sessionId,
			enabled: this.enabled,
			...(this.enabled ? { planFilePath: this.planFilePath } : {}),
			...(override ? { modelOverride: override } : {}),
		};
	}

	/**
	 * On enter: switch to the configured plan-role model. No-op without a
	 * controller or config. Defers the switch when the session is streaming
	 * (flushed on the next `agent_end`). A failure is swallowed — a model-switch
	 * failure MUST NEVER break plan mode (T-30).
	 */
	async #applyPlanModel(): Promise<void> {
		const controller = this.planModel;
		if (!controller) return;
		const config = controller.getConfig();
		if (!config) return;
		const planRef: ModelRef = { provider: config.provider, id: config.id };
		const planThinking = config.thinking;
		const current = controller.currentModel();
		this.previousModelState = current ? { model: current, thinking: controller.currentThinking() } : undefined;

		const sameModel = current !== undefined && current.provider === planRef.provider && current.id === planRef.id;
		if (!sameModel) {
			if (controller.isStreaming()) {
				// Defer until the stream ends; keep previousModelState so the
				// snapshot keeps reporting the user's model, not the plan model.
				this.pendingModelSwitch = { model: planRef, ...(planThinking ? { thinking: planThinking } : {}) };
				return;
			}
			try {
				await controller.setModelTemporary(planRef, planThinking);
				this.activeModelOverride = { model: planRef, ...(planThinking ? { thinking: planThinking } : {}) };
			} catch (err) {
				log.warn(`plan model switch failed for ${this.sessionId}`, err);
				// Nothing applied — drop the snapshot so exit has nothing to restore.
				this.previousModelState = undefined;
			}
		} else if (planThinking) {
			// Same model, only thinking differs — avoid setModelTemporary (which
			// would reset provider sessions) and adjust the thinking level only.
			try {
				controller.setThinkingLevel(planThinking);
				this.activeModelOverride = { model: planRef, thinking: planThinking };
			} catch (err) {
				log.warn(`plan thinking switch failed for ${this.sessionId}`, err);
				this.previousModelState = undefined;
			}
		} else {
			// Same model, no thinking override — nothing to change or restore.
			this.previousModelState = undefined;
		}
	}

	/**
	 * On exit: restore the persistent model captured on enter. Idempotent — a
	 * repeat call after previousModelState is cleared is a no-op. Defers the
	 * restore when streaming (flushed on the next `agent_end`). Best-effort:
	 * failures are logged, never thrown.
	 */
	async #restorePlanModel(): Promise<void> {
		const controller = this.planModel;
		// Drop any un-flushed enter switch — we're leaving plan mode, so flushing
		// it later would strand the session on the plan model (SDK issue #816).
		this.pendingModelSwitch = undefined;
		this.activeModelOverride = undefined;
		const prev = this.previousModelState;
		if (!controller || !prev) {
			this.previousModelState = undefined;
			return;
		}
		const current = controller.currentModel();
		if (current === undefined || (current.provider === prev.model.provider && current.id === prev.model.id)) {
			// Model is already persistent (never switched, or same-model
			// thinking-only override) — restore only the thinking level.
			try {
				controller.setThinkingLevel(prev.thinking);
			} catch (err) {
				log.warn(`plan thinking restore failed for ${this.sessionId}`, err);
			}
			this.previousModelState = undefined;
			return;
		}
		if (controller.isStreaming()) {
			// Defer the restore; keep previousModelState so the snapshot keeps
			// showing the user's model until flushPendingModelSwitch applies it.
			this.pendingModelSwitch = { model: prev.model, ...(prev.thinking ? { thinking: prev.thinking } : {}) };
			return;
		}
		try {
			await controller.setModelTemporary(prev.model, prev.thinking);
		} catch (err) {
			log.warn(`plan model restore failed for ${this.sessionId}`, err);
		}
		this.previousModelState = undefined;
	}

	/**
	 * Standing resolve handler. The SDK calls this when the agent submits
	 * `resolve { action: "apply" | "discard", ... }` while plan-mode is
	 * active. We use the SDK's own `runResolveInvocation` to validate the
	 * envelope (handles `action="discard"` and grammar-constrained input
	 * shapes) and shape the result as `AgentToolResult<ResolveToolDetails>`.
	 *
	 * The `apply` callback blocks on the user's `plan_response` reply.
	 * Returning from it ends the agent's resolve tool with the supplied
	 * content + details; the deferred `session.prompt(..., followUp)` then
	 * starts a fresh turn that executes the approved plan.
	 */
	#handlePlanResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				if (!this.enabled) {
					throw new ToolError("Plan mode is not active.");
				}

				const planContent = await this.#readPlanFile(this.planFilePath);
				if (planContent === null) {
					throw new ToolError(
						`Plan file not found at ${this.planFilePath}. Write the finalized plan before requesting approval.`,
					);
				}

				const normalized = resolvePlanTitle({
					suppliedTitle: extra?.title,
					planContent,
					planFilePath: this.planFilePath,
				});
				const suggestedFinalPath = `local://${normalized.fileName}`;
				const proposalId = this.#allocateProposalId();

				// Block on user approval. Stash the proposal so reconnects can
				// replay it and a parallel `set_plan_mode(false)` can reject it.
				const userResponse = await new Promise<PlanApprovalResponse>((resolve, reject) => {
					this.pendingApproval = {
						proposalId,
						planFilePath: this.planFilePath,
						planContent,
						suggestedTitle: normalized.title,
						suggestedFinalPath,
						resolve,
						reject,
					};
					this.#broadcast({
						type: "plan_proposed",
						sessionId: this.sessionId,
						proposalId,
						planFilePath: this.planFilePath,
						planContent,
						suggestedTitle: normalized.title,
						suggestedFinalPath,
					});
				});

				// Clear pending — anything after this point is post-decision.
				this.pendingApproval = undefined;

				const planFilePathAtApproval = this.planFilePath;

				if (!userResponse.approved) {
					this.#broadcast({
						type: "plan_proposal_resolved",
						sessionId: this.sessionId,
						proposalId,
						outcome: "rejected",
					});
					await this.exit("rejected");
					return {
						content: [
							{
								type: "text" as const,
								text: "User rejected the plan. Plan mode disabled; do not auto-execute.",
							},
						],
						details: {
							planFilePath: planFilePathAtApproval,
							title: normalized.title,
							planExists: true,
						} satisfies PlanApprovalDetails,
					};
				}

				// Approve path: optionally write edited content, exit plan
				// mode, queue the synthetic approved-prompt for the next turn.
				// The SDK no longer renames plan files on approval —
				// planFilePath is stable throughout the session.
				let finalContent = planContent;
				if (typeof userResponse.editedContent === "string") {
					await this.#writePlanFile(planFilePathAtApproval, userResponse.editedContent);
					finalContent = userResponse.editedContent;
				}

				this.#broadcast({
					type: "plan_proposal_resolved",
					sessionId: this.sessionId,
					proposalId,
					outcome: "approved",
				});

				await this.exit("approved");

				this.session.markPlanReferenceSent();
				const approvedPrompt = renderApprovedPrompt({
					planContent: finalContent,
					planFilePath: planFilePathAtApproval,
				});

				// Fire-and-forget: the resolve tool is still streaming at
				// this point (we haven't returned yet), so the SDK queues
				// the prompt as followUp and fires it once the current
				// turn ends. The `synthetic` flag is intentionally absent
				// — the SDK's queue path doesn't preserve it; we accept
				// the resulting user-role bubble so the user sees a
				// visible "execute" handoff. v1.1 may swap to a deferred
				// turn_end listener if the synthetic distinction matters.
				void this.session
					.prompt(approvedPrompt, { streamingBehavior: "followUp" })
					.catch((err) => {
						log.warn(`synthetic approved-plan prompt failed for ${this.sessionId}`, err);
					});

				return {
					content: [
						{
							type: "text" as const,
							text: `Plan approved. Executing from ${planFilePathAtApproval}.`,
						},
					],
					details: {
						planFilePath: planFilePathAtApproval,
						title: stripMdExtension(extractFileName(planFilePathAtApproval)),
						planExists: true,
					} satisfies PlanApprovalDetails,
				};
			},
		});
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const fsPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: this.getArtifactsDir,
			getSessionId: this.getSessionId,
		});
		try {
			return await fs.readFile(fsPath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	async #writePlanFile(planFilePath: string, content: string): Promise<void> {
		const fsPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: this.getArtifactsDir,
			getSessionId: this.getSessionId,
		});
		await fs.writeFile(fsPath, content, "utf-8");
	}

	#allocateProposalId(): string {
		const id = `pa_${this.sessionId}_${this.nextProposalCounter}`;
		this.nextProposalCounter += 1;
		return id;
	}
}

function renderApprovedPrompt(args: { planContent: string; planFilePath: string }): string {
	return PLAN_APPROVED_PROMPT_TEMPLATE.replaceAll(
		"{{planContent}}",
		args.planContent,
	).replaceAll("{{planFilePath}}", args.planFilePath);
}

/**
 * Validate a client-supplied override of the final plan path. Returns
 * `undefined` when the input is missing or shaped wrong; the caller falls
 * back to the SDK-suggested path. We deliberately don't throw — a malformed
 * `finalPath` shouldn't fail the whole approval; falling back to the
 * suggested path is the user-friendly default.
 */
function sanitizeFinalPath(input: string | undefined): string | undefined {
	if (!input) return undefined;
	const trimmed = input.trim();
	if (!trimmed.startsWith("local://")) return undefined;
	// Strip the scheme and reject anything that has path separators or `..`
	// anywhere — must be a single safe filename, NOT a nested path or
	// traversal attempt. (Stripping then taking the basename would silently
	// "sanitize" `local://../escape.md` into `escape.md`; reject instead.)
	const remainder = trimmed.replace(/^local:\/+/, "");
	if (remainder.includes("/") || remainder.includes("\\")) return undefined;
	if (remainder.includes("..")) return undefined;
	if (!remainder.endsWith(".md")) return undefined;
	const stem = remainder.slice(0, -".md".length);
	if (stem.length === 0) return undefined;
	if (!/^[A-Za-z0-9_-]+$/.test(stem)) return undefined;
	return `local://${remainder}`;
}

function extractFileName(localUrl: string): string {
	return localUrl.replace(/^local:\/+/, "").split(/[\\/]/).pop() ?? "";
}

function stripMdExtension(fileName: string): string {
	return fileName.replace(/\.md$/i, "");
}
