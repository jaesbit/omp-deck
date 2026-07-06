import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertCircle, FolderGit2, RefreshCw } from "lucide-react";
import type { SubscriptionUsageResponse } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Dedicated view for the provider subscription windows used by Auto Work. */
export function SubscriptionLimitsView() {
	const [usage, setUsage] = useState<SubscriptionUsageResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			setUsage(await api.getSubscriptionUsage());
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
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
							<p className="text-2xs text-ink-3">Provider usage windows and reset times</p>
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
					<SubscriptionLimitsContent usage={usage} loading={loading} error={error} onRetry={refresh} />
				</div>
			}
			inspector={null}
			topBar={null}
		/>
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
		return <div className="flex flex-1 items-center justify-center text-xs text-ink-3">Loading subscription usage…</div>;
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
		<div className="flex-1 overflow-y-auto p-4">
			<div className="mx-auto max-w-3xl space-y-3">
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
		<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-ink-3">
			{icon}
			<p className="text-sm text-ink-2">{title}</p>
			<p className="max-w-lg text-xs">{detail}</p>
			<button type="button" onClick={() => void onRetry()} className="btn-ghost h-7 px-2 text-xs">
				Try again
			</button>
		</div>
	);
}
