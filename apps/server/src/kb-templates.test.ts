import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BRANCH_NAMING_RULES_BODY, KB_README_BODY, KB_TEMPLATES, seedKbTemplates } from "./kb-templates.ts";

/** A kb root path that does not exist on disk yet, inside a fresh tmp dir. */
function freshKbRoot(): string {
	const parent = mkdtempSync(path.join(os.tmpdir(), "omp-deck-kb-templates-"));
	return path.join(parent, "kb");
}

function allLabels(): string[] {
	return ["README.md", ...KB_TEMPLATES.map((t) => `${t.dir}/${t.name}`)];
}

describe("seedKbTemplates", () => {
	test("seeds every template into a directory that doesn't exist yet", () => {
		const kbRoot = freshKbRoot();

		const result = seedKbTemplates(kbRoot);

		expect(result.skipped).toEqual([]);
		expect(result.created.sort()).toEqual(allLabels().sort());

		expect(readFileSync(path.join(kbRoot, "README.md"), "utf8")).toBe(KB_README_BODY);

		for (const template of KB_TEMPLATES) {
			const dest = path.join(kbRoot, template.dir, template.name);
			const content = readFileSync(dest, "utf8");
			expect(content.length).toBeGreaterThan(0);
			if (template.name === "branch-naming.md") {
				expect(content).toBe(BRANCH_NAMING_RULES_BODY);
			}
		}
	});

	test("second call skips everything and never clobbers a hand-edited file", () => {
		const kbRoot = freshKbRoot();
		seedKbTemplates(kbRoot);

		// The "user" hand-edits one seeded file in between runs.
		const editedPath = path.join(kbRoot, "system", "working-voice.md");
		writeFileSync(editedPath, "# My own notes\n\nDon't you dare touch this.\n", "utf8");
		const untouchedReadme = readFileSync(path.join(kbRoot, "README.md"), "utf8");

		const result = seedKbTemplates(kbRoot);

		expect(result.created).toEqual([]);
		expect(result.skipped.sort()).toEqual(allLabels().sort());

		expect(readFileSync(editedPath, "utf8")).toBe("# My own notes\n\nDon't you dare touch this.\n");
		expect(readFileSync(path.join(kbRoot, "README.md"), "utf8")).toBe(untouchedReadme);
	});

	test("only seeds what's missing when some templates already exist", () => {
		const kbRoot = freshKbRoot();
		mkdirSync(path.join(kbRoot, "system"), { recursive: true });
		writeFileSync(path.join(kbRoot, "README.md"), "custom pre-existing readme\n", "utf8");
		writeFileSync(path.join(kbRoot, "system", "working-voice.md"), "custom pre-existing voice notes\n", "utf8");

		const result = seedKbTemplates(kbRoot);

		expect(result.skipped.sort()).toEqual(["README.md", "system/working-voice.md"].sort());
		const expectedCreated = allLabels().filter((l) => l !== "README.md" && l !== "system/working-voice.md");
		expect(result.created.sort()).toEqual(expectedCreated.sort());

		// Pre-existing files kept their original content untouched.
		expect(readFileSync(path.join(kbRoot, "README.md"), "utf8")).toBe("custom pre-existing readme\n");
		expect(readFileSync(path.join(kbRoot, "system", "working-voice.md"), "utf8")).toBe(
			"custom pre-existing voice notes\n",
		);

		// Everything else got created with non-empty content.
		for (const template of KB_TEMPLATES) {
			if (template.name === "working-voice.md") continue;
			const dest = path.join(kbRoot, template.dir, template.name);
			expect(readFileSync(dest, "utf8").length).toBeGreaterThan(0);
		}
	});
});

describe("KB_TEMPLATES", () => {
	test("every entry has a valid dir, .md name, and frontmatter'd non-empty body", () => {
		for (const template of KB_TEMPLATES) {
			expect(["system", "rules"]).toContain(template.dir);
			expect(template.name.endsWith(".md")).toBe(true);
			expect(template.body.length).toBeGreaterThan(0);
			expect(template.body.startsWith("---")).toBe(true);
		}
	});

	test("rules holds exactly the two T-77 rule files", () => {
		const ruleNames = KB_TEMPLATES.filter((t) => t.dir === "rules").map((t) => t.name);
		expect(ruleNames.sort()).toEqual(["auto-work.md", "branch-naming.md"]);
	});

	test("system holds exactly the four pre-existing stubs", () => {
		const systemNames = KB_TEMPLATES.filter((t) => t.dir === "system").map((t) => t.name);
		expect(systemNames.sort()).toEqual(
			["deck-orientation.md", "org-system-hub.md", "projects-hub.md", "working-voice.md"].sort(),
		);
	});
});
