import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { logger } from "./log.ts";

const log = logger("kb-templates");

export interface KbTemplate {
	dir: "system" | "integrations";
	name: string;
	body: string;
}

export interface SeedKbTemplatesResult {
	created: string[];
	skipped: string[];
}

export const KB_README_BODY = `---
type: knowledge
tags: [meta, readme]
---

# Welcome to your KB

omp-deck seeds a small product baseline. \`system/*.md\` is injected into normal
sessions. Add \`system/*.user.md\` for universal local policy.

\`integrations/*.md\` describes an on-demand surface or backend workflow. It is
never injected into a normal session just because it exists. Add a neighboring
\`integrations/*.user.md\` to extend a backend-owned integration. Reading a base
integration through \`kb://\` composes its local sidecar when present.

Automatic session titles use only \`integrations/session-title.md\` plus its
optional \`.user.md\` sidecar. Settings selects the internal model, not a second
prompt.
`;

const integration = (id: string, body: string) => `---
type: integration
id: ${id}
---

${body}\n`;

export const AUTO_WORK_RULES_BODY = integration("auto-work", `# Auto Work

Execute the selected task in its prepared worktree. Read its card, implement and
verify the requested change, then follow the repository's commit, review and task-state rules.`);

export const BRANCH_NAMING_RULES_BODY = integration("branch-naming", `# Branch naming

Return only a short, lowercase ASCII kebab-case branch slug that captures the
task title. Use 3–6 English words, with no quotes or prose.`);

export const TASK_REWRITE_PROMPT_BODY = integration("task-rewrite", `# Task rewrite

Rewrite the supplied kanban task for clarity and actionability. Preserve scope.
Return only the requested JSON object.`);

export const SESSION_TITLE_PROMPT_BODY = integration("session-title", `# Session title

Return only a short, specific title for the supplied first user message. Prefix
with the linked task's T-number when one is supplied.`);

export const AUTO_WORK_TASK_SELECTION_PROMPT_BODY = integration("auto-work-task-selection", `# Auto Work task selection

Choose one eligible candidate by returning only its exact task id. Prefer the
highest-priority candidate that fits the supplied constraints.`);

export const AUTO_WORK_SQUEEZE_PROMPT_BODY = integration("auto-work-squeeze", `# Auto Work squeeze decision

Return only YES or NO. Use the supplied usage windows and eligible-work summary
to decide whether an additional run is justified now.`);
const TASKS_INTEGRATION_BODY = integration("tasks", `# Tasks

Use the configured local API base. Fetch task state before changing a task and
confirm the result after mutation.`);

const ROUTINES_INTEGRATION_BODY = integration("routines", `# Routines

Use the configured local API base. Read a routine before changing its schedule
or action, then confirm the saved state.`);

const INBOX_INTEGRATION_BODY = integration("inbox", `# Inbox

Use the configured local API base. Inspect an inbox item before promoting,
editing or deleting it.`);

const KB_SYSTEM_TEMPLATES: ReadonlyArray<KbTemplate> = [
	{
		dir: "system",
		name: "deck-orientation.md",
		body: `---
type: knowledge
tags: [system, deck]
---

# Deck orientation

You are working inside omp-deck. The session prelude provides the local API base.
Read \`kb://integrations/<name>.md\` only when that surface is relevant.
`,
	},
	{
		dir: "system",
		name: "working-voice.md",
		body: `---
type: knowledge
tags: [system, voice]
---

# Working voice

Be direct. Keep responses concrete. User-specific communication preferences
belong in \`working-voice.user.md\`.
`,
	},
];

const KB_INTEGRATION_TEMPLATES: ReadonlyArray<KbTemplate> = [
	{ dir: "integrations", name: "auto-work.md", body: AUTO_WORK_RULES_BODY },
	{ dir: "integrations", name: "branch-naming.md", body: BRANCH_NAMING_RULES_BODY },
	{ dir: "integrations", name: "task-rewrite.md", body: TASK_REWRITE_PROMPT_BODY },
	{ dir: "integrations", name: "session-title.md", body: SESSION_TITLE_PROMPT_BODY },
	{ dir: "integrations", name: "auto-work-task-selection.md", body: AUTO_WORK_TASK_SELECTION_PROMPT_BODY },
	{ dir: "integrations", name: "auto-work-squeeze.md", body: AUTO_WORK_SQUEEZE_PROMPT_BODY },
	{ dir: "integrations", name: "tasks.md", body: TASKS_INTEGRATION_BODY },
	{ dir: "integrations", name: "routines.md", body: ROUTINES_INTEGRATION_BODY },
	{ dir: "integrations", name: "inbox.md", body: INBOX_INTEGRATION_BODY },
];

export const KB_TEMPLATES: ReadonlyArray<KbTemplate> = [...KB_SYSTEM_TEMPLATES, ...KB_INTEGRATION_TEMPLATES];

/** Idempotently writes the product baseline. Existing files are never overwritten. */
export function seedKbTemplates(kbRoot: string): SeedKbTemplatesResult {
	const result: SeedKbTemplatesResult = { created: [], skipped: [] };
	const seed = (destination: string, body: string, label: string) => {
		if (existsSync(destination)) {
			result.skipped.push(label);
			return;
		}
		try {
			mkdirSync(path.dirname(destination), { recursive: true });
			writeFileSync(destination, body, "utf8");
			result.created.push(label);
		} catch (err) {
			log.warn(`failed to write ${destination}`, err);
			result.skipped.push(label);
		}
	};
	seed(path.join(kbRoot, "README.md"), KB_README_BODY, "README.md");
	for (const template of KB_TEMPLATES) {
		seed(path.join(kbRoot, template.dir, template.name), template.body, `${template.dir}/${template.name}`);
	}
	return result;
}
