/**
 * KB template registry — the starter `README.md` + `kb/system/*.md` +
 * `kb/rules/*.md` files omp-deck scaffolds into a user's kb root.
 *
 * `seedKbTemplates(kbRoot)` is idempotent: it `mkdir -p`s each target
 * subdirectory and writes a template's body only when the destination file
 * doesn't already exist. It never overwrites a file the user has touched
 * (including one they deleted on purpose — absence just means "recreate").
 *
 * Two callers:
 *  - `routes-onboarding.ts`'s `POST /api/onboarding/seed-kb-system` — the
 *    first-run wizard, seeds whatever path the user typed (which may not be
 *    the server's resolved `OMP_DECK_KB_ROOT` yet).
 *  - `index.ts`'s boot sequence — runs against the resolved KB root on every
 *    server start, so both a fresh bootstrap AND an upgrade of an existing
 *    install (one that predates a newly added template) end up with every
 *    template file present, without a wizard visit. Disable with
 *    `OMP_DECK_SEED_KB_TEMPLATES=0`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { logger } from "./log.ts";

const log = logger("kb-templates");

export interface KbTemplate {
	/** Subdirectory under the kb root — `system/` is auto-inlined into every
	 *  session's system prompt; `rules/` is opt-in, read on demand by code
	 *  or `kb://` lookups. */
	dir: "system" | "rules";
	name: string;
	body: string;
}

export interface SeedKbTemplatesResult {
	created: string[];
	skipped: string[];
}

/**
 * Top-level README written at the kb root. Explains the wiki convention
 * (frontmatter, wikilinks) so the first file a user opens already
 * demonstrates the shape.
 */
export const KB_README_BODY = [
	"---",
	"type: knowledge",
	"tags: [meta, readme]",
	"---",
	"",
	"# Welcome to your KB",
	"",
	"This is a fresh knowledge base scaffolded by omp-deck onboarding. The deck",
	"reads this folder as a Karpathy-style llm-wiki — hand-tended markdown with",
	"YAML frontmatter and `[[wikilinks]]` between articles.",
	"",
	"## How it works",
	"",
	"- Each file is markdown with YAML frontmatter (`type`, `created`,",
	"  `updated`, `tags` are parsed automatically).",
	"- `[[some-file]]` resolves by filename stem. `[[dir/path]]` for explicit",
	"  paths. `[[target|label]]` to rename the rendered text.",
	"- Every new session inlines `system/*.md` into its system prompt — add",
	"  rules about your voice, projects, and org system there. `rules/*.md`",
	"  is opt-in — read on demand via `kb://rules/<name>.md`, or injected by",
	"  code for a specific purpose (e.g. auto-work sessions, branch naming).",
	"",
	"## What this is NOT",
	"",
	"omp's session memory (rolling summaries, vector store) is separate. This kb",
	"is your long-term, hand-tended layer. They complement each other.",
	"",
	"Happy authoring.",
	"",
].join("\n");

