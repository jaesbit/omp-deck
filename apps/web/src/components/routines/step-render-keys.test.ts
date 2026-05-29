import { describe, expect, test } from "bun:test";

import {
	appendStepRenderKey,
	makeStepRenderKeys,
	moveStepRenderKey,
	reconcileStepRenderKeys,
	removeStepRenderKey,
} from "./step-render-keys";

function factory(): () => string {
	let n = 0;
	return () => `k${n++}`;
}

describe("routine step render keys", () => {
	test("preserves keys when editable step ids change without changing list length", () => {
		const create = factory();
		const initial = makeStepRenderKeys(3, create);

		expect(reconcileStepRenderKeys(initial, 3, create)).toEqual(initial);
	});

	test("appends and removes keys at the same positions as step edits", () => {
		const create = factory();
		const initial = makeStepRenderKeys(2, create);

		expect(appendStepRenderKey(initial, create)).toEqual(["k0", "k1", "k2"]);
		expect(removeStepRenderKey(["k0", "k1", "k2"], 1)).toEqual(["k0", "k2"]);
	});

	test("moves keys with their step so local card state does not stick to positions", () => {
		expect(moveStepRenderKey(["first", "second", "third"], 2, 0)).toEqual([
			"third",
			"first",
			"second",
		]);
	});
});
