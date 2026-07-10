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
	renderMaintenanceReminder,
	writePreludeOverride,
} from "./orientation-store.ts";

const ENV_KEYS = [
	"OMP_DECK_DATA_DIR",
	"OMP_DECK_KB_ROOT",
	"OMP_DECK_MAINTENANCE_GATE_DISABLED",
	"OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
	"OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
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

	test("includes task lookup and direct greeting instructions without slash start", () => {
		const result = buildDefaultPrelude();
		expect(result).toContain("GET /api/tasks?cwd=<url-encoded session cwd>");
        expect(result).toContain("Greet the user directly");
		expect(result).not.toContain("/start");
	});
    test("uses the configured API port and keeps personal system notes out of the scaffold", () => {
        const configuredPort = Number.parseInt(process.env.OMP_DECK_PORT?.trim() ?? "", 10);
        const expectedPort = Number.isFinite(configuredPort) ? configuredPort : 8787;
        expect(DEFAULT_PRELUDE).toContain(`Local API base: http://127.0.0.1:${expectedPort}/api`);
        for (const personalHeading of ["# Working voice", "# Active projects", "# Org system hub", "# Rules index", "# Search performance"]) {
            expect(DEFAULT_PRELUDE).not.toContain(personalHeading);
        }
    });
	test("inlines every top-level Markdown file in deterministic filename order", () => {
		const kbSystemDir = path.join(tmpHomeDir, "kb", "system");
		mkdirSync(kbSystemDir, { recursive: true });
        // Deliberately create these out of filename order. The custom filename
        // proves discovery is not limited to a predefined set of system files.
        const files = [
            ["working-voice.md", "# Voice\nvoice-content\n"],
            ["projects-hub.md", "# Projects\nprojects-content\n"],
            ["custom.md", "---\ntype: k\n---\n# Custom\ncustom-content\n"],
            ["org-system-hub.md", "# Org\norg-content\n"],
            ["deck-orientation.md", "# Deck\ndeck-content\n"],
            ["rules-index.md", "# Rules\nrules-index-content\n"],
            ["search-performance.md", "# Search\nsearch-performance-content\n"],
        ] as const;
		for (const [filename, content] of files) {
			writeFileSync(path.join(kbSystemDir, filename), content);
		}

		const result = buildDefaultPrelude();
        expect(result).toContain("# Custom\ncustom-content");
        expect(result).not.toContain("---\ntype: k\n---");
        expect(result).toBe(
            [
                "# Custom\ncustom-content\n",
                "# Deck\ndeck-content\n",
                "# Org\norg-content\n",
                "# Projects\nprojects-content\n",
                "# Rules\nrules-index-content\n",
                "# Search\nsearch-performance-content\n",
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

    test("injects a newly added top-level system document without code changes", () => {
        const kbSystemDir = path.join(tmpHomeDir, "kb", "system");
        mkdirSync(kbSystemDir, { recursive: true });
        writeFileSync(path.join(kbSystemDir, "custom.md"), "# Custom system rule\ncustom-injection-content\n");

        const result = getEffectivePrelude();

        expect(result).toContain("Every top-level file under `kb://system/` is injected as a hard system rule.");
        expect(result).toContain("### custom");
        expect(result).toContain("# Custom system rule\ncustom-injection-content");
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
