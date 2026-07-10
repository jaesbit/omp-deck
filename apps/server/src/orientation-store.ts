/**
 * Orientation store
 *
 * Two artifacts shape every deck session: the prelude (system-prompt block
 * prepended at session create) and the maintenance-gate config (when/how the
 * gate nudges the agent to capture work). This module is the source of truth
 * for reading and writing both from outside the bridge.
 *
 * Persistence:
 *   - Prelude override → `<dataDir>/prelude.md` (deck-managed file). Absence
 *     means "fall back to `buildDefaultPrelude()` (kb://system files + scaffold)".
 *   - Maintenance-gate → managed env file via `env-store.ts`.
 *
 * Read on each call rather than caching — these artifacts change infrequently
 * and the cost is one stat + small read per `createAgentSession`.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getDataDir, readManagedEnvFile } from "./env-store.ts";
import { resolveKbRoot } from "./kb-service.ts";

/**
 * Minimal system-prompt context for sessions created by omp-deck. It identifies
 * the local API and its three primary surfaces.
 */
const DEFAULT_DECK_PORT = 8787;

function getDeckPort(): number {
	const configured = process.env.OMP_DECK_PORT?.trim();
	if (!configured) return DEFAULT_DECK_PORT;
	const port = Number.parseInt(configured, 10);
	return Number.isFinite(port) ? port : DEFAULT_DECK_PORT;
}

export const DEFAULT_PRELUDE = `# omp-deck context

You are running inside an omp-deck session. It provides a local API for
tasks, routines, and inbox items.

Local API base: http://127.0.0.1:${getDeckPort()}/api. Use \`bash\` with
\`curl\` to reach it.

At the start of each request, query
\`GET /api/tasks?cwd=<url-encoded session cwd>\` and use those tasks as context.
Greet the user directly and proceed without ceremonial preamble. Use the local
API for tasks, routines, and inbox operations. Read the relevant documents under
\`kb://integrations/\`, including \`kb://integrations/auto-work.md\` for Auto Work.
Before mutating, fetch current state, then briefly confirm successful changes.

`;
/**
 * Builds the default prelude by reading every top-level Markdown file under
 * `kb://system/` in deterministic filename order and prepending their content
 * as inlined hard rules before the structural API-reference scaffold
 * (`DEFAULT_PRELUDE`).
 *
 * Missing directories and individually unreadable files are skipped. If no
 * readable, non-empty Markdown content remains, the result equals
 * `DEFAULT_PRELUDE` exactly.
 *
 * Called at session-create time by `getEffectivePrelude()` so content is
 * always fresh relative to the most recent KB edit without needing a restart.
 */
