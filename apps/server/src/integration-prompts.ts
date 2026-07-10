import type { KbService } from "./kb-service.ts";
import { KB_TEMPLATES } from "./kb-templates.ts";

export const INTEGRATION_PROMPT_NAMES = [
	"auto-work",
	"branch-naming",
	"task-rewrite",
	"session-title",
	"auto-work-task-selection",
	"auto-work-squeeze",
] as const;

export type IntegrationPromptName = (typeof INTEGRATION_PROMPT_NAMES)[number];

const INTEGRATION_PROMPT_NAME_SET = new Set<string>(INTEGRATION_PROMPT_NAMES);

/**
 * Resolves a backend-owned integration prompt without exposing its filesystem
 * path to a caller. An installed base document wins over the bundled template,
 * while a neighboring `.user.md` document is appended as the operator layer.
 * Neither layer enters a normal session prelude.
 */
export async function resolveIntegrationPrompt(kb: KbService, name: IntegrationPromptName): Promise<string> {
	if (!INTEGRATION_PROMPT_NAME_SET.has(name)) {
		throw new Error(`unknown integration prompt: ${name}`);
	}

	const basePath = `integrations/${name}.md`;
	const installedBase = await kb.getFile(basePath);
	const fallback = KB_TEMPLATES.find((template) => template.dir === "integrations" && template.name === `${name}.md`)?.body;
	if (!installedBase && !fallback) {
		throw new Error(`missing bundled integration prompt: ${name}`);
	}

	const userPath = `integrations/${name}.user.md`;
	const userCustomization = await kb.getFile(userPath);
	const base = installedBase?.rawContent ?? fallback!;
	return userCustomization ? `${base}\n\n${userCustomization.rawContent}` : base;
}