const AUTO_WORK_RULES_BODY = [
	"---",
	"type: knowledge",
	"tags: [rules, auto-work, workflow]",
	"---",
	"",
	"# Auto-work workflow",
	"",
	"How agents working in auto-work mode MUST close a task. This applies to any",
	"session launched by the auto-work engine and to any human-driven session that",
	"picks up a kanban task (`T-N`).",
	"",
	"Unlike `kb/system/*.md`, this file is NOT auto-inlined into every session's",
	"system prompt — only the auto-work engine's task-execution session gets it,",
	"appended by code alongside the normal `kb/system` prelude.",
	"",
	"## The loop",
	"",
	"1. **Implement** the task as described in its kanban body.",
	"2. **Commit** — one commit (or more if the change is genuinely multi-step),",
	"   each with a concise descriptive message:",
	"   - Subject line: `T-N: <what changed>` — imperative mood, ≤72 chars,",
	"     no period.",
	"   - Body (optional): explain *why* if it isn't obvious from the diff.",
	"   - No marketing language (\"add support for\", \"implement feature\") — just",
	"     what the diff does.",
	"3. **Open a PR** against `origin/main` (our fork, never `upstream` unless",
	"   the user says so explicitly in that same conversation):",
	"   ```",
	"   gh pr create --title \"T-N: <same subject as commit>\" \\",
	"                --body \"Closes T-N.<newline><scope summary>\"",
	"   ```",
	"   Use the repo's PR template when one exists (check `.github/pull_request_template.md`).",
	"4. **Move the task to Validate** — NEVER to Done. Done is the user's call.",
	"   ```",
	"   PATCH /api/tasks/<id>  →  { \"stateId\": \"<validate-column-id>\" }",
	"   ```",
	"   Always fetch `/api/task-states` first to get the current state ids; never",
	"   hardcode them.",
	"",
	"## Invariants",
	"",
	"- The commit lands on a feature branch, not on `main` directly.",
	"- **Feature branch MUST branch from `origin/main`**, never from an in-progress",
	"  worktree or another feature branch. Independent tasks have no shared ancestry —",
	"  squash-merging them avoids conflicts only when each starts from the same clean base.",
	"  The auto-work engine enforces this (`git worktree add -b <branch> <path> origin/main`).",
	"  Human sessions MUST do the same: `git checkout -b feat/T-N origin/main`.",
	"- The PR URL and session id are appended to the task body so the user can",
	"  trace back from the kanban card:",
	"  ```",
	"  ---",
	"  **Auto Work** — [session <short-id>](<deckBaseUrl>/c/<id>) · PR #N",
	"  ```",
	"- If anything fails after the commit (PR creation, task move), log the error",
	"  and leave the task in its current column rather than silently marking it done.",
	"- One task = one PR. Do not batch unrelated work into a single PR.",
	"",
	"## Why Validate, not Done",
	"",
	"Validate is the human review gate. The agent produced the change; the human",
	"confirms it's correct before closing. Moving to Done would skip that gate.",
	"The user closes the task after reviewing the PR and merging (or rejecting).",
	"",
	"## Column id lookup",
	"",
	"```",
	"GET /api/task-states",
	"```",
	"The validate column is typically named \"Validate\" (`s_validate` in seeded",
	"data, but always confirm — the user may have renamed or added columns).",
	"",
].join("\n");

/**
 * Default rules for the branch-name slug generator (T-77). This is the
 * ONLY context given to that generator — not the full `kb/system` prelude,
 * just this file's content plus the task's own title — so it stays short
 * and cheap to run on every auto-work cycle. `engine.ts` also falls back to
 * this exact text in-process if the file is missing on disk.
 */
export const BRANCH_NAMING_RULES_BODY = [
	"---",
	"type: knowledge",
	"tags: [rules, auto-work, git, branch-naming]",
	"---",
	"",
	"# Branch naming",
	"",
	"Rules for generating a git branch-name slug for an auto-work task. This is the",
	"ONLY context given to the branch-name generator — no other kb file, no task",
	"body, just this file's content plus the task's title. Keep it short: it runs on",
	"every auto-work cycle.",
	"",
	"## Format",
	"",
	"- Always English, regardless of the task title's own language. Translate the",
	"  meaning, don't transliterate the words.",
	"- kebab-case, lowercase, ASCII only (`a-z0-9-`).",
	"- 3-6 words, capturing the essence of the task, not a literal translation.",
	"- No leading/trailing dashes, no consecutive dashes.",
	"- Return ONLY the slug — no prose, no punctuation, no markdown, no quotes.",
	"",
	"## Examples",
	"",
	'- "Revisar por qué modelos descatalogados siguen apareciendo" → `stale-models-in-listing`',
	'- "Añadir botón de papelera para borrar sesión" → `session-delete-button`',
	'- "Fix: usage-subscription.ts typecheck fails on main" → `fix-usage-subscription-typecheck`',
	"",
	"## Customize",
	"",
	"Edit this file to steer the generator — e.g. enforce a `type/` prefix",
	"convention, cap length differently, or bias toward ticket-style slugs. It's",
	"re-seeded only if deleted entirely; an edited file is never overwritten.",
	"",
].join("\n");

