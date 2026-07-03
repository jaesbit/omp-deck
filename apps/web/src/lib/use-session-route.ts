import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useStore } from "./store";

/**
 * Keeps the active chat session and the browser URL (`/c/:sessionId`) in
 * sync in both directions (T-52 — reconnect to a running session from any
 * tab/browser):
 *
 * - URL -> store: once the WS client comes up, adopt whatever session id is
 *   in the route (or, on a bare `/`, the last-active id restored from
 *   localStorage into initial store state — see `readLastSessionId` in
 *   `store.ts`) and subscribe to it. Also re-adopts on a browser
 *   back/forward navigation between two `/c/:id` URLs. `selectSession` is
 *   idempotent (it no-ops a repeat `subscribe` for an id already in the
 *   `subscribed` set), so calling it on every relevant render is safe. If
 *   the session isn't actually running in this server process (idle-reaped,
 *   or the server restarted), the store's `error` handler transparently
 *   resumes it from disk — see `resumeIfKnown` in `store.ts`.
 * - store -> URL: any other change to the active session (sidebar click,
 *   new session, the auto-resume above, `session_disposed` clearing it) is
 *   mirrored into the address bar, so reloading the tab, using "reopen
 *   closed tab", or pasting the URL into a second browser reconnects to the
 *   same session instead of landing on the empty picker.
 *
 * `adoptedRouteRef` gates the store -> URL effect until the URL -> store
 * effect has run at least once. Without it, a fresh mount whose store
 * already has a *different* `activeId` (restored from localStorage) would
 * have the mirror effect immediately overwrite whatever session id is in
 * the URL — clobbering a legitimate `/c/:id` deep link, or an invalid one
 * mid-resume-attempt, before the adopt effect ever got a chance to run
 * (that effect additionally waits on `wsReady`, so it can lag a render or
 * two behind the mirror effect if nothing gates it).
 *
 * Both effects compare against `useStore.getState()`, not the hook's own
 * reactive `activeId` value: effects run in declaration order within one
 * commit, but React doesn't re-render between them, so the second effect's
 * captured `activeId` prop can still be one render behind a `set()` the
 * first effect just made in the same flush.
 */
export function useSessionRoute(): void {
	const { sessionId: routeId } = useParams<{ sessionId?: string }>();
	const navigate = useNavigate();
	const wsReady = useStore((s) => s.ws !== null);
	const activeId = useStore((s) => s.activeId);
	const adoptedRouteRef = useRef(false);

	useEffect(() => {
		if (!wsReady) return;
		const target = routeId ?? useStore.getState().activeId;
		adoptedRouteRef.current = true;
		if (!target) return;
		useStore.getState().selectSession(target);
	}, [routeId, wsReady]);

	useEffect(() => {
		if (!adoptedRouteRef.current) return;
		const current = useStore.getState().activeId;
		if (current === routeId) return;
		navigate(current ? `/c/${current}` : "/", { replace: true });
		// `wsReady` is listed so this effect gets one more pass in the same
		// commit as the adopt effect above when it flips true — without it, a
		// bare "/" whose `activeId` was already correct from the localStorage-
		// seeded initial state (so the value never actually "changes") would
		// never re-run this effect at all, since neither `activeId` nor
		// `routeId` change in that case, and only the adopt effect's own ref
		// mutation (invisible to React) flips in between.
	}, [activeId, routeId, wsReady, navigate]);
}
