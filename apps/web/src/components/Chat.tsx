import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useStore, selectActiveSession } from "@/lib/store";
import { ChatHeader } from "./chat/ChatHeader";
import { SessionPicker } from "./chat/SessionPicker";
import { UserMessage } from "./messages/UserMessage";
import { AssistantMessage } from "./messages/AssistantMessage";
import { Notice } from "./messages/Notice";
import { CompactionLine } from "./messages/CompactionLine";
import { TtsrLine } from "./messages/TtsrLine";
import { IrcLine } from "./messages/IrcLine";
import { QueuedMessage } from "./messages/QueuedMessage";
import { PlanApproval } from "./messages/PlanApproval";

export function Chat() {
	const session = useStore(selectActiveSession);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickyRef = useRef(true);
	const [showScrollButton, setShowScrollButton] = useState(false);

	const messages = session?.messages ?? [];
	const toolCalls = session?.toolCalls ?? {};
	const queuedPrompts = session?.queuedPrompts ?? [];

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (stickyRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, toolCalls, queuedPrompts]);

	function handleScroll(): void {
		const el = scrollRef.current;
		if (!el) return;
		const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		const sticky = fromBottom < 100;
		stickyRef.current = sticky;
		setShowScrollButton(!sticky);
	}

	function scrollToBottom(): void {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
		stickyRef.current = true;
		setShowScrollButton(false);
	}

	// No active session — show the picker as the main pane instead of a
	// dead-end "go to sidebar" message.
	if (!session) {
		return <SessionPicker />;
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<ChatHeader />
			<div className="relative min-h-0 flex-1">
				<div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
					<div className="mx-auto flex max-w-[760px] flex-col gap-7 px-6 py-10">
						{messages.length === 0 ? (
							<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
								Empty session — send a prompt below.
							</div>
						) : null}

						{messages.map((m) => {
							switch (m.role) {
								case "user":
									return <UserMessage key={m.id} msg={m} />;
								case "assistant":
									return <AssistantMessage key={m.id} msg={m} toolCalls={toolCalls} />;
								case "notice":
									return <Notice key={m.id} msg={m} />;
								case "compaction":
									return <CompactionLine key={m.id} msg={m} />;
								case "ttsr":
									return <TtsrLine key={m.id} msg={m} />;
								case "irc":
									return <IrcLine key={m.id} msg={m} />;
								default:
									return null;
							}
						})}

						{queuedPrompts.map((q) => (
							<QueuedMessage key={q.id} msg={q} />
						))}
						{session.pendingPlanApproval ? (
							<PlanApproval session={session} />
						) : null}
					</div>
				</div>
				{showScrollButton ? (
					<button
						type="button"
						onClick={scrollToBottom}
						aria-label="Scroll to bottom"
						className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-paper-2 p-2 text-ink-2 shadow-[0_8px_24px_-8px_rgba(26,24,20,0.25)] transition hover:bg-paper hover:text-ink"
					>
						<ArrowDown className="h-4 w-4" />
					</button>
				) : null}
			</div>
		</div>
	);
}
