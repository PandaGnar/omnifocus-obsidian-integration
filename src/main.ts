import { Notice, Plugin } from "obsidian";

import { formatPingMessage } from "./ping";

export default class MiseAssistantPlugin extends Plugin {
	override onload(): void {
		// Commands registered via addCommand are torn down by the base class on
		// unload, so onunload has nothing of its own to release yet.
		this.addCommand({
			id: "ping",
			// Obsidian prefixes the plugin name in the palette, so this renders
			// as "Mise Assistant: Ping". Repeating "Mise" here would double it.
			name: "Ping",
			callback: () => {
				new Notice(formatPingMessage(new Date()));
			},
		});
	}

	override onunload(): void {}
}
