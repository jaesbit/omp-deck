import { describe, expect, test } from "bun:test";

import { combineWithAutoStart } from "./first-prompt";

describe("combineWithAutoStart", () => {
	test("prefixes the configured slash command and leaves one separating space", () => {
		expect(combineWithAutoStart("/start", "Work on T-44")).toBe("/start Work on T-44");
	});

	test("does not synthesize a slash command when auto-start is disabled", () => {
		expect(combineWithAutoStart(null, "Work on T-44")).toBe("Work on T-44");
	});

	test("does not leave a bare auto-start command for an empty message", () => {
		expect(combineWithAutoStart("/start", "   ")).toBe("");
	});
});
