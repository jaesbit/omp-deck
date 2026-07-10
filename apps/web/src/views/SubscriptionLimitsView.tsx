import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertCircle, FolderGit2, RefreshCw } from "lucide-react";
import type { SpendSummaryResponse, SubscriptionUsageResponse } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { api } from "@/lib/api";
import { cn, formatCost } from "@/lib/utils";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";

type SpendGranularity = "day" | "week" | "month";

const GRANULARITY_LABEL: Record<SpendGranularity, string> = {
	day: "Today",
	week: "This week",
	month: "This month",
};

/**
 * Dedicated view for the provider subscription windows used by Auto Work,
 * plus per-account (workspace) spend aggregated from session cost reports
 * (T-98). "Account" maps to a workspace `cwd` — the deck has no separate
 * account/tenant concept.
 */
export function SubscriptionLimitsView() {
	const [usage, setUsage] = useState<SubscriptionUsageResponse | null>(null);
	const [usageError, setUsageError] = useState<string | undefined>();
	const [spend, setSpend] = useState<SpendSummaryResponse | null>(null);
	const [spendError, setSpendError] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [granularity, setGranularity] = usePersistedViewState<SpendGranularity>("subscriptions.spendGranularity", "day");

	const refresh = useCallback(async (): Promise<void> => {
		setLoading(true);
		const [usageResult, spendResult] = await Promise.allSettled([api.getSubscriptionUsage(), api.getAccountSpendSummary()]);
		if (usageResult.status === "fulfilled") {
			setUsage(usageResult.value);
			setUsageError(undefined);
		} else {
			setUsageError(usageResult.reason instanceof Error ? usageResult.reason.message : String(usageResult.reason));
		}
		if (spendResult.status === "fulfilled") {
			setSpend(spendResult.value);
			setSpendError(undefined);
		} else {
			setSpendError(spendResult.reason instanceof Error ? spendResult.reason.message : String(spendResult.reason));
		}
		setLoading(false);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<Layout
			sidebar={<Sidebar />}
			main={
				<div className="flex h-full min-h-0 flex-col overflow-hidden">
					<header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-paper px-3">
						<div>
							<h1 className="text-sm font-semibold text-ink">Subscription limits</h1>
							<p className="text-2xs text-ink-3">Provider usage windows, reset times, and per-account spend</p>
						</div>
						<button
							type="button"
							onClick={() => void refresh()}
							disabled={loading}
							className="btn-ghost inline-flex h-7 items-center gap-1.5 px-2 text-xs"
							title="Refresh subscription limits"
						>
							<RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
							Refresh
						</button>
					</header>
					<div className="flex-1 overflow-y-auto p-4">
						<div className="mx-auto max-w-3xl space-y-6">
							<AccountSpendSection
								spend={spend}
								loading={loading}
								error={spendError}
								granularity={granularity}
								onGranularityChange={setGranularity}
							/>
							<SubscriptionLimitsContent usage={usage} loading={loading} error={usageError} onRetry={refresh} />
						</div>
					</div>
				</div>
			}
			inspector={null}
			topBar={null}
		/>
	);
}

/** Per-account spend table with an instant day/week/month toggle — all three
 *  bucket totals arrive in one fetch, so switching granularity never refetches. */
function AccountSpendSection({
	spend,
	loading,
	error,
	granularity,
	onGranularityChange,
}: {
	spend: SpendSummaryResponse | null;
	loading: boolean;
	error: string | undefined;
	granularity: SpendGranularity;
	onGranularityChange: (next: SpendGranularity) => void;
}) {
	return (
		<section className="rounded-md border border-line bg-paper-2 p-4">
			<div className="mb-3 flex items-center justify-between gap-3">
				<div>
					<h2 className="text-sm font-medium text-ink">Spend by account</h2>
					<p className="text-2xs text-ink-3">
						{GRANULARITY_LABEL[granularity]} · session-reported cost, UTC calendar {granularity}
					</p>
				</div>
				<div className="flex items-center gap-0.5 rounded-md border border-line bg-paper p-0.5">
					{(Object.keys(GRANULARITY_LABEL) as SpendGranularity[]).map((g) => (
						<button
							key={g}
							type="button"
							onClick={() => onGranularityChange(g)}
							className={cn(
								"rounded px-2 py-1 text-2xs font-medium capitalize transition-colors",
								granularity === g ? "bg-accent text-white" : "text-ink-3 hover:text-ink",
							)}
						>
							{g}
						</button>
					))}
				</div>
			</div>
			{loading && spend === null ? (
				<div className="py-6 text-center text-xs text-ink-3">Loading spend…</div>
			) : error ? (
				<p className="py-6 text-center text-xs text-ink-3">Could not load account spend: {error}</p>
			) : !spend || spend.accounts.length === 0 ? (
				<p className="py-6 text-center text-xs text-ink-3">No sessions have reported cost yet.</p>
			) : (
				<table className="w-full text-xs">
					<tbody>
						{spend.accounts.map((account) => (
							<tr key={account.cwd} className="border-t border-line/60 first:border-t-0">
								<td className="py-1.5 pr-3 text-ink-2" title={account.cwd}>
									{account.label}
								</td>
								<td className="py-1.5 text-right font-mono tabular-nums text-ink">{formatCost(account[granularity])}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}

function SubscriptionLimitsContent({
	usage,
	loading,
	error,
	onRetry,
}: {
	usage: SubscriptionUsageResponse | null;
	loading: boolean;
	error: string | undefined;
	onRetry: () => Promise<void>;
}) {
	if (loading && usage === null) {
		return <div className="py-10 text-center text-xs text-ink-3">Loading subscription usage…</div>;
	}

	if (error) {
		return (
			<EmptyState
				icon={<AlertCircle className="h-10 w-10 opacity-30" />}
				title="Could not load subscription limits"
				detail={error}
				onRetry={onRetry}
			/>
		);
	}

	if (!usage || !usage.available) {
		return (
			<EmptyState
				icon={<FolderGit2 className="h-10 w-10 opacity-30" />}
				title="Subscription usage unavailable"
				detail={usage?.reason ?? "The provider did not return subscription usage."}
				onRetry={onRetry}
			/>
		);
	}

	return (
		<div className="space-y-3">
			{usage.limits.map((limit) => {
				const pct = Math.min(100, Math.max(0, limit.pctUsed));
				const resetDate = new Date(limit.resetAt);
				const resetLabel = Number.isNaN(resetDate.getTime())
					? limit.resetAt
					: resetDate.toLocaleString(undefined, {
						month: "short",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
					});
				return (
					<section key={limit.label} className="rounded-md border border-line bg-paper-2 p-4">
						<div className="mb-3 flex items-baseline justify-between gap-3">
							<h2 className="text-sm font-medium text-ink">{limit.label}</h2>
							<span
								className={cn(
									"text-lg font-semibold tabular-nums",
									pct >= 90 ? "text-red-400" : pct >= 75 ? "text-yellow-400" : "text-ink",
								)}
							>
								{pct.toFixed(0)}%
							</span>
						</div>
						<div className="h-2 w-full overflow-hidden rounded-full bg-paper-3">
							<div
								className={cn(
									"h-full rounded-full transition-all",
									pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-yellow-500" : "bg-accent",
								)}
								style={{ width: `${pct}%` }}
							/>
						</div>
						<p className="mt-2 text-xs text-ink-3">Resets {resetLabel}</p>
					</section>
				);
			})}
		</div>
	);
}

function EmptyState({
	icon,
	title,
	detail,
	onRetry,
}: {
	icon: ReactNode;
	title: string;
	detail: string;
	onRetry: () => Promise<void>;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center text-ink-3">
			{icon}
			<p className="text-sm text-ink-2">{title}</p>
			<p className="max-w-lg text-xs">{detail}</p>
			<button type="button" onClick={() => void onRetry()} className="btn-ghost h-7 px-2 text-xs">
				Try again
			</button>
		</div>
	);
}
