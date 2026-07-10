import { describe, expect, test } from "bun:test"

import { formatDurationMs, formatTimestamp } from "./utils"

describe("formatDurationMs", () => {
	const cases = [
		{ name: "milliseconds", input: 999, expected: "999ms" },
		{ name: "seconds", input: 1_500, expected: "1.5s" },
		{ name: "minutes", input: 65_000, expected: "1m 5s" },
		{ name: "zero milliseconds", input: 0, expected: "0ms" },
	]

	for (const { name, input, expected } of cases) {
		test(`formats ${name}`, () => {
			expect(formatDurationMs(input)).toBe(expected)
		})
	}

	test("uses an em dash for invalid or negative durations", () => {
		for (const input of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(formatDurationMs(input)).toBe("—")
		}
	})
})

describe("formatTimestamp", () => {
	test("renders a valid ISO timestamp as an absolute date and time", () => {
		const localDate = new Date(2020, 0, 2, 12, 34, 0)
		const formatted = formatTimestamp(localDate.toISOString())
		const monthDay = localDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })
		const time = localDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

		expect(formatted).toBe(`${monthDay} 2020, ${time}`)
	})

	test("returns an invalid timestamp unchanged", () => {
		expect(formatTimestamp("not-a-date")).toBe("not-a-date")
	})
})
