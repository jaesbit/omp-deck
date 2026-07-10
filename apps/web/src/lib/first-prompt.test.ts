import { describe, expect, test } from "bun:test";

import { launchSession } from "./first-prompt";

describe("launchSession", () => {
	test("sends the initial prompt directly as the first turn when the target session hydrates", async () => {
		const createCalls: Array<Record<string, unknown>> = [];
		const pendingDrafts: Array<{ text: string; sessionId?: string; autoSend?: boolean } | undefined> = [];
		const createSession = async (opts: Record<string, unknown>): Promise<string> => {
			createCalls.push(opts);
			return "session-123";
		};

		await launchSession(createSession, (draft) => pendingDrafts.push(draft), {
			cwd: "/workspace",
			model: { provider: "anthropic", id: "claude" },
			planMode: false,
			initialPrompt: "Build the feature",
		});

		expect(createCalls).toEqual([
			{
				cwd: "/workspace",
				model: { provider: "anthropic", id: "claude" },
				planMode: false,
			},
		]);
		expect(pendingDrafts).toEqual([
			{
				text: "Build the feature",
				sessionId: "session-123",
				autoSend: true,
			},
		]);
	});

	test("does not queue a draft when no initial prompt was given", async () => {
		const createCalls: Array<Record<string, unknown>> = [];
		const pendingDrafts: unknown[] = [];
		const createSession = async (opts: Record<string, unknown>): Promise<string> => {
			createCalls.push(opts);
			return "session-456";
		};

		await launchSession(createSession, (draft) => pendingDrafts.push(draft), {
			cwd: "/workspace",
			planMode: true,
		});

		expect(createCalls[0]).toEqual({
			cwd: "/workspace",
			model: undefined,
			planMode: true,
		});
		expect(pendingDrafts).toEqual([]);
	});
});
