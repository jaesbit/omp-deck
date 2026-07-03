/**
 * Banner that surfaces the OS-notification permission prompt the first time
 * a notification arrives in a session where permission is `default` and the
 * user hasn't already dismissed the banner.
 *
 * Two-state UI:
 *   - "Enable notifications" + Dismiss   (default permission)
 *   - "Notifications blocked"            (permission denied; instructs how
 *      to re-enable in browser settings)
 *
 * Banner stays mounted but renders nothing when:
 *   - Permission is `granted` (everything works silently)
 *   - User has explicitly dismissed it (localStorage flag)
 *   - No notifications have arrived this session yet (no need to pitch)
 *   - Browser doesn't support `Notification` (degrade silently to toasts)
 */

import type { JSX } from "react";
import { useStore } from "../lib/store";
import { useNotificationPermission } from "../lib/notifications";

export function NotificationPermissionBanner(): JSX.Element | null {
	const { permission, requestPermission, bannerDismissed, dismissBanner } = useNotificationPermission();
	const hasReceivedAny = useStore((s) => s.notifications.length > 0);

	if (permission === "unsupported") return null;
	if (permission === "granted") return null;
	if (bannerDismissed) return null;
	if (!hasReceivedAny) return null;

	if (permission === "denied") {
		return (
			<div className="flex items-center justify-between gap-3 border-b border-rose-900/40 bg-rose-950/60 px-4 py-2 text-sm text-rose-200">
				<span>
					OS notifications are blocked. In-app toasts will still appear. To re-enable, open browser
					settings &rarr; Site permissions &rarr; Notifications and allow this origin.
				</span>
				<button
					type="button"
					onClick={dismissBanner}
					className="rounded-md px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-900/40"
				>
					Dismiss
				</button>
			</div>
		);
	}

	return (
		<div className="flex items-center justify-between gap-3 border-b border-amber-900/40 bg-amber-950/40 px-4 py-2 text-sm text-amber-100">
			<span>
				Enable browser notifications so the deck can ping you when a routine fails or needs attention.
			</span>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => void requestPermission()}
					className="rounded-md bg-amber-500/20 px-2.5 py-1 text-xs font-medium text-amber-50 hover:bg-amber-500/30"
				>
					Enable notifications
				</button>
				<button
					type="button"
					onClick={dismissBanner}
					className="rounded-md px-2 py-0.5 text-xs text-amber-300 hover:bg-amber-900/40"
				>
					Not now
				</button>
			</div>
		</div>
	);
}
