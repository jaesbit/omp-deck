/**
 * Unit tests for `/skill:<name>` parsing + prompt composition (T-21).
 *
 * Pure-function tests only — the WS-layer wiring (`ws.ts`'s `handlePrompt`
 * calling `SkillsService.getSkillDetailByName` then `handle.prompt`) is
 * exercised indirectly via manual trace + typecheck since spinning up a real
 * WS connection + AgentBridge for this would mostly re-test bun's WS plumbing
 * rather than the skill-specific logic, which lives entirely in these two
 * functions.
 */

import { describe, expect, it } from "bun:test";

import { buildSkillInvocationPrompt, parseSkillSlashCommand } from "./skill-invocation.ts";

describe("parseSkillSlashCommand", () => {
	it("parses a bare invocation with no args", () => {
		expect(parseSkillSlashCommand("/skill:diagnose")).toEqual({ name: "diagnose", args: "" });
	});

	it("parses name + trailing args, trimming whitespace", () => {
		expect(parseSkillSlashCommand("/skill:diagnose   the login flow is broken  ")).toEqual({
			name: "diagnose",
			args: "the login flow is broken",
		});
	});

	it("tolerates leading whitespace before the slash", () => {
		expect(parseSkillSlashCommand("   /skill:zoom-out")).toEqual({ name: "zoom-out", args: "" });
	});

	it("rejects a bare '/skill:' with no name", () => {
		expect(parseSkillSlashCommand("/skill:")).toBeUndefined();
	});

	it("rejects a bare '/skill: ' with only whitespace after the colon", () => {
		expect(parseSkillSlashCommand("/skill: some args")).toBeUndefined();
	});

	it("rejects plain prompt text", () => {
		expect(parseSkillSlashCommand("what does /skill:foo even do?")).toBeUndefined();
	});

	it("rejects unrelated slash commands", () => {
		expect(parseSkillSlashCommand("/plan on")).toBeUndefined();
		expect(parseSkillSlashCommand("/task add fix the bug")).toBeUndefined();
	});
});

describe("buildSkillInvocationPrompt", () => {
	it("composes the user-invocation template with args", () => {
		const out = buildSkillInvocationPrompt(
			{ name: "diagnose", body: "1. Reproduce\n2. Minimise", baseDir: "/home/u/.omp/agent/skills/diagnose" },
			"the login flow is broken",
		);
		expect(out).toBe(
			[
				'[IMPORTANT: The user has invoked the "diagnose" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]',
				"",
				"1. Reproduce",
				"2. Minimise",
				"",
				"---",
				"",
				"[Skill directory: /home/u/.omp/agent/skills/diagnose]",
				"Resolve any relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against that directory using its absolute path: read referenced assets and templates, and run scripts with the terminal tool when the skill's instructions call for it.",
				"User: the login flow is broken",
			].join("\n"),
		);
	});

	it("omits the trailing User: line when args are empty", () => {
		const out = buildSkillInvocationPrompt({ name: "diagnose", body: "body text", baseDir: "/skills/diagnose" }, "");
		expect(out.endsWith("call for it.")).toBe(true);
		expect(out).not.toContain("User:");
	});

	it("omits the trailing User: line when args are whitespace-only", () => {
		const out = buildSkillInvocationPrompt({ name: "diagnose", body: "body text", baseDir: "/skills/diagnose" }, "   ");
		expect(out).not.toContain("User:");
	});
});
