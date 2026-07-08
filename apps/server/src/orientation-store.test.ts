import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DEFAULT_PRELUDE,
	buildDefaultPrelude,
	getEffectivePrelude,
	getPreludeFilePath,
	readMaintenanceGateState,
	readPreludeOverride,
	readStartCommand,
	renderMaintenanceReminder,
	writePreludeOverride,
	writeStartCommand,
} from "./orientation-store.ts";

const ENV_KEYS = [
	"OMP_DECK_DATA_DIR",
	"OMP_DECK_KB_ROOT",
	"OMP_DECK_MAINTENANCE_GATE_DISABLED",
	"OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
	"OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
	"OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
	"OMP_DECK_ORG_ROOT",
];

let saved: Record<string, string | undefined>;
let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">>;
let tmpDataDir: string;
let tmpHomeDir: string;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	tmpDataDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-orient-data-"));
	tmpHomeDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-orient-home-"));
	process.env.OMP_DECK_DATA_DIR = tmpDataDir;
	// Bun's os.homedir() reads the real OS user record and ignores a JS-side
	// process.env.HOME/USERPROFILE reassignment at runtime (confirmed against
	// Bun 1.3.14) — unlike Node, which re-checks the env var on every call.
	// Relying on the env-var override here silently no-ops and lets
	// getStartCommandPath() fall through to the real `~/.omp/agent/commands/
	// start.md`, clobbering the user's actual file with test fixtures. Stub
	// the function itself instead so every orientation-store call under test
	// resolves against the sandboxed tmp dir regardless of runtime env quirks.
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpHomeDir);
	for (const k of ENV_KEYS) {
		if (k !== "OMP_DECK_DATA_DIR") delete process.env[k];
	}
});

