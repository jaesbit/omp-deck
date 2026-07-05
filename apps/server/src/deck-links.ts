/**
 * Deep-link URL builder for the deck (T-61).
 *
 * `buildSessionUrl` is a small, dependency-free helper so the auto-work
 * completion flow (T-66) can import it without pulling in the DB layer —
 * it just needs a resolved `deckBaseUrl` (see `db/server-settings.ts`'s
 * `getDeckBaseUrl`) and a session id.
 *
 * The path is `/c/:sessionId` (see `apps/web/src/router.tsx` and
 * `use-session-route.ts`), NOT `/sessions/:id` — the ticket's example URL
 * used the latter, but that route doesn't exist in the web app and would
 * 404. Using the real route is required for the "link navigates to the
 * correct session" acceptance criterion.
 */

/** Joins `deckBaseUrl` and `sessionId` into `${deckBaseUrl}/c/${sessionId}`, tolerating a trailing slash on the base. */
export function buildSessionUrl(deckBaseUrl: string, sessionId: string): string {
	const base = deckBaseUrl.replace(/\/+$/, "");
	return `${base}/c/${encodeURIComponent(sessionId)}`;
}
