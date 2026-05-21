/**
 * maintenance-gate
 *
 * An omp SDK extension that nudges the agent at turn-end (every ~10 turns)
 * to capture the session's reusable output into the canonical OMP folders
 * before the conversation moves on. Synthesizes a follow-up user message
 * containing a structured "Maintenance check" prompt; the agent must either
 * write into a capture path or state the literal phrase
 * "No maintenance needed" to release the check.
 *
 * Adapted from vincitamore/opus-extensions maintenance-gate. Differences:
 *   - Org-root detection is structural (inbox/ + tasks/ + knowledge?/context?
 *     present) instead of hardcoded `documents/opus|materia` substrings.
 *     This makes the gate universal across OMP sessions: any cwd with the
 *     canonical org layout activates the gate.
 *   - Capture detection is path-only (no examen MCP). Watches `write` /
 *     `edit` tool calls for targets under inbox/ tasks/ knowledge/ queries/
 *     context/ reminders/ AND skill SKILL.md writes under .omp/(skills|agent/skills).
 *   - Drops mercury wake / hook-exec logging.
 *   - State file lives at `<orgDir>/.omp/maintenance-gate-state.json`.
 *   - Reminder copy is OMP-native (no principle lattice, no automation-
 *     proposal row — those concepts don't exist in our tree).
 *
 * Tuning constants are env-overridable for fast iteration without redeploy.
 *
 * Installed by omp-deck's StarterExtensionsInstaller into
 * `~/.omp/agent/extensions/maintenance-gate/`. Idempotent — never
 * overwrites a user-edited copy.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Marker phrase the agent uses to release the gate. Case-sensitive on
// purpose so casual prose mentioning "no maintenance needed" doesn't
// accidentally suppress.
const NO_MAINT_PHRASE = "No maintenance needed";

// Heading text the reminder uses. Doubles as the marker the branch-walk
// uses to detect "have we already fired since the last operator message".
const FIRE_MARKER = "## Maintenance check";

// Cadence knobs — env-overridable for tuning without redeploy.
const TRIVIAL_ENTRY_THRESHOLD = envInt("OMP_MAINTENANCE_GATE_TRIVIAL", 10);
const STALENESS_TURNS = envInt("OMP_MAINTENANCE_GATE_STALENESS", 8);
const BRANCH_SCAN_WINDOW = 50;
const FIRE_THROTTLE_MS = envInt("OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS", 5 * 60 * 1000);

// Capture path detection. First-folder segment match against the canonical
// OMP folders. Anchored on start-of-string OR a slash so relative paths
// like `tasks/foo.md` match the same as `C:/.../tasks/foo.md`. Trailing
// slash is mandatory so files at the root with the same name don't trigger.
const CAPTURE_PATH_RE =
	/(?:^|[\/\\])(inbox|tasks|knowledge|queries|context|reminders)[\/\\]/i;

// Skill creation also counts as maintenance. User-level
// (~/.omp/agent/skills) and project-level (<cwd>/.omp/skills) both match.
const SKILL_PATH_RE =
	/[\/\\]\.omp[\/\\](?:agent[\/\\])?skills[\/\\][^\/\\]+[\/\\]SKILL\.md$/i;

type Profile = "active" | "inactive";

interface GateState {
	captureObservedAtTurn: number;
	overrideObservedAtTurn: number;
	lastFireAtTurn: number;
	firingNow: boolean;
	turnCount: number;
}

interface GateDiskState {
	lastFireMs: number;
	lastFireBranchLength: number;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function envInt(name: string, def: number): number {
	const raw = process.env[name];
	if (!raw) return def;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Structural sniff for an OMP org root. Returns the absolute path when the
 * cwd looks like an org tree (or one of its ancestors does), else null.
 *
 * Requires inbox/ + tasks/ AND at least one of (knowledge/, context/).
 * Walks up the directory tree until the root or until a match is found,
 * so deeply-nested sessions still detect the right org root.
 *
 * Override: `OMP_MAINTENANCE_GATE_ROOTS=<csv of absolute paths>` forces
 * specific dirs to be treated as org roots regardless of structure.
 */