afterEach(() => {
	homedirSpy.mockRestore();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("prelude override", () => {
	test("absent override falls back to DEFAULT_PRELUDE", () => {
		expect(readPreludeOverride()).toBeNull();
		expect(getEffectivePrelude()).toBe(DEFAULT_PRELUDE);
	});

	test("write then read round-trips verbatim", () => {
		const text = "# custom prelude\n— em-dash · middle-dot — done\n";
		writePreludeOverride(text);
		expect(readPreludeOverride()).toBe(text);
		expect(getEffectivePrelude()).toBe(text);
		// File matches verbatim on disk (no BOM, no CRLF translation).
		const onDisk = readFileSync(getPreludeFilePath(), "utf8");
		expect(onDisk).toBe(text);
	});

	test("null clears the override and removes the file", () => {
		writePreludeOverride("anything");
		expect(existsSync(getPreludeFilePath())).toBe(true);
		writePreludeOverride(null);
		expect(existsSync(getPreludeFilePath())).toBe(false);
		expect(getEffectivePrelude()).toBe(DEFAULT_PRELUDE);
	});

	test("clearing an already-absent override is a no-op", () => {
		expect(() => writePreludeOverride(null)).not.toThrow();
		expect(readPreludeOverride()).toBeNull();
	});
});

describe("buildDefaultPrelude", () => {
	test("returns DEFAULT_PRELUDE when no KB files exist", () => {
		// The system directory is absent, so there are no readable Markdown files.
		expect(buildDefaultPrelude()).toBe(DEFAULT_PRELUDE);
	});

	test("inlines every top-level Markdown file in deterministic filename order", () => {
		const kbSystemDir = path.join(tmpHomeDir, "kb", "system");
		mkdirSync(kbSystemDir, { recursive: true });
		// Deliberately create these out of filename order. The arbitrary filename
		// proves discovery is not limited to a predefined set of system files.
		const files = [
			["working-voice.md", "# Voice\nvoice-content\n"],
			["projects-hub.md", "# Projects\nprojects-content\n"],
			["arbitrary-guidance.md", "---\ntype: k\n---\n# Arbitrary\narbitrary-content\n"],
			["org-system-hub.md", "# Org\norg-content\n"],
			["deck-orientation.md", "# Deck\ndeck-content\n"],
		] as const;
		for (const [filename, content] of files) {
			writeFileSync(path.join(kbSystemDir, filename), content);
		}

		const result = buildDefaultPrelude();
		expect(result).toContain("# Arbitrary\narbitrary-content");
		expect(result).not.toContain("---\ntype: k\n---");
		expect(result).toBe(
			[
				"# Arbitrary\narbitrary-content\n",
				"# Deck\ndeck-content\n",
				"# Org\norg-content\n",
				"# Projects\nprojects-content\n",
				"# Voice\nvoice-content\n",
			].join("\n") +
				"\n" +
				DEFAULT_PRELUDE,
		);
	});

	test("ignores non-Markdown files and Markdown files below subdirectories", () => {
		const kbSystemDir = path.join(tmpHomeDir, "kb", "system");
		const nestedDir = path.join(kbSystemDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(kbSystemDir, "working-voice.md"), "# Voice\nvoice-content\n");
		writeFileSync(path.join(kbSystemDir, "notes.txt"), "non-markdown-content\n");
		writeFileSync(path.join(nestedDir, "nested.md"), "nested-markdown-content\n");

		const result = buildDefaultPrelude();
		expect(result).toBe("# Voice\nvoice-content\n\n" + DEFAULT_PRELUDE);
		expect(result).not.toContain("non-markdown-content");
		expect(result).not.toContain("nested-markdown-content");
	});

	test("skips a Markdown path that cannot be read as a file and includes readable files", () => {
		const kbSystemDir = path.join(tmpHomeDir, "kb", "system");
		mkdirSync(path.join(kbSystemDir, "deck-orientation.md"), { recursive: true });
		writeFileSync(path.join(kbSystemDir, "working-voice.md"), "# Voice\nvoice-content\n");

		expect(buildDefaultPrelude()).toBe("# Voice\nvoice-content\n\n" + DEFAULT_PRELUDE);
	});

	test("getEffectivePrelude returns buildDefaultPrelude output when no override", () => {
		const kbSystemDir = path.join(tmpHomeDir, "kb", "system");
		mkdirSync(kbSystemDir, { recursive: true });
		writeFileSync(path.join(kbSystemDir, "working-voice.md"), "# Voice\nvoice-content\n");

		const result = getEffectivePrelude();
		expect(result).toContain("voice-content");
		expect(result).toContain(DEFAULT_PRELUDE);
	});

	test("getEffectivePrelude prefers override over KB content", () => {
		const kbSystemDir = path.join(tmpHomeDir, "kb", "system");
		mkdirSync(kbSystemDir, { recursive: true });
		writeFileSync(path.join(kbSystemDir, "working-voice.md"), "# Voice\nvoice-content\n");
		writePreludeOverride("# custom override");

		expect(getEffectivePrelude()).toBe("# custom override");
	});
});

describe("start command", () => {
	test("missing file returns exists=false with empty fields", () => {
		const cmd = readStartCommand();
		expect(cmd.exists).toBe(false);
		expect(cmd.description).toBe("");
		expect(cmd.body).toBe("");
		expect(cmd.path.endsWith(path.join(".omp", "agent", "commands", "start.md"))).toBe(true);
	});

	test("write + read round-trips description and body verbatim", () => {
		const desc = "Orient — load context, then list";
		const body = "Line 1\nLine 2 with — em-dash\n";
		writeStartCommand(desc, body);
		const cmd = readStartCommand();
		expect(cmd.exists).toBe(true);
		expect(cmd.description).toBe(desc);
		expect(cmd.body).toBe(body);
	});

	test("empty description omits the frontmatter block", () => {
		writeStartCommand("", "just body content\n");
		const onDisk = readFileSync(readStartCommand().path, "utf8");
		expect(onDisk.startsWith("---")).toBe(false);
		expect(onDisk).toBe("just body content\n");
		const cmd = readStartCommand();
		expect(cmd.description).toBe("");
		expect(cmd.body).toBe("just body content\n");
	});

	test("reads existing frontmatter without description as empty", () => {
		const target = readStartCommand().path;
		const dir = path.dirname(target);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			target,
			`---\nargs: ["x"]\n---\nbody here\n`,
			{ encoding: "utf8", flag: "w" },
		);
		expect(existsSync(dir)).toBe(true);
		const cmd = readStartCommand();
		expect(cmd.description).toBe("");
		expect(cmd.body).toBe("body here\n");
	});

	test("strips surrounding quotes from a quoted description", () => {
		const target = readStartCommand().path;
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(
			target,
			`---\ndescription: "Quoted summary"\n---\nbody\n`,
			{ encoding: "utf8", flag: "w" },
		);
		expect(readStartCommand().description).toBe("Quoted summary");
	});
});

describe("maintenance gate state", () => {
	test("defaults to enabled with all knobs at compiled defaults", () => {
		const state = readMaintenanceGateState();
		expect(state.enabled).toBe(true);
		expect(state.knobs.minOpMsgs.value).toBe(4);
		expect(state.knobs.minOpMsgs.source).toBe("default");
		expect(state.knobs.minReleaseAgeMs.value).toBe(8 * 60_000);
		expect(state.knobs.fireFloorMs.value).toBe(25 * 60_000);
		expect(state.orgRoot).toBeNull();
	});

	test("OMP_DECK_MAINTENANCE_GATE_DISABLED=1 reports enabled=false", () => {
		process.env.OMP_DECK_MAINTENANCE_GATE_DISABLED = "1";
		const state = readMaintenanceGateState();
		expect(state.enabled).toBe(false);
		expect(state.disabledRaw).toBe("1");
		expect(state.disabledSource).toBe("process-env");
	});

	test("non-truthy disable values leave the gate enabled", () => {
		for (const value of ["", "0", "false", "no", "off"]) {
			process.env.OMP_DECK_MAINTENANCE_GATE_DISABLED = value;
			const state = readMaintenanceGateState();
			expect(state.enabled).toBe(true);
		}
	});

	test("knob override surfaces in value/source/raw", () => {
		process.env.OMP_MAINTENANCE_GATE_MIN_OP_MSGS = "7";
		const state = readMaintenanceGateState();
		expect(state.knobs.minOpMsgs.value).toBe(7);
		expect(state.knobs.minOpMsgs.rawValue).toBe("7");
		expect(state.knobs.minOpMsgs.source).toBe("process-env");
	});

	test("invalid knob falls back to default but keeps raw + source", () => {
		process.env.OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS = "not-a-number";
		const state = readMaintenanceGateState();
		expect(state.knobs.fireFloorMs.value).toBe(25 * 60_000);
		expect(state.knobs.fireFloorMs.rawValue).toBe("not-a-number");
		expect(state.knobs.fireFloorMs.source).toBe("process-env");
	});

	test("preview tables differ across profiles in the expected places", () => {
		const deck = renderMaintenanceReminder("deck");
		const flat = renderMaintenanceReminder("flat-file");
		expect(deck).toContain("POST /api/inbox");
		expect(deck).toContain("kb://system/");
		expect(deck).not.toContain("knowledge/<subfolder>");
		expect(flat).toContain("inbox/captures/<item>.md");
		expect(flat).not.toContain("POST /api/inbox");
	});
});
