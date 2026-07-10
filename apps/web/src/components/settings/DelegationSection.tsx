import { useEffect, useState } from "react";
import type { DelegationSettingEntry, DelegationSettingKey, GetDelegationSettingsResponse } from "@omp-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { api } from "@/lib/api";

const SUBAGENT_KEYS = new Set<DelegationSettingKey>([
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.maxRuntimeMs",
]);

export function DelegationSection() {
	const [data, setData] = useState<GetDelegationSettingsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [savingKey, setSavingKey] = useState<DelegationSettingKey | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void api
			.getDelegationSettings()
			.then((response) => {
				if (!cancelled) setData(response);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function update(entry: DelegationSettingEntry, value: number | string | boolean): Promise<void> {
		setSavingKey(entry.key);
		setError(null);
		try {
			setData(await api.patchDelegationSettings({ updates: { [entry.key]: value } }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingKey(null);
		}
	}

	if (loading) return <div className="text-sm text-ink-3">Loading delegation settings…</div>;
	if (!data) {
		return <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error ?? "Delegation settings are unavailable."}</div>;
	}

	const subagents = data.settings.filter((entry) => SUBAGENT_KEYS.has(entry.key));
	const isolation = data.settings.filter((entry) => !SUBAGENT_KEYS.has(entry.key));
	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Delegation</h1>
				<p className="mt-1 text-sm text-ink-3">Control parallel subagents, their limits, and how isolated changes are integrated.</p>
			</div>
			{error ? <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</div> : null}
			<SettingGroup title="Subagents" entries={subagents} savingKey={savingKey} onUpdate={update} />
			<SettingGroup title="Isolation" entries={isolation} savingKey={savingKey} onUpdate={update} />
			<div className="border-t border-line pt-3 text-xs text-ink-3">
				Source of truth: OMP settings — <span className="font-mono text-2xs text-ink-2">{data.configPath}</span>. Changes persist to the agent&apos;s own config and apply to the next task call, including live sessions.
			</div>
		</div>
	);
}

function SettingGroup({
	title,
	entries,
	savingKey,
	onUpdate,
}: {
	title: string;
	entries: DelegationSettingEntry[];
	savingKey: DelegationSettingKey | null;
	onUpdate: (entry: DelegationSettingEntry, value: number | string | boolean) => Promise<void>;
}) {
	return (
		<div className="overflow-hidden rounded-lg border border-line bg-paper">
			<div className="border-b border-line bg-paper-2/50 px-4 py-2">
				<h2 className="font-mono text-xs font-medium uppercase tracking-meta text-ink-2">{title}</h2>
			</div>
			<div className="divide-y divide-line">
				{entries.map((entry) => (
					<div key={entry.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<div className="text-sm font-medium text-ink">{entry.label}</div>
								{!entry.configured ? <Badge tone="muted">default</Badge> : null}
							</div>
							<div className="mt-1 max-w-xl text-xs text-ink-3">{entry.description}</div>
						</div>
						<SettingControl entry={entry} disabled={savingKey !== null} onUpdate={onUpdate} />
					</div>
				))}
			</div>
		</div>
	);
}

function SettingControl({
	entry,
	disabled,
	onUpdate,
}: {
	entry: DelegationSettingEntry;
	disabled: boolean;
	onUpdate: (entry: DelegationSettingEntry, value: number | string | boolean) => Promise<void>;
}) {
	if (entry.type === "boolean") {
		return (
			<input
				type="checkbox"
				checked={Boolean(entry.value)}
				disabled={disabled}
				onChange={(event) => void onUpdate(entry, event.target.checked)}
				className="h-4 w-4 accent-ink disabled:opacity-50"
			/>
		);
	}
	if (entry.options?.length) {
		const value = String(entry.value);
		const hasCurrent = entry.options.some((option) => option.value === value);
		return (
			<select
				value={value}
				disabled={disabled}
				onChange={(event) => void onUpdate(entry, entry.type === "number" ? Number(event.target.value) : event.target.value)}
				className="h-8 min-w-44 rounded-md border border-line bg-paper-2 px-2 text-sm text-ink outline-none focus:border-ink disabled:opacity-50"
			>
				{!hasCurrent ? <option value={value}>{value}</option> : null}
				{entry.options.map((option) => (
					<option key={option.value} value={option.value} title={option.description}>
						{option.label}
					</option>
				))}
			</select>
		);
	}
	return (
		<input
			type="number"
			defaultValue={String(entry.value)}
			disabled={disabled}
			onBlur={(event) => {
				const value = Number(event.target.value);
				if (Number.isFinite(value) && value !== entry.value) void onUpdate(entry, value);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}}
			className="h-8 w-32 rounded-md border border-line bg-paper-2 px-2 text-sm text-ink outline-none focus:border-ink disabled:opacity-50"
		/>
	);
}
