/**
 * Parsing + prompt composition for `/skill:<name>` interception in the deck
 * WS layer (see `ws.ts`'s `handlePrompt`).
 *
 * Native `omp`'s TUI supports `/skill:<name>` end-to-end (reads the skill's
 * SKILL.md, strips frontmatter, injects the body as a user-attributed
 * message) via `modes/skill-command.ts` in `@oh-my-pi/pi-coding-agent` — but
 * that plumbing is gated behind `InteractiveModeContext` and unreachable from
 * the deck's ACP/bridge dispatch path. This module reimplements the same
 * parsing (`parseSkillInvocation`'s leading-form branch) and prompt
 * composition (`buildSkillPromptMessage`'s "user" invocation template,
 * `prompts/skills/user-invocation.md`) against the deck's own
 * `SkillsService`, kept as pure functions so they're unit-testable without a
 * live WS connection.
 */

export interface ParsedSkillCommand {
	name: string;
	args: string;
}

/**
 * Recognize a leading `/skill:<name> [args]` invocation. Mirrors the SDK's
 * `parseSkillInvocation`'s leading-form branch exactly (name = everything up
 * to the first space, no character-class restriction — skill names are
 * whatever the frontmatter/dirname says). Deliberately does not implement
 * the SDK's *mid-prompt* form (`fix the bug /skill:foo`) — the WS layer only
 * calls this when `frame.text` itself starts with `/skill:`, so mid-prompt
 * detection has no caller here.
 *
 * Returns `undefined` for anything that isn't a `/skill:` invocation, or has
 * an empty name (bare `/skill:`).
 */
export function parseSkillSlashCommand(text: string): ParsedSkillCommand | undefined {
	const trimmedStart = text.trimStart();
	if (!trimmedStart.startsWith("/skill:")) return undefined;
	const spaceIndex = trimmedStart.indexOf(" ");
	const name =
		spaceIndex === -1 ? trimmedStart.slice("/skill:".length) : trimmedStart.slice("/skill:".length, spaceIndex);
	if (!name) return undefined;
	const args = spaceIndex === -1 ? "" : trimmedStart.slice(spaceIndex + 1).trim();
	return { name, args };
}

/**
 * Compose the user-attributed prompt body injected for a `/skill:` invoke.
 * Byte-for-byte mirror of `@oh-my-pi/pi-coding-agent`'s
 * `prompts/skills/user-invocation.md` template as rendered by
 * `buildSkillPromptMessage(..., "user")` — reproduced as a literal template
 * here (rather than imported) because the SDK module that owns it sits
 * behind TUI-only, non-exported plumbing.
 */
export function buildSkillInvocationPrompt(
	skill: { name: string; body: string; baseDir: string },
	args: string,
): string {
	const trimmedArgs = args.trim();
	const lines = [
		`[IMPORTANT: The user has invoked the "${skill.name}" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]`,
		"",
		skill.body,
		"",
		"---",
		"",
		`[Skill directory: ${skill.baseDir}]`,
		"Resolve any relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against that directory using its absolute path: read referenced assets and templates, and run scripts with the terminal tool when the skill's instructions call for it.",
	];
	if (trimmedArgs) lines.push(`User: ${trimmedArgs}`);
	return lines.join("\n").trim();
}
