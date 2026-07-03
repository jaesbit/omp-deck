import type { SkillSummary, SlashCommand } from "@omp-deck/protocol";

/**
 * Project discovered skills into `SlashCommand` rows for the composer picker
 * (T-21). `name` carries the `skill:` prefix so the existing prefix-match
 * filter in `Composer.tsx` (`n.startsWith(q)`) surfaces these for `/skill:`
 * and even partial `/ski` queries with zero picker-logic changes — and so
 * picking one inserts `/skill:<name> ` via the same generic
 * `pickSlashCommand` path every other command goes through.
 *
 * Disabled skills (`frontmatter.hide: true` / plugin-disabled) are excluded
 * — they're invisible to the agent's own `<skills>` listing too, so
 * offering them here would let a user "invoke" something the model was
 * never told exists.
 */
export function mapSkillsToSlashCommands(skills: SkillSummary[]): SlashCommand[] {
	const out: SlashCommand[] = [];
	for (const skill of skills) {
		if (!skill.enabled) continue;
		const cmd: SlashCommand = { name: `skill:${skill.name}`, scope: "skill" };
		if (skill.frontmatter.description) cmd.description = skill.frontmatter.description;
		out.push(cmd);
	}
	return out;
}
