/**
 * Tests for `InProcessAgentBridge.deleteSession` (T-47). Covers the two
 * resolution branches — a live in-memory handle, and a persisted-only
 * session with no live handle — plus the unknown-id case.
 *
 * The SDK's `SessionManager.listAll()` hardwires its scan root to the real
 * `~/.omp/agent/sessions` (see `listAllSessions` in
 * `@oh-my-pi/pi-coding-agent/src/session/session-listing.ts`), with no way to
 * redirect it to a temp dir. To keep this suite from touching the real home
 * directory, the persisted-only case exercises a subclass that overrides the
 * `protected listAllSessionsForDelete()` seam with a fixture pointing at a
 * real file under a temp dir — the actual file-deletion behavior (via
 * `SessionManager.open().dropSession()`) is still exercised for real.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { SessionSummary } from "@omp-deck/protocol";

import { InProcessAgentBridge, InProcessSessionHandle } from "./in-process.ts";

let tmpDir: string;
let sessionDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-delete-session-"));
	sessionDir = path.join(tmpDir, "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a real, on-disk session file under the temp sessionDir (never the real home dir). */
async function createRealSessionFile(): Promise<{ id: string; filePath: string }> {
	const manager = SessionManager.create(tmpDir, sessionDir);
	await manager.ensureOnDisk();
	const id = manager.getSessionId();
	const filePath = manager.getSessionFile();
	if (!filePath) throw new Error("expected a session file after ensureOnDisk()");
	return { id, filePath };
}

/**
 * Registers a minimal `Active` entry directly into the bridge's private
 * `active` map — the same map `attach()` populates — so `deleteSession`'s
 * live-handle branch has something to find. `dispose()` mimics the real
 * `onDispose` callback's `active.delete(sessionId)` eviction.
 */
function registerFakeActive(
	bridge: InProcessAgentBridge,
	id: string,
	sessionFile: string,
): { disposed: boolean } {
	const state = { disposed: false };
	const handle = {
		sessionId: id,
		sessionFile,
		cwd: tmpDir,
		async dispose() {
			state.disposed = true;
			(bridge as unknown as { active: Map<string, unknown> }).active.delete(id);
		},
	} as unknown as InProcessSessionHandle;
	(bridge as unknown as { active: Map<string, unknown> }).active.set(id, { handle });
	return state;
}

/** Subclass overriding the persisted-listing seam with a fixture instead of scanning ~/.omp. */
class FixtureBridge extends InProcessAgentBridge {
	constructor(private readonly fixture: SessionSummary[]) {
		super({ idleTimeoutMs: 0 });
	}
	protected override listAllSessionsForDelete(): Promise<SessionSummary[]> {
		return Promise.resolve(this.fixture);
	}
}

describe("InProcessAgentBridge.deleteSession", () => {
	test("live session: disposes the handle, evicts it from `active`, and drops the file from disk", async () => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const { id, filePath } = await createRealSessionFile();
		expect(fs.existsSync(filePath)).toBe(true);
		const state = registerFakeActive(bridge, id, filePath);

		const result = await bridge.deleteSession(id);

		expect(result).toEqual({ deleted: true, sessionPath: filePath });
		expect(state.disposed).toBe(true);
		expect(bridge.getSession(id)).toBeUndefined();
		expect(fs.existsSync(filePath)).toBe(false);
	});

	test("persisted-only session (no live handle): resolves via the listing and drops the file", async () => {
		const { id, filePath } = await createRealSessionFile();
		expect(fs.existsSync(filePath)).toBe(true);
		const bridge = new FixtureBridge([
			{ id, path: filePath, cwd: tmpDir } as SessionSummary,
		]);

		const result = await bridge.deleteSession(id);

		expect(result).toEqual({ deleted: true, sessionPath: filePath });
		expect(fs.existsSync(filePath)).toBe(false);
	});

	test("unknown id: neither a live handle nor a persisted-listing match -> deleted: false", async () => {
		const bridge = new FixtureBridge([]);

		const result = await bridge.deleteSession("does-not-exist");

		expect(result).toEqual({ deleted: false });
	});

	test("idempotent: deleting an id whose file was already removed still reports success", async () => {
		const { id, filePath } = await createRealSessionFile();
		fs.rmSync(filePath);
		const bridge = new FixtureBridge([
			{ id, path: filePath, cwd: tmpDir } as SessionSummary,
		]);

		const result = await bridge.deleteSession(id);

		expect(result).toEqual({ deleted: true, sessionPath: filePath });
	});
});
