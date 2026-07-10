import { Settings } from "@oh-my-pi/pi-coding-agent";

/** Initialize the SDK singleton before any in-process SDK consumer runs. */
export function initializeSdkSettings(cwd: string, agentDir?: string): Promise<Settings> {
	return Settings.init({ cwd, ...(agentDir ? { agentDir } : {}) });
}
