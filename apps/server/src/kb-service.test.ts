import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveProjectBranchPolicy } from "./kb-service.ts";

let fixtureRoot: string;
let kbRoot: string;
let workspaceRoot: string;

function writeProjectPolicy(relativePath: string, projectRoot: string, baseBranch: string): string {
	const sourcePath = path.join(kbRoot, "projects", relativePath);
	mkdirSync(path.dirname(sourcePath), { recursive: true });
	writeFileSync(sourcePath, `---\nprojectRoot: ${projectRoot}\nbaseBranch: ${baseBranch}\n---\n# Project policy\n`, "utf8");
	return sourcePath;
}

beforeEach(() => {
	fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-project-policy-"));
	kbRoot = path.join(fixtureRoot, "kb");
	workspaceRoot = path.join(fixtureRoot, "repo");
});

afterEach(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("resolveProjectBranchPolicy", () => {
	test("ignores a malformed deepest policy and selects the valid enclosing policy", async () => {
		writeProjectPolicy("parent.md", workspaceRoot, "main");
		const nestedPolicyPath = writeProjectPolicy("nested/project.md", path.join(workspaceRoot, "apps"), "devel");
		writeProjectPolicy("nested/invalid.md", path.join(workspaceRoot, "apps", "server"), "release./hotfix");

		const policy = await resolveProjectBranchPolicy(
			path.join(workspaceRoot, "apps", "server", ".worktrees", "aw-T1-policy-test"),
			kbRoot,
		);

		expect(policy).toEqual({
			projectRoot: path.join(workspaceRoot, "apps"),
			baseBranch: "devel",
			sourcePath: nestedPolicyPath,
		});
	});
});
