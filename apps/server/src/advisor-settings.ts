import { Settings } from "@oh-my-pi/pi-coding-agent";

export const ADVISOR_ENABLED_KEY = "advisor.enabled";

export interface AdvisorSettingsState {
	enabled: boolean;
	configured: boolean;
}

/**
 * The SDK introduced advisors with a conservative upstream default of disabled.
 * Deck opts every installation into the feature exactly once, while preserving a
 * user's explicit later choice in OMP's own global settings file.
 */
export async function ensureAdvisorsEnabledByDefault(settings: Settings): Promise<void> {
	if (settings.isConfigured(ADVISOR_ENABLED_KEY)) return;
	settings.set(ADVISOR_ENABLED_KEY, true);
	await settings.flush();
}

export async function getAdvisorSettings(): Promise<AdvisorSettingsState> {
	const settings = await Settings.init();
	await ensureAdvisorsEnabledByDefault(settings);
	return {
		enabled: settings.get(ADVISOR_ENABLED_KEY) as boolean,
		configured: settings.isConfigured(ADVISOR_ENABLED_KEY),
	};
}

export async function setAdvisorEnabled(enabled: boolean): Promise<AdvisorSettingsState> {
	const settings = await Settings.init();
	settings.set(ADVISOR_ENABLED_KEY, enabled);
	await settings.flush();
	return {
		enabled: settings.get(ADVISOR_ENABLED_KEY) as boolean,
		configured: settings.isConfigured(ADVISOR_ENABLED_KEY),
	};
}
