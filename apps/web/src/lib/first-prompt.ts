import type { ModelRef } from "@omp-deck/protocol";

/**
 * Shared "create session, optionally seed an initial prompt" flow used by
 * every plain "New session" launch site (SessionPicker, Sidebar, ChatHeader).
 * When `opts.initialPrompt` is set, it is sent directly as the first turn.
 * The user does not need to press Send a second time.
 */
export async function launchSession(
	createSession: (opts: {
		cwd: string;
		model?: ModelRef;
		planMode?: boolean;
		thinking?: string;
	}) => Promise<string>,
	setPendingDraft: (draft: { text: string; sessionId?: string; autoSend?: boolean } | undefined) => void,
	opts: { cwd: string; model?: ModelRef; planMode: boolean; initialPrompt?: string; thinking?: string },
): Promise<string> {
	const sessionId = await createSession({
		cwd: opts.cwd,
		model: opts.model,
		planMode: opts.planMode,
		...(opts.thinking ? { thinking: opts.thinking } : {}),
	});
	if (opts.initialPrompt) {
		setPendingDraft({
			text: opts.initialPrompt,
			sessionId,
			autoSend: true,
		});
	}
	return sessionId;
}
