import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { INTEGRATION_PROMPT_NAMES, resolveIntegrationPrompt, type IntegrationPromptName } from "./integration-prompts.ts";
import { KbService } from "./kb-service.ts";
import { KB_TEMPLATES } from "./kb-templates.ts";

const AUTO_WORK = "auto-work" as IntegrationPromptName;

let kbRoot: string;

function writeIntegrationFile(name: string, content: string): void {
	const filePath = path.join(kbRoot, "integrations", name);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf8");
}

function rawFallback(name: IntegrationPromptName): string {
	const template = KB_TEMPLATES.find((candidate) => candidate.dir === "integrations" && candidate.name === `${name}.md`);
	expect(template).toBeDefined();
	return template!.body;
}

function createKb(): KbService {
	return new KbService({ root: kbRoot });
}

beforeEach(() => {
	kbRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-integration-prompts-"));
});

afterEach(() => {
	rmSync(kbRoot, { recursive: true, force: true });
});

describe("INTEGRATION_PROMPT_NAMES", () => {
	test("registers the six supported integration prompt stems", () => {
		expect(INTEGRATION_PROMPT_NAMES).toEqual([
			"auto-work",
			"branch-naming",
			"task-rewrite",
			"session-title",
			"auto-work-task-selection",
			"auto-work-squeeze",
		]);
	});
});

describe("resolveIntegrationPrompt", () => {
	test("uses an installed base file before its registered raw fallback", async () => {
		const installedBase = "---\ntype: integration\n---\n# Installed auto-work\n";
		writeIntegrationFile("auto-work.md", installedBase);

		const prompt = await resolveIntegrationPrompt(createKb(), AUTO_WORK);

		expect(prompt).toBe(installedBase);
		expect(prompt).not.toBe(rawFallback(AUTO_WORK));
	});

	test("uses the registered raw fallback when the installed base file is absent", async () => {
		const prompt = await resolveIntegrationPrompt(createKb(), AUTO_WORK);

		expect(prompt).toBe(rawFallback(AUTO_WORK));
	});

	test("appends an installed user customization after the installed base", async () => {
		const installedBase = "---\ntype: integration\n---\n# Base instructions\n";
		const userCustomization = "---\ntype: integration\n---\n# User instructions\n";
		writeIntegrationFile("auto-work.md", installedBase);
		writeIntegrationFile("auto-work.user.md", userCustomization);

		const prompt = await resolveIntegrationPrompt(createKb(), AUTO_WORK);

		expect(prompt).toBe(`${installedBase}\n\n${userCustomization}`);
	});

	test("rejects names outside the registered integration prompt set", async () => {
		await expect(resolveIntegrationPrompt(createKb(), "not-registered" as IntegrationPromptName)).rejects.toThrow();
	});
});