function detectOrgRoot(cwd: string): string | null {
	const explicit = (process.env.OMP_MAINTENANCE_GATE_ROOTS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	for (const root of explicit) {
		const normalized = root.replace(/\\/g, "/");
		const cwdNorm = cwd.replace(/\\/g, "/");
		if (cwdNorm === normalized || cwdNorm.startsWith(`${normalized}/`)) return root;
	}

	let cursor = cwd;
	let prev = "";
	while (cursor && cursor !== prev) {
		if (
			existsSync(join(cursor, "inbox")) &&
			existsSync(join(cursor, "tasks")) &&
			(existsSync(join(cursor, "knowledge")) || existsSync(join(cursor, "context")))
		) {
			return cursor;
		}
		prev = cursor;
		cursor = join(cursor, "..");
		// Stop at the filesystem root (path.join with .. on root yields root).
		if (cursor === prev) break;
	}
	return null;
}

function gateStatePath(orgDir: string): string {
	return join(orgDir, ".omp", "maintenance-gate-state.json");
}

function readGateState(orgDir: string): GateDiskState {
	try {
		const path = gateStatePath(orgDir);
		if (!existsSync(path)) return { lastFireMs: 0, lastFireBranchLength: 0 };
		const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<GateDiskState>;
		return {
			lastFireMs: typeof data.lastFireMs === "number" ? data.lastFireMs : 0,
			lastFireBranchLength:
				typeof data.lastFireBranchLength === "number" ? data.lastFireBranchLength : 0,
		};
	} catch {
		return { lastFireMs: 0, lastFireBranchLength: 0 };
	}
}

function writeGateState(orgDir: string, state: GateDiskState): void {
	try {
		const dir = join(orgDir, ".omp");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(gateStatePath(orgDir), JSON.stringify(state, null, 2));
	} catch {
		/* best-effort */
	}
}

function buildReminder(): string {
	return [
		"---",
		"",
		FIRE_MARKER,
		"",
		`About ${STALENESS_TURNS}+ turns since the last capture pass. Did this session produce any of these? Capture **now** — writing to any of the paths below releases this check automatically. If nothing applies, state the literal phrase "${NO_MAINT_PHRASE}" to release.`,
		"",
		"| Signal | Action if present |",
		"|--------|-------------------|",
		"| Reusable insight or pattern | → `knowledge/<subfolder>/<topic>.md` |",
		"| Project status changed | → update `context/current-state.md` |",
		"| New task identified | → `tasks/<name>.md` |",
		"| Question worth preserving | → `queries/<question>.md` |",
		"| Feature idea / future project | → `inbox/ideas/<item>.md` |",
		"| Decision needed | → `inbox/decisions/<item>.md` |",
		"| Bug to investigate | → `inbox/investigations/<item>.md` |",
		"| Quick unsorted capture | → `inbox/captures/<item>.md` |",
		"| New capability learned | → create a skill at `.omp/skills/<name>/SKILL.md` (project) or `~/.omp/agent/skills/<name>/SKILL.md` (user) |",
		"",
		"Be aggressive about capture — lost insights are unrecoverable.",
		"",
		"---",
	].join("\n");
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
	if (depth > 6) return;
	if (value == null) return;
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) collectStrings(v, out, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const v of Object.values(value as Record<string, unknown>)) {
			collectStrings(v, out, depth + 1);
		}
	}
}

function flattenText(value: unknown): string {
	const parts: string[] = [];
	collectStrings(value, parts);
	return parts.join("\n");
}

function extractRole(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const v = value as { role?: unknown; message?: { role?: unknown } };
	if (typeof v.role === "string") return v.role;
	if (v.message && typeof v.message === "object") {
		const r = (v.message as { role?: unknown }).role;
		if (typeof r === "string") return r;
	}
	return null;
}

/**
 * Walk backward through the branch until the most recent user-role message.
 * Return true iff that message is one of the gate's own injections (i.e.
 * we have already fired since the operator's last real prompt).
 *
 * Primary "once-per-operator-turn" suppression — does not depend on closure
 * state and does not care how long the current operator turn runs or how
 * many internal turn_end events fire inside it.
 */
function gateFiredSinceLastOperatorTurn(branch: readonly unknown[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (extractRole(entry) !== "user") continue;
		const text = flattenText(entry);
		return text.includes(FIRE_MARKER);
	}
	return false;
}

/**
 * Count real operator messages (user-role entries that are not gate
 * follow-up injections) at or after `fromIdx`. Used as the load-bearing
 * suppression for the queued-followUp scenario the upstream gate
 * documented: the harness queues sendUserMessage and flushes later;
 * between attempt and persistence, the branch does NOT show the pending
 * fire. Using the on-disk branch-length-at-attempt as the reference is
 * stable across this delay.
 */
function countRealOperatorMsgsAfter(branch: readonly unknown[], fromIdx: number): number {
	let count = 0;
	for (let i = Math.max(0, fromIdx); i < branch.length; i++) {
		const entry = branch[i];
		if (extractRole(entry) !== "user") continue;
		const text = flattenText(entry);
		if (text.includes(FIRE_MARKER)) continue;
		count++;
	}
	return count;
}

/**
 * Rolling-window scan of the branch for the override phrase. Role-gated
 * to assistant messages so the gate's own reminder text (which mentions
 * the phrase as instructional copy) doesn't count as a release.
 */
function branchSaysOverride(branch: readonly unknown[]): boolean {
	const start = Math.max(0, branch.length - BRANCH_SCAN_WINDOW);
	for (let i = branch.length - 1; i >= start; i--) {
		const entry = branch[i];
		if (extractRole(entry) !== "assistant") continue;
		const text = flattenText(entry);
		if (text.includes(NO_MAINT_PHRASE)) return true;
	}
	return false;
}

