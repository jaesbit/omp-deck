import { useEffect } from "react";
import { AppRouter } from "./router";
import { selectActiveSession, useStore } from "./lib/store";
import { useNotificationBridge } from "./lib/notifications";
import { NotificationToast } from "./components/NotificationToast";
import { NotificationPermissionBanner } from "./components/NotificationPermissionBanner";

export function App() {
	const bootstrap = useStore((s) => s.bootstrap);
	useNotificationBridge();
	useGlobalAbortShortcut();

	useEffect(() => {
		void bootstrap();
	}, [bootstrap]);

	return (
		<>
			<NotificationPermissionBanner />
			<AppRouter />
			<NotificationToast />
		</>
	);
}

/**
 * Window-level Ctrl/Cmd + a configurable key → abort the active session if
 * it's mid-turn. Bound at the App level so the shortcut works from any view
 * (composer, kanban, KB) without the user having to focus the Stop button
 * the composer renders.
 *
 * The key defaults to `/` (see `DEFAULT_ABORT_SHORTCUT_KEY`) but is
 * user-configurable in Settings → Appearance — the original `.` (ChatGPT /
 * VS Code's "stop generating" convention) collides with fcitx5's built-in
 * emoji-picker trigger on some setups, which intercepts the key before the
 * browser ever sees it, and there's no way to know every IME's bindings in
 * advance.
 *
 * Ignored while the user is composing text in a contenteditable surface
 * EXCEPT when the active session is actually busy — pressing it during a
 * long-running turn is exactly the case we want to support, and the
 * composer textarea is the most likely place to be when you decide to
 * stop.
 */
function useGlobalAbortShortcut(): void {
	const abort = useStore((s) => s.abort);
	const status = useStore((s) => selectActiveSession(s)?.status);
	const shortcutKey = useStore((s) => s.abortShortcutKey);
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			const isStop =
				(e.ctrlKey || e.metaKey) &&
				!e.shiftKey &&
				!e.altKey &&
				e.key.toLowerCase() === shortcutKey.toLowerCase();
			if (!isStop) return;
			if (status !== "streaming" && status !== "retrying") return;
			e.preventDefault();
			abort();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [abort, status, shortcutKey]);
}
