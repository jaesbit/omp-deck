import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "omp-deck:project-colors";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export type ProjectColorMap = Readonly<Record<string, string>>;

/**
 * Keep the mapping explicit: an unmapped project deliberately has no visual
 * marker. This avoids assigning misleading colors to newly seen workspaces.
 */
export function projectColorForCwd(cwd: string | undefined, colors: ProjectColorMap): string | undefined {
	return cwd ? colors[cwd] : undefined;
}

export function updateProjectColors(
	colors: ProjectColorMap,
	cwd: string,
	color: string | undefined,
): ProjectColorMap {
	if (!cwd) return colors;
	if (color === undefined) {
		if (!(cwd in colors)) return colors;
		const { [cwd]: _, ...next } = colors;
		return next;
	}
	if (!HEX_COLOR.test(color) || colors[cwd] === color) return colors;
	return { ...colors, [cwd]: color };
}

function normalizeProjectColors(value: unknown): ProjectColorMap {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const colors: Record<string, string> = {};
	for (const [cwd, color] of Object.entries(value)) {
		if (cwd && typeof color === "string" && HEX_COLOR.test(color)) colors[cwd] = color;
	}
	return colors;
}

function readProjectColors(): ProjectColorMap {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? normalizeProjectColors(JSON.parse(raw)) : {};
	} catch {
		return {};
	}
}

function persistProjectColors(colors: ProjectColorMap): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
	} catch {
		// Quota / disabled storage / private mode — retain the in-memory choice.
	}
}

export interface UseProjectColorsResult {
	colors: ProjectColorMap;
	setColor(cwd: string, color: string | undefined): void;
}

/** Browser-local project-color preferences, synchronized across open tabs. */
export function useProjectColors(): UseProjectColorsResult {
	const [colors, setColors] = useState<ProjectColorMap>(readProjectColors);

	useEffect(() => {
		const onStorage = (event: StorageEvent): void => {
			if (event.key !== STORAGE_KEY) return;
			try {
				setColors(event.newValue ? normalizeProjectColors(JSON.parse(event.newValue)) : {});
			} catch {
				setColors({});
			}
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const setColor = useCallback((cwd: string, color: string | undefined) => {
		setColors((current) => {
			const next = updateProjectColors(current, cwd, color);
			if (next === current) return current;
			persistProjectColors(next);
			return next;
		});
	}, []);

	return { colors, setColor };
}
