export type StepRenderKeyFactory = () => string;

export function makeStepRenderKeys(count: number, create: StepRenderKeyFactory): string[] {
	return reconcileStepRenderKeys([], count, create);
}

export function reconcileStepRenderKeys(
	previous: readonly string[],
	nextCount: number,
	create: StepRenderKeyFactory,
): string[] {
	const next = previous.slice(0, nextCount);
	while (next.length < nextCount) next.push(create());
	return next;
}

export function appendStepRenderKey(previous: readonly string[], create: StepRenderKeyFactory): string[] {
	return [...previous, create()];
}

export function removeStepRenderKey(previous: readonly string[], index: number): string[] {
	return previous.filter((_key, i) => i !== index);
}

export function moveStepRenderKey(previous: readonly string[], from: number, to: number): string[] {
	if (from === to || from < 0 || to < 0 || from >= previous.length || to >= previous.length) {
		return previous.slice();
	}
	const next = previous.slice();
	const [key] = next.splice(from, 1);
	if (!key) return previous.slice();
	next.splice(to, 0, key);
	return next;
}
