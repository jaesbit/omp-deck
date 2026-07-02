import { describe, expect, test } from "bun:test";

import { projectColorForCwd, updateProjectColors } from "./project-colors";

describe("project colors", () => {
	test("returns a configured color only for its exact workspace", () => {
		const colors = { "/work/a": "#15803d" };
		expect(projectColorForCwd("/work/a", colors)).toBe("#15803d");
		expect(projectColorForCwd("/work/b", colors)).toBeUndefined();
		expect(projectColorForCwd(undefined, colors)).toBeUndefined();
	});

	test("adds, replaces, and removes an explicit workspace mapping", () => {
		const added = updateProjectColors({}, "/work/a", "#15803d");
		expect(added).toEqual({ "/work/a": "#15803d" });

		const replaced = updateProjectColors(added, "/work/a", "#0e7490");
		expect(replaced).toEqual({ "/work/a": "#0e7490" });

		expect(updateProjectColors(replaced, "/work/a", undefined)).toEqual({});
	});

	test("does not create a mapping from an invalid color", () => {
		const colors = { "/work/a": "#15803d" };
		expect(updateProjectColors(colors, "/work/b", "blue")).toBe(colors);
	});
});
