import { Notice, Plugin } from "obsidian";

import { AskRawModal } from "./ollama/ask-raw";
import { OllamaClient } from "./ollama/client";
import { formatConnectionReport } from "./ollama/protocol";
import { createObsidianTransport } from "./ollama/transport";
import { formatPingMessage } from "./ping";
import { type MiseSettings, sanitizeSettings } from "./settings/settings";
import { MiseSettingTab } from "./settings/tab";

export default class MiseAssistantPlugin extends Plugin {
	// `Plugin` declares `settings?: unknown`; narrowing it here is the intended
	// pattern, hence the override.
	override settings: MiseSettings = sanitizeSettings(null);
	// Assigned in onload, before any command can run.
	client!: OllamaClient;

	override async onload(): Promise<void> {
		this.settings = sanitizeSettings(await this.loadData());
		this.client = new OllamaClient({
			transport: createObsidianTransport(),
			// Read through a getter so edits in the settings tab apply to the
			// next request without rebuilding the client.
			getSettings: () => this.settings,
		});

		this.addSettingTab(new MiseSettingTab(this));

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

		this.addCommand({
			id: "test-connection",
			name: "Test Ollama connection",
			callback: async () => {
				const report = await this.client.testConnection();
				new Notice(formatConnectionReport(report), report.ok ? 6_000 : 12_000);
			},
		});

		this.addCommand({
			id: "ask-raw",
			name: "Ask raw prompt",
			callback: () => {
				new AskRawModal(this.app, this.client, () => this.settings).open();
			},
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	override onunload(): void {}
}
