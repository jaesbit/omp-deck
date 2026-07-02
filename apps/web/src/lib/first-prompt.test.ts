import { describe, expect, test } from "bun:test";

import {
	combineWithAutoStart,
	launchSession,
	SESSION_INITIALISATION_COMMAND,
} from "./first-prompt";

describe("combineWithAutoStart", () => {
	test("prefixes the configured slash command and leaves one separating space", () => {
		expect(combineWithAutoStart("/start", "Work on T-44")).toBe("/start Work on T-44");
	});

	test("does not synthesize a slash command when auto-start is disabled", () => {
		expect(combineWithAutoStart(null, "Work on T-44")).toBe("Work on T-44");
	});

	test("does not leave a bare auto-start command for an empty message", () => {
		expect(combineWithAutoStart("/start", "   ")).toBe("");
	});
});

describe("launchSession", () => {
	test("auto-sends the initial prompt through canonical /start as the target session hydrates", async () => {
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
				suppressAutoStart: true,
			},
		]);
		expect(pendingDrafts).toEqual([
			{
				text: `${SESSION_INITIALISATION_COMMAND} Build the feature`,
				sessionId: "session-123",
				autoSend: true,
			},
		]);
	});

	test("preserves normal server auto-start when no initial prompt was given", async () => {
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
			suppressAutoStart: false,
		});
		expect(pendingDrafts).toEqual([]);
	});
});
