import type { ModelRef } from "@omp-deck/protocol";
import { settingsApi } from "./settings-api";

/**
 * Reads the deck's currently configured auto-start slash command
 * (`OMP_DECK_AUTO_START`, e.g. `/start`). Returns `null` when unset/disabled
 * — auto-start is opt-in and off by default on a fresh install.
 *
 * Fetched fresh on every call (settings changes are rare and this only runs
 * at session-launch time, not a hot path) rather than cached, so a mid-session
 * env change in another tab is picked up immediately.
 */
export async function getAutoStartCommand(): Promise<string | null> {
	try {
		const resp = await settingsApi.listEnv();
		const entry = resp.entries.find((e) => e.key === "OMP_DECK_AUTO_START");
		if (!entry || !entry.isSet) return null;
		const trimmed = entry.masked.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		// Best-effort — a settings-fetch hiccup should degrade to "no autostart"
		// (message sent as-is) rather than block session launch entirely.
		return null;
	}
}

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
 * and the composer is pre-filled with the autostart command combined with
 * the prompt instead (see `combineWithAutoStart`) — never sent automatically.
 */
export async function launchSession(
	createSession: (opts: {
		cwd: string;
		model?: ModelRef;
		planMode?: boolean;
		suppressAutoStart?: boolean;
	}) => Promise<string>,
	setPendingDraft: (draft: { text: string } | undefined) => void,
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
		const autoStart = await getAutoStartCommand();
		setPendingDraft({ text: combineWithAutoStart(autoStart, opts.initialPrompt) });
	}
	return sessionId;
}
