import type { AssistantMsg, ToolCallStream } from "@/lib/types";
import { Loader2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { Markdown } from "@/lib/markdown";
import { formatCost, formatDurationMs, formatTokens } from "@/lib/utils";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "../tools/ToolCallCard";

interface Props {
	msg: AssistantMsg;
	toolCalls: Record<string, ToolCallStream>;
}

export function AssistantMessage({ msg, toolCalls }: Props) {
	const lastBlockIdx = msg.blocks.length - 1;
	const hideToolCalls = useStore((s) => s.toolView.hideAll);

	// T-48 "hide tool calls" mode: never render tool-call history, only a
	// live spinner + the name(s) of whatever tool is currently running in
	// this turn. Once a tool call leaves "running" status it simply stops
	// appearing here — no collapsed stub, no trace.
	const runningToolNames = hideToolCalls
		? msg.blocks
				.filter((b) => b.type === "toolCall")
				.filter((b) => (toolCalls[b.id]?.status ?? "running") === "running")
				.map((b) => b.name)
		: [];

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
				<span className="text-ink-2">omp</span>
				{msg.model ? <span className="text-ink-4 normal-case tracking-normal">{msg.model}</span> : null}
				{msg.isStreaming ? <span className="text-accent">· streaming</span> : null}
				{msg.stopReason && !msg.isStreaming ? (
					<span className={msg.stopReason === "stop" ? "text-ink-4" : "text-warn"}>
						· {msg.stopReason}
					</span>
				) : null}
				{msg.usage?.totalTokens ? (
					<span className="text-ink-4">
						· {formatTokens(msg.usage.totalTokens)} tok · {formatCost(msg.usage.cost)}
					</span>
				) : null}
				{msg.durationMs ? (
					<span className="text-ink-4">· {formatDurationMs(msg.durationMs)}</span>
				) : null}
			</div>

			{msg.errorMessage ? (
				<div className="border-l-2 border-danger pl-3 font-mono text-xs text-danger">
					{msg.errorMessage}
				</div>
			) : null}

			{msg.blocks.length === 0 && msg.isStreaming ? (
				<div className="cursor-blink font-mono text-xs text-ink-3">…</div>
			) : null}

			<div className="space-y-3">
				{msg.blocks.map((b, i) => {
					if (b.type === "text") {
						const last = i === lastBlockIdx;
						return (
							<Markdown key={i} streaming={msg.isStreaming && last}>
								{b.text}
							</Markdown>
						);
					}
					if (b.type === "thinking") {
						return <ThinkingBlock key={i} text={b.thinking} streaming={msg.isStreaming} />;
					}
					if (b.type === "redactedThinking") {
						return (
							<ThinkingBlock
								key={i}
								text="(redacted thinking)"
								streaming={false}
								redacted
							/>
						);
					}
					if (b.type === "toolCall") {
						if (hideToolCalls) return null;
						const stream = toolCalls[b.id];
						return (
							<ToolCallCard
								key={b.id || i}
								toolCallId={b.id}
								name={b.name}
								args={b.arguments}
								intent={b.intent}
								stream={stream}
							/>
						);
					}
					return null;
				})}
			</div>

			{runningToolNames.length > 0 ? (
				<div className="flex items-center gap-2 font-mono text-xs text-ink-3">
					<Loader2 className="h-3 w-3 animate-spin text-accent" />
					<span>{runningToolNames.join(", ")}</span>
				</div>
			) : null}
		</div>
	);
}