export function buildDefaultPrelude(): string {
	const systemDir = path.join(resolveKbRoot(), "system");
	let filenames: string[];
	try {
		filenames = readdirSync(systemDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return DEFAULT_PRELUDE;
	}

	const sections: string[] = [];
	for (const filename of filenames) {
		try {
			const section = stripFrontmatter(readFileSync(path.join(systemDir, filename), "utf8"));
			if (section) sections.push(section);
		} catch {
			// One unreadable file must not suppress the remaining system rules.
		}
	}

	if (sections.length === 0) return DEFAULT_PRELUDE;
	return sections.join("\n") + "\n" + DEFAULT_PRELUDE;
}

// ─── prelude ───────────────────────────────────────────────────────────────

export function getPreludeFilePath(): string {
	return path.join(getDataDir(), "prelude.md");
}

export function readPreludeOverride(): string | null {
	const p = getPreludeFilePath();
	try {
		return readFileSync(p, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/** `null` clears the override; the next read returns `buildDefaultPrelude()`. */
export function writePreludeOverride(value: string | null): void {
	const p = getPreludeFilePath();
	if (value === null) {
		try {
			unlinkSync(p);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		return;
	}
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, value, "utf8");
}

/**
 * Effective text the bridge prepends to every session's system prompt.
 *
 * Reads the `kb://system/*.md` canonical orientation files from the configured
 * KB root and inlines them as hard system-prompt rules. The override file
 * (`<dataDir>/prelude.md`) takes priority and is returned verbatim, with NO
 * KB injection — when a user explicitly hand-writes a prelude, respect it
 * and don't second-guess by also pasting the orientation files in.
 */
export function getEffectivePrelude(): string {
	const override = readPreludeOverride();
	if (override !== null) return override;
	return DEFAULT_PRELUDE + buildKbSystemInjection();
}

/**
 * Every top-level Markdown file under `kb://system/` is injected as a hard
 * system-prompt rule. The directory is enumerated at runtime so new system
 * documents do not require a code change.
 */
function buildKbSystemInjection(): string {
	const root = resolveKbRoot();
	const systemDir = path.join(root, "system");
	let filenames: string[];
	try {
		filenames = readdirSync(systemDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return "";
	}

	const parts: string[] = [
		"",
		"---",
		"",
		"Every top-level file under `kb://system/` is injected as a hard system rule.",
		"Apply these rules as part of the system prompt.",
		"",
	];
	let injectedCount = 0;
	for (const filename of filenames) {
		let body: string;
		try {
			body = readFileSync(path.join(systemDir, filename), "utf8");
		} catch {
			continue;
		}
		const stripped = stripFrontmatter(body).trim();
		if (!stripped) continue;
		parts.push(`### ${filename.slice(0, -3)}`, "", stripped, "", "");
		injectedCount += 1;
	}
	return injectedCount > 0 ? parts.join("\n") : "";
}

/** Strip a single YAML frontmatter block (`---\n...\n---`) if present. */
function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return text;
	const startOffset = 4;
	const eol = text.startsWith("---\r\n") ? "\r\n" : "\n";
	const closeMarker = `\n---${eol}`;
	const endIdx = text.indexOf(closeMarker, startOffset);
	if (endIdx < 0) return text;
	const after = text.slice(endIdx + closeMarker.length);
	// Drop a single leading blank line so we don't end up with double blanks.
	return after.replace(/^\r?\n/, "");
}



// ─── maintenance-gate ──────────────────────────────────────────────────────

export const MAINTENANCE_GATE_DEFAULTS = {
	minOpMsgs: 4,
	minReleaseAgeMs: 8 * 60_000,
	fireFloorMs: 25 * 60_000,
} as const;

export const MAINTENANCE_GATE_ENV_KEYS = {
	disabled: "OMP_DECK_MAINTENANCE_GATE_DISABLED",
	minOpMsgs: "OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
	minReleaseAgeMs: "OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
	fireFloorMs: "OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
	orgRoot: "OMP_DECK_ORG_ROOT",
} as const;

export type GateValueSource = "process-env" | "env-file" | "default" | "unset";

export interface GateKnob {
	value: number;
	default: number;
	rawValue: string | null;
	source: GateValueSource;
}

export interface MaintenanceGateState {
	enabled: boolean;
	disabledRaw: string | null;
	disabledSource: GateValueSource;
	knobs: {
		minOpMsgs: GateKnob;
		minReleaseAgeMs: GateKnob;
		fireFloorMs: GateKnob;
	};
	orgRoot: string | null;
	orgRootSource: GateValueSource;
	/** Whether the installed extension copy still exists on disk. */
	installedExtensionPresent: boolean;
	installedExtensionPath: string;
	/** Server-side render of the at-turn-end reminder so the UI can preview it. */
	preview: { deckMode: string; flatFileMode: string };
}

export function readMaintenanceGateState(): MaintenanceGateState {
	const file = readManagedEnvFile();
	const resolve = (key: string): { rawValue: string | null; source: GateValueSource } => {
		const processValue = process.env[key];
		const fileValue = file.values.get(key);
		if (processValue !== undefined && processValue !== fileValue) {
			return { rawValue: processValue, source: "process-env" };
		}
		if (fileValue !== undefined) return { rawValue: fileValue, source: "env-file" };
		if (processValue !== undefined) return { rawValue: processValue, source: "process-env" };
		return { rawValue: null, source: "unset" };
	};
	const intKnob = (key: string, def: number): GateKnob => {
		const { rawValue, source } = resolve(key);
		if (rawValue === null || rawValue === "") {
			return { value: def, default: def, rawValue: null, source: "default" };
		}
		const n = Number.parseInt(rawValue, 10);
		if (!Number.isFinite(n) || n <= 0) {
			return { value: def, default: def, rawValue, source };
		}
		return { value: n, default: def, rawValue, source };
	};

	const disabled = resolve(MAINTENANCE_GATE_ENV_KEYS.disabled);
	const orgRoot = resolve(MAINTENANCE_GATE_ENV_KEYS.orgRoot);
	const enabled = !isTruthy(disabled.rawValue);

	const installedExtensionPath = path.join(
		os.homedir(),
		".omp",
		"agent",
		"extensions",
		"maintenance-gate",
		"index.ts",
	);

	return {
		enabled,
		disabledRaw: disabled.rawValue,
		disabledSource: disabled.source,
		knobs: {
			minOpMsgs: intKnob(MAINTENANCE_GATE_ENV_KEYS.minOpMsgs, MAINTENANCE_GATE_DEFAULTS.minOpMsgs),
			minReleaseAgeMs: intKnob(
				MAINTENANCE_GATE_ENV_KEYS.minReleaseAgeMs,
				MAINTENANCE_GATE_DEFAULTS.minReleaseAgeMs,
			),
			fireFloorMs: intKnob(
				MAINTENANCE_GATE_ENV_KEYS.fireFloorMs,
				MAINTENANCE_GATE_DEFAULTS.fireFloorMs,
			),
		},
		orgRoot: orgRoot.rawValue,
		orgRootSource: orgRoot.source,
		installedExtensionPresent: existsSync(installedExtensionPath),
		installedExtensionPath,
		preview: {
			deckMode: renderMaintenanceReminder("deck"),
			flatFileMode: renderMaintenanceReminder("flat-file"),
		},
	};
}

function isTruthy(value: string | null | undefined): boolean {
	if (!value) return false;
	const lower = value.trim().toLowerCase();
	return ["1", "true", "yes", "on"].includes(lower);
}

/**
 * Server-side mirror of the maintenance-gate extension's `buildReminder()`.
 * Lives here so the deck UI can preview both profiles without reaching into
 * the installed extension. If `starter-extensions/maintenance-gate/index.ts`
 * changes the row table, update both sides — they are intentionally a
 * format contract (see kb://system/format-contracts-not-register-contracts).
 */
export function renderMaintenanceReminder(profile: "deck" | "flat-file"): string {
	const deckMode = profile === "deck";
	const rows: [string, string][] = deckMode
		? [
				["Reusable insight or pattern", "→ `kb://system/<topic>.md`"],
				[
					"Project status changed",
					"→ `POST /api/inbox` with `kind: \"capture\"` describing the change; daily briefing reconciles into `kb://system/projects-hub.md`",
				],
				["New task identified", "→ `POST /api/tasks`"],
				[
					"Question worth preserving",
					"→ `POST /api/inbox` with `kind: \"capture\"` (or `kind: \"investigation\"` if you intend to follow up)",
				],
				["Feature idea / future project", "→ `POST /api/inbox` with `kind: \"idea\"`"],
				["Decision needed", "→ `POST /api/inbox` with `kind: \"decision\"`"],
				["Bug to investigate", "→ `POST /api/inbox` with `kind: \"investigation\"`"],
				["Quick unsorted capture", "→ `POST /api/inbox` with `kind: \"capture\"`"],
				[
					"New capability learned",
					"→ create a skill at `.omp/skills/<name>/SKILL.md` (project) or `~/.omp/agent/skills/<name>/SKILL.md` (user)",
				],
			]
		: [
				["Reusable insight or pattern", "→ `knowledge/<subfolder>/<topic>.md`"],
				["Project status changed", "→ update `context/current-state.md`"],
				["New task identified", "→ `tasks/<name>.md`"],
				["Question worth preserving", "→ `queries/<question>.md`"],
				["Feature idea / future project", "→ `inbox/ideas/<item>.md`"],
				["Decision needed", "→ `inbox/decisions/<item>.md`"],
				["Bug to investigate", "→ `inbox/investigations/<item>.md`"],
				["Quick unsorted capture", "→ `inbox/captures/<item>.md`"],
				[
					"New capability learned",
					"→ create a skill at `.omp/skills/<name>/SKILL.md` (project) or `~/.omp/agent/skills/<name>/SKILL.md` (user)",
				],
			];
	const releaseClause = deckMode
		? "invoking any of the REST endpoints below (or writing to one of the listed paths)"
		: "writing to any of the paths below";

	return [
		"---",
		"",
		"## Maintenance check",
		"",
		`Did this segment of work produce any of the signals below? Capture **now** — ${releaseClause} releases this check automatically. If nothing applies, state the literal phrase "No maintenance needed" to release.`,
		"",
		"| Signal | Action if present |",
		"|--------|-------------------|",
		...rows.map(([signal, action]) => `| ${signal} | ${action} |`),
		"",
		"Be aggressive about capture — lost insights are unrecoverable.",
		"",
		"---",
	].join("\n");
}
