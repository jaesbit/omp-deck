/**
 * Smoke tests for routine templates. Every `.yaml` file under
 * `apps/server/src/templates/` is parsed + validated against the V1 routine
 * spec schema. Adding a new template here is the cheap way to catch typos
 * (unknown step type, missing required field, regex-failing id) before they
 * 500 the install endpoint at runtime.
 *
 * The test is dynamic: it iterates whatever templates are present on disk
 * rather than hardcoding a slug list. That way local-only templates (e.g.
 * user-specific paper-trading sleeves gitignored away from the public repo)
 * still get validated in dev, but CI doesn't fail when they're absent.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateRoutineSpec } from "@omp-deck/protocol";

import { listTemplates, loadTemplate } from "./templates.ts";

/** Templates that MUST ship in the public repo. Anything else is best-effort. */
const REQUIRED_SHIPPED = ["daily-briefing"] as const;

describe("routine templates", () => {
	test("every required shipped template is in the listing", () => {
		const slugs = new Set(listTemplates().map((t) => t.slug));
		for (const required of REQUIRED_SHIPPED) {
			expect(slugs.has(required)).toBe(true);
		}
	});

	const templates = listTemplates();
	for (const summary of templates) {
		test(`${summary.slug}: loads + passes schema validation`, () => {
			const loaded = loadTemplate(summary.slug);
			expect(loaded).not.toBeNull();
			if (!loaded) return;
			const result = validateRoutineSpec(loaded.spec);
			if (!result.valid) {
				const reasons = (result.errors ?? []).map((e) => `  ${e.path}: ${e.message}`).join("\n");
				throw new Error(`${summary.slug} failed validation:\n${reasons}`);
			}
		});
	}

	test("loads a template from the compiled layout when the source layout is absent", async () => {
		const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-compiled-templates-"));
		try {
			const compiledEntryDir = path.join(fixtureRoot, "dist");
			const build = await Bun.build({
				entrypoints: [fileURLToPath(new URL("./templates.ts", import.meta.url))],
				outdir: compiledEntryDir,
				target: "bun",
			});
			if (!build.success) throw new Error(`Could not compile the template loader:\n${build.logs.join("\n")}`);

			fs.mkdirSync(path.join(compiledEntryDir, "templates"), { recursive: true });
			fs.writeFileSync(
				path.join(compiledEntryDir, "templates", "compiled-layout.yaml"),
				"name: compiled-layout\ndescription: Available only beside the compiled entry\nsteps:\n  - id: emit\n    type: run\n    command: echo compiled\n",
			);

			// The loader must be imported from its generated, runtime-selected path.
			const compiledLoader = await import(pathToFileURL(path.join(compiledEntryDir, "templates.js")).href);
			expect(compiledLoader.listTemplates()).toEqual([
				{
					slug: "compiled-layout",
					name: "compiled-layout",
					description: "Available only beside the compiled entry",
					steps: 1,
					triggers: 0,
				},
			]);
			expect(compiledLoader.loadTemplate("compiled-layout")).toMatchObject({
				spec: { name: "compiled-layout" },
				specYaml: expect.stringContaining("command: echo compiled"),
			});
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