function messageEndText(event: unknown): string {
	if (extractRole(event) !== "assistant") return "";
	return flattenText(event);
}

function normalizeToolName(name: string): string {
	return name.startsWith("proxy_") ? name.slice("proxy_".length) : name;
}

function pathFromToolInput(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	const candidates = [obj.file_path, obj.path, obj.target, obj.filePath];
	for (const c of candidates) {
		if (typeof c === "string") return c;
	}
	try {
		return JSON.stringify(obj);
	} catch {
		return "";
	}
}

function looksLikeCapture(target: string): boolean {
	return CAPTURE_PATH_RE.test(target) || SKILL_PATH_RE.test(target);
}

// ─── extension entry ───────────────────────────────────────────────────────

export default function maintenanceGate(pi: ExtensionAPI): void {
	let profile: Profile = "inactive";
	let orgDir: string | null = null;

	const state: GateState = {
		captureObservedAtTurn: -1,
		overrideObservedAtTurn: -1,
		lastFireAtTurn: -1,
		firingNow: false,
		turnCount: 0,
	};

	pi.on("session_start", async (_event, ctx) => {
		orgDir = detectOrgRoot(ctx.cwd);
		profile = orgDir ? "active" : "inactive";
		if (orgDir) {
			pi.logger?.info?.(`maintenance-gate: active for org root ${orgDir}`);
		}
	});

	pi.on("tool_call", async (event) => {
		if (profile === "inactive" || !orgDir) return;
		const tn = normalizeToolName(event.toolName);
		if (tn !== "write" && tn !== "edit") return;
		const target = pathFromToolInput(event.input);
		if (target && looksLikeCapture(target)) {
			state.captureObservedAtTurn = state.turnCount;
		}
	});

	pi.on("message_end", async (event) => {
		if (profile === "inactive" || !orgDir) return;
		const text = messageEndText(event);
		if (text && text.includes(NO_MAINT_PHRASE)) {
			state.overrideObservedAtTurn = state.turnCount;
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (profile === "inactive" || !orgDir) return;

		const diskState = readGateState(orgDir);
		const now = Date.now();

		// SAFETY NET 1: wall-clock throttle. Hard upper bound on fire rate
		// independent of any closure state. Covers the race window where
		// sendUserMessage was called but the followUp has not yet appeared
		// anywhere visible.
		if (
			diskState.lastFireMs > 0 &&
			now - diskState.lastFireMs < FIRE_THROTTLE_MS
		) {
			return;
		}

		state.turnCount++;

		// Re-entry guard: the turn_end firing immediately after we
		// synthesize is ours; skip without advancing the cooldown clock.
		if (state.firingNow) {
			state.firingNow = false;
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		if (branch.length < TRIVIAL_ENTRY_THRESHOLD) return;

		// PRIMARY SUPPRESSION: has the operator spoken since our last fire
		// attempt? Disk-stored branch length is stable across the harness's
		// sendUserMessage queue/flush delay; closure state is not.
		const sinceRef =
			diskState.lastFireBranchLength <= branch.length
				? diskState.lastFireBranchLength
				: 0;
		if (sinceRef > 0) {
			const opMsgsSinceLastFire = countRealOperatorMsgsAfter(branch, sinceRef);
			if (opMsgsSinceLastFire === 0) return;
		}

		// SAFETY NET 2: branch walk for most-recent user message. Redundant
		// with the disk-state check in normal operation, but catches the
		// case where disk state was cleared mid-session while the branch
		// already contains a recent followUp.
		if (gateFiredSinceLastOperatorTurn(branch)) return;

		const captureFresh =
			state.captureObservedAtTurn >= 0 &&
			state.turnCount - state.captureObservedAtTurn < STALENESS_TURNS;
		const overrideFresh =
			state.overrideObservedAtTurn >= 0 &&
			state.turnCount - state.overrideObservedAtTurn < STALENESS_TURNS;
		const recentlyFired =
			state.lastFireAtTurn >= 0 &&
			state.turnCount - state.lastFireAtTurn < STALENESS_TURNS;

		if (captureFresh) return;
		if (overrideFresh) return;
		if (recentlyFired) return;

		if (branchSaysOverride(branch)) return;

		const fireStart = Date.now();
		state.firingNow = true;
		const previousLastFireAtTurn = state.lastFireAtTurn;
		state.lastFireAtTurn = state.turnCount;
		writeGateState(orgDir, {
			lastFireMs: fireStart,
			lastFireBranchLength: branch.length,
		});

		try {
			await pi.sendUserMessage(buildReminder(), { deliverAs: "followUp" });
			pi.logger?.info?.(`maintenance-gate: fired at turn ${state.turnCount}`);
		} catch (err) {
			pi.logger?.warn?.(
				`maintenance-gate: sendUserMessage failed: ${(err as Error)?.message ?? String(err)}`,
			);
			state.firingNow = false;
			state.lastFireAtTurn = previousLastFireAtTurn;
			writeGateState(orgDir, diskState);
		}
	});
}
