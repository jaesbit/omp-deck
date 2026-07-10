import { useEffect, useState } from "react";
import type { AdvisorSettingsResponse } from "@omp-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { api } from "@/lib/api";

/** Global OMP advisor control. Changes are read when a new session starts. */
export function AdvisorsSection() {
	const [settings, setSettings] = useState<AdvisorSettingsResponse | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void api
			.getAdvisorSettings()
			.then((response) => {
				if (!cancelled) setSettings(response);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function setEnabled(enabled: boolean): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			setSettings(await api.setAdvisorEnabled(enabled));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	if (!settings && !error) return <div className="text-sm text-ink-3">Loading advisor settings…</div>;
	if (!settings) return <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</div>;

	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Advisors</h1>
				<p className="mt-1 max-w-2xl text-sm text-ink-3">
					A second OMP model passively reviews each main-agent turn and can inject notes when it finds a concern.
				</p>
			</div>
			{error ? <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</div> : null}
			<div className="rounded-lg border border-line bg-paper p-4">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="text-sm font-medium">Enable advisors</h2>
							{!settings.configured ? <Badge tone="muted">default</Badge> : null}
						</div>
						<p className="mt-1 max-w-xl text-xs text-ink-3">
							Enabled by default. Your choice is stored in OMP&apos;s global configuration and applies when a new session starts.
						</p>
					</div>
					<input
						type="checkbox"
						aria-label="Enable advisors"
						checked={settings.enabled}
						disabled={saving}
						onChange={(event) => void setEnabled(event.target.checked)}
						className="h-4 w-4 accent-ink disabled:opacity-50"
					/>
				</div>
			</div>
			<div className="border-t border-line pt-3 text-xs text-ink-3">
				Advisor rosters and instructions remain OMP-managed through <span className="font-mono text-2xs text-ink-2">WATCHDOG.yml</span>.
			</div>
		</div>
	);
}
