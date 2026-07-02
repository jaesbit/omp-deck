import type { ModelRef } from "@omp-deck/protocol";

/**
 * Explicit session-initialisation command for a launch that also carries a
 * user/context prompt. This is deliberately not coupled to
 * `OMP_DECK_AUTO_START`: a user may leave the global automatic start disabled
 * yet still expect an intentional Task/Inbox/initial-prompt launch to run the
 * canonical `/start` orientation exactly once.
 */
export const SESSION_INITIALISATION_COMMAND = "/start";

/**
 * Combine the deck's auto-start command with a follow-up message into ONE
 * turn instead of two. Previously, opening a session with a contextual draft
 * (a task attach, an inbox item, a custom initial prompt) fired `/start` as
 * its own turn via the server's auto-start mechanism, then queued the draft
 * as a second turn once the user sent it — `/start -> response -> attach`.
 *
 * The SDK's own `AgentSession.prompt()` already expands `/<command> <rest>`
 * as `<rendered template>\n\n<rest>` when the template doesn't declare
 * `$ARGUMENTS`/`{{args}}` placeholders (see `expandSlashCommand` +
 * `appendInlineArgsFallback` in `@oh-my-pi/pi-coding-agent`). So prefixing the
 * autostart command onto the message and sending it as a single prompt makes
 * the SDK do the combining for us — no server-side changes needed.
 *
 * Callers MUST also pass `suppressAutoStart: true` to `createSession` when
 * using this, otherwise the server still fires the bare autostart command as
 * its own separate first turn in addition to this combined one.
 */
export function combineWithAutoStart(autoStart: string | null, message: string): string {
	const trimmedMessage = message.trim();
	if (!autoStart || !trimmedMessage) return trimmedMessage;
	return `${autoStart} ${trimmedMessage}`;
}
/**
 * Shared "create session, optionally seed an initial prompt" flow used by
 * every plain "New session" launch site (SessionPicker, Sidebar, ChatHeader).
 * When `opts.initialPrompt` is set, the server's own auto-start is suppressed
 * and the initialisation command plus prompt are auto-sent as one turn (see
 * `combineWithAutoStart`). The user does not need to press Send a second time.
 */
export async function launchSession(
	createSession: (opts: {
		cwd: string;
		model?: ModelRef;
		planMode?: boolean;
		suppressAutoStart?: boolean;
	}) => Promise<string>,
	setPendingDraft: (draft: { text: string; sessionId?: string; autoSend?: boolean } | undefined) => void,
	opts: { cwd: string; model?: ModelRef; planMode: boolean; initialPrompt?: string },
): Promise<string> {
	const suppressAutoStart = Boolean(opts.initialPrompt);
	const sessionId = await createSession({
		cwd: opts.cwd,
		model: opts.model,
		planMode: opts.planMode,
		suppressAutoStart,
	});
	if (opts.initialPrompt) {
		setPendingDraft({
			text: combineWithAutoStart(SESSION_INITIALISATION_COMMAND, opts.initialPrompt),
			sessionId,
			autoSend: true,
		});
	}
	return sessionId;
}
