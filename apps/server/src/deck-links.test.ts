import { describe, expect, test } from "bun:test";

import { buildSessionUrl } from "./deck-links.ts";

describe("buildSessionUrl", () => {
	test("joins base and session id under /c/", () => {
		expect(buildSessionUrl("http://localhost:8787", "abc123")).toBe("http://localhost:8787/c/abc123");
	});

	test("tolerates a trailing slash on the base", () => {
		expect(buildSessionUrl("https://deck.example.com/", "abc123")).toBe("https://deck.example.com/c/abc123");
	});

	test("tolerates multiple trailing slashes on the base", () => {
		expect(buildSessionUrl("https://deck.example.com///", "abc123")).toBe("https://deck.example.com/c/abc123");
	});

	test("URL-encodes the session id", () => {
		expect(buildSessionUrl("http://localhost:8787", "id with spaces")).toBe(
			"http://localhost:8787/c/id%20with%20spaces",
		);
	});
});