const KB_SYSTEM_TEMPLATES: ReadonlyArray<KbTemplate> = [
	{
		dir: "system",
		name: "working-voice.md",
		body: [
			"---",
			"type: knowledge",
			"tags: [system, voice]",
			"---",
			"",
			"# Working voice",
			"",
			"How you prefer the agent to communicate with you. Drop short notes here as",
			"you notice things you want the agent to do or stop doing. Read at session",
			"start by the default `/start` command.",
			"",
			"## Examples",
			"",
			"- Be direct. Skip pleasantries.",
			"- Cite tasks by `T-N` ids.",
			"- Don't ask for confirmation on reversible actions.",
			"",
		].join("\n"),
	},
	{
		dir: "system",
		name: "deck-orientation.md",
		body: [
			"---",
			"type: knowledge",
			"tags: [system, deck]",
			"---",
			"",
			"# Deck orientation",
			"",
			"Quick reference for what omp-deck is and the local API surface.",
			"",
			"## Capabilities",
			"",
			"- **Chat** — multi-session conversations with the omp agent.",
			"- **Tasks** — `T-N` kanban. `GET /api/tasks` for state.",
			"- **Routines** — cron / webhook / manual pipelines. `GET /api/routines`.",
			"- **Inbox** — quick-capture surface. `GET /api/inbox`.",
			"- **KB** — this folder. Read via `kb://` URIs or `GET /api/kb/file?path=…`.",
			"- **Skills** — installed under `~/.omp/agent/skills/`.",
			"",
			"## Local API base",
			"",
			"`http://127.0.0.1:8787/api` — reachable from any session via `bash` + `curl`.",
			"",
		].join("\n"),
	},
	{
		dir: "system",
		name: "projects-hub.md",
		body: [
			"---",
			"type: knowledge",
			"tags: [system, projects]",
			"---",
			"",
			"# Active projects",
			"",
			"One-stop list of projects you're actively working on. Cross-reference",
			"with the kanban for in-flight tasks.",
			"",
			"## Example structure",
			"",
			"### project-name",
			"",
			"- **What:** one line",
			"- **Status:** active / paused / done",
			"- **Related tasks:** T-N, T-M",
			"",
		].join("\n"),
	},
	{
		dir: "system",
		name: "org-system-hub.md",
		body: [
			"---",
			"type: knowledge",
			"tags: [system, org]",
			"---",
			"",
			"# Org system hub",
			"",
			"How your work is organized. The agent reads this at session start to",
			"orient. Drop notes here about: where things live, how you triage, what",
			"counts as 'done', anything cross-cutting the agent should default to.",
			"",
		].join("\n"),
	},
];

const KB_RULES_TEMPLATES: ReadonlyArray<KbTemplate> = [
	{ dir: "rules", name: "auto-work.md", body: AUTO_WORK_RULES_BODY },
	{ dir: "rules", name: "branch-naming.md", body: BRANCH_NAMING_RULES_BODY },
];

/** Every template omp-deck knows how to scaffold, `system/` then `rules/`. */
export const KB_TEMPLATES: ReadonlyArray<KbTemplate> = [...KB_SYSTEM_TEMPLATES, ...KB_RULES_TEMPLATES];

/**
 * Idempotently write `README.md` + every entry in `KB_TEMPLATES` under
 * `kbRoot`. Never overwrites an existing file. Safe to call on every boot.
 */
export function seedKbTemplates(kbRoot: string): SeedKbTemplatesResult {
	const result: SeedKbTemplatesResult = { created: [], skipped: [] };

	const readmePath = path.join(kbRoot, "README.md");
	if (!existsSync(readmePath)) {
		try {
			mkdirSync(kbRoot, { recursive: true });
			writeFileSync(readmePath, KB_README_BODY, "utf8");
			result.created.push("README.md");
		} catch (err) {
			log.warn(`failed to write ${readmePath}`, err);
			result.skipped.push("README.md");
		}
	} else {
		result.skipped.push("README.md");
	}

	for (const template of KB_TEMPLATES) {
		const destDir = path.join(kbRoot, template.dir);
		const dest = path.join(destDir, template.name);
		const label = `${template.dir}/${template.name}`;
		if (existsSync(dest)) {
			result.skipped.push(label);
			continue;
		}
		try {
			mkdirSync(destDir, { recursive: true });
			writeFileSync(dest, template.body, "utf8");
			result.created.push(label);
		} catch (err) {
			log.warn(`failed to write ${dest}`, err);
			result.skipped.push(label);
		}
	}

	return result;
}
