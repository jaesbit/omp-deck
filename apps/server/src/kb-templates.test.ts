import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { seedKbTemplates } from "./kb-templates.ts"

/** A KB root path that does not exist on disk yet, inside a fresh tmp dir. */
function freshKbRoot(): string {
	const parent = mkdtempSync(path.join(os.tmpdir(), "omp-deck-kb-templates-"))
	return path.join(parent, "kb")
}

const INTERNAL_INTEGRATION_NAMES = [
	"auto-work",
	"branch-naming",
	"task-rewrite",
	"session-title",
	"auto-work-task-selection",
	"auto-work-squeeze",
] as const

const AGENT_FACING_INTEGRATION_NAMES = ["tasks", "routines", "inbox"] as const
const INTEGRATION_NAMES = [...INTERNAL_INTEGRATION_NAMES, ...AGENT_FACING_INTEGRATION_NAMES]

const INTEGRATION_LABELS = INTEGRATION_NAMES.map((name) => `integrations/${name}.md`)

describe("seedKbTemplates", () => {
	test("creates six internal and three agent-facing base integrations, without the obsolete parent-folder system rule", () => {
		const kbRoot = freshKbRoot()

		const result = seedKbTemplates(kbRoot)

		expect(result.created.filter((label) => label.startsWith("integrations/")).sort()).toEqual(
			INTEGRATION_LABELS.slice().sort(),
		)
		for (const label of INTEGRATION_LABELS) {
			expect(existsSync(path.join(kbRoot, label))).toBe(true)
		}
		expect(existsSync(path.join(kbRoot, "system", "parent-folder-rules.md"))).toBe(false)
	})

})
