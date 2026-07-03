import { describe, expect, test } from "bun:test";

import type { SkillSummary } from "@omp-deck/protocol";

import { mapSkillsToSlashCommands } from "./skill-commands";

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
	return {
		id: "id",
		name: "diagnose",
		dirName: "diagnose",
		provider: "native",
		providerLabel: "OMP",
		level: "user",
		skillPath: "/home/u/.omp/agent/skills/diagnose/SKILL.md",
		frontmatter: { name: "diagnose", description: "Disciplined diagnosis loop." },
		enabled: true,
		...overrides,
	};
}

describe("mapSkillsToSlashCommands", () => {
	test("projects a skill to a skill:-scoped slash command carrying its description", () => {
		expect(mapSkillsToSlashCommands([skill()])).toEqual([
			{ name: "skill:diagnose", scope: "skill", description: "Disciplined diagnosis loop." },
		]);
	});

	test("omits the description field entirely when the skill has none", () => {
		const out = mapSkillsToSlashCommands([skill({ frontmatter: { name: "diagnose" } })]);
		expect(out).toEqual([{ name: "skill:diagnose", scope: "skill" }]);
		expect("description" in out[0]!).toBe(false);
	});

	test("excludes disabled skills (hidden or plugin-disabled)", () => {
		const out = mapSkillsToSlashCommands([skill({ enabled: false }), skill({ name: "other", enabled: true })]);
		expect(out).toEqual([{ name: "skill:other", scope: "skill", description: "Disciplined diagnosis loop." }]);
	});

	test("prefixes the name with 'skill:' so the composer's prefix-match filter matches '/skill:' queries", () => {
		const out = mapSkillsToSlashCommands([skill({ name: "zoom-out" })]);
		expect(out[0]!.name.startsWith("skill:")).toBe(true);
		expect("skill:zoom-out".startsWith("skill:")).toBe(true);
	});
});
