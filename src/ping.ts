// Pure helpers, deliberately free of any `obsidian` import so they stay
// testable outside the Obsidian runtime.
import manifest from "../manifest.json";

export const PLUGIN_ID = manifest.id;
export const PLUGIN_VERSION = manifest.version;

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

/** Text shown by the `ping` command. Takes the clock so it can be tested. */
export function formatPingMessage(now: Date): string {
	const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
	return `Mise Assistant ${PLUGIN_VERSION} — loaded (${time})`;
}
