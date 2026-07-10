import { Settings } from "@oh-my-pi/pi-coding-agent";

import { ensureAdvisorsEnabledByDefault } from "./advisor-settings.ts";

/** Initialize the SDK singleton before any in-process SDK consumer runs. */
export async function initializeSdkSettings(cwd: string, agentDir?: string): Promise<Settings> {
	const settings = await Settings.init({ cwd, ...(agentDir ? { agentDir } : {}) });
	await ensureAdvisorsEnabledByDefault(settings);
	return settings;
}
