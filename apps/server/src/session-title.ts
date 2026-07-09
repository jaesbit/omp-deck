/**
 * Server-side session-title generation (T-78).
 *
 * omp-deck's in-process bridge talks to the SDK's `AgentSession`/`SessionManager`
 * directly, bypassing the `omp` CLI's own "input controller" — which is where the
 * SDK's native auto-title generator normally lives (see the comment on
 * `InProcessSessionHandle.setName` in `bridge/in-process.ts`). That generator never
 * fires for deck-driven sessions, so without this module the only titling
 * mechanism is the agent's own self-titling instruction in the user's
 * `~/.omp/agent/commands/start.md`, which only runs after the agent has already
 * done a turn of work — never "first".
 *
 * This is a short-lived, disposable session (same minimal pattern as
 * `rewriteTask` in `routes.ts` and `generateBranchSlugWithModel` in
 * `auto-work/engine.ts`): create with `systemPromptOverride`, prompt, wait for
 * terminal, extract text, delete. Gated entirely behind the `internalTaskModel`
 * setting (`db/server-settings.ts`) — `null` (the default) means this is a no-op,
 * so an unconfigured install behaves exactly as before.
 */

import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import { getInternalTaskModel } from "./db/server-settings.ts";
import { getTask } from "./db/tasks.ts";
import { waitForAutoWorkSessionTerminal } from "./auto-work/engine.ts";
import { extractLatestAssistantText } from "./routes.ts";
import { logger } from "./log.ts";

const log = logger("session-title");

const TITLE_SYSTEM_PROMPT = [
	"You generate short, specific titles for coding-agent chat sessions.",
	"You will be given the session's first user message, and optionally the",
	"kanban task it was started from. Reply with ONLY the title text — no",
	"quotes, no markdown, no explanation, no trailing period.",
	"",
	"Rules:",
	'- Max 8 words. Specific to the actual topic, never generic ("Chat", "Session", "Help").',
	'- If a linked kanban task is given, the title MUST start with "T-<id>: ".',
	"- Otherwise just the topic, in the same language as the first message.",
].join("\n");

/** Internal task ids look like `t_01kx1s8fxrt7ss33k4` — the convention used by
 *  the "Open in chat" / "Assign to agent" flows embeds one in the prompt
 *  (e.g. `GET /api/tasks/t_01kx1s8fxrt7ss33k4`). Best-effort context signal —
 *  when absent, title generation just proceeds without task context. */
const TASK_ID_PATTERN = /\bt_[a-z0-9]{18}\b/;

/**
 * Generates a title for a brand-new session from its first user message.
 * Returns `undefined` when the feature is off, the model call fails, or the
 * model returns nothing usable — callers should leave the session untitled
 * rather than fall back to a placeholder (the agent-side heuristic in
 * `start.md` still covers untitled sessions when this is disabled).
 */
export async function generateSessionTitle(
	bridge: AgentBridge,
	opts: { cwd: string; firstMessage: string },
): Promise<string | undefined> {
	const model = getInternalTaskModel();
	if (!model) return undefined;

	const taskIdMatch = TASK_ID_PATTERN.exec(opts.firstMessage);
	const task = taskIdMatch ? getTask(taskIdMatch[0]) : undefined;
	const taskContext = task ? `\nLinked kanban task: T-${task.displayId}: ${task.title}\n${task.body ?? ""}` : "";

	const prompt = [
		`First user message:\n${opts.firstMessage}`,
		taskContext,
	].filter(Boolean).join("\n");

	let session: SessionHandle | undefined;
	try {
		session = await bridge.createSession({
			cwd: opts.cwd,
			suppressAutoStart: true,
			systemPromptOverride: TITLE_SYSTEM_PROMPT,
			model,
		});
		const terminal = waitForAutoWorkSessionTerminal(session, 30_000);
		await session.prompt(prompt);
		const outcome = await terminal;
		if (outcome !== "completed") {
			log.warn(`session-title generation ${outcome}`);
			return undefined;
		}
		const snapshot = await session.snapshot();
		const text = extractLatestAssistantText(snapshot.messages);
		return sanitizeTitle(text) || undefined;
	} catch (err) {
		log.warn("session-title generation failed", err);
		return undefined;
	} finally {
		if (session) {
			bridge.deleteSession(session.sessionId).catch((err) => {
				log.warn("session-title cleanup failed", err);
			});
		}
	}
}

/** First line, strip wrapping quotes/backticks the model sometimes adds, cap length. */
function sanitizeTitle(text: string): string {
	const firstLine = text.trim().split("\n")[0] ?? "";
	return firstLine.replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, 100);
}
