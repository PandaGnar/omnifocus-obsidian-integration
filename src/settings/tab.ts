import { Notice, type Plugin, PluginSettingTab, Setting } from "obsidian";

import type { OllamaClient } from "../ollama/client";
import { formatConnectionReport, formatLatency } from "../ollama/protocol";
import {
	DEFAULT_SETTINGS,
	type MiseSettings,
	SMALL_MACHINE_MODEL,
	isValidKeepAlive,
	normalizeNumCtx,
	normalizeNumPredict,
	settingsWarnings,
} from "./settings";

/**
 * What the tab needs from the plugin. Declared here rather than importing the
 * plugin class so `main.ts` can import this file without a cycle.
 */
export interface SettingsHost {
	settings: MiseSettings;
	client: OllamaClient;
	saveSettings(): Promise<void>;
}

export type SettingsHostPlugin = Plugin & SettingsHost;

export class MiseSettingTab extends PluginSettingTab {
	/** Cached across renders so opening the tab doesn't always hit the server. */
	private models: string[] = [];
	private modelsLoaded = false;

	constructor(private readonly host: SettingsHostPlugin) {
		super(host.app, host);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Ollama base URL")
			.setDesc(
				"Where the local Ollama server listens. 127.0.0.1 rather than localhost " +
					"avoids the IPv6-first resolution that makes Ollama look down when it is not.",
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.baseUrl)
					.setValue(this.host.settings.baseUrl)
					.onChange(async (value) => {
						this.host.settings.baseUrl = value.trim();
						await this.host.saveSettings();
						// A new host means a new model list.
						this.modelsLoaded = false;
					}),
			);

		this.renderModelSetting(containerEl);

		new Setting(containerEl)
			.setName("Context window (num_ctx)")
			.setDesc(
				"Sent explicitly on every request. Ollama's own docs disagree about the " +
					"default, and an undersized window silently drops the oldest tokens — " +
					"which here means the goal documents at the top of the prompt.",
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.numCtx))
					.setValue(String(this.host.settings.numCtx))
					.onChange(async (value) => {
						this.host.settings.numCtx = normalizeNumCtx(value);
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Reply length cap (num_predict)")
			.setDesc("Ollama's default is unbounded. This caps a runaway generation.")
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.numPredict))
					.setValue(String(this.host.settings.numPredict))
					.onChange(async (value) => {
						this.host.settings.numPredict = normalizeNumPredict(value);
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Keep model loaded (keep_alive)")
			.setDesc(
				"How long Ollama holds the model after a request. Default 5m is too short: " +
					"unloading discards the prompt cache, turning a fast follow-up into a full " +
					"cold prefill. Use a duration like 30m, or -1 to never unload.",
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.keepAlive)
					.setValue(this.host.settings.keepAlive)
					.onChange(async (value) => {
						const trimmed = value.trim();
						if (!isValidKeepAlive(trimmed)) return;
						this.host.settings.keepAlive = trimmed;
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Fall back to non-streaming")
			.setDesc(
				"Streaming uses fetch, which Ollama may CORS-reject from Obsidian's " +
					"app://obsidian.md origin. With this on, a rejected stream is retried " +
					"through Obsidian's CORS-exempt request path — the answer arrives in one " +
					"piece instead of token by token, and the plugin says so.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.fallbackToNonStreaming)
					.onChange(async (value) => {
						this.host.settings.fallbackToNonStreaming = value;
						await this.host.saveSettings();
					}),
			);

		this.renderTestConnection(containerEl);
		this.renderWarnings(containerEl);
		this.renderHelp(containerEl);
	}

	private renderModelSetting(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName("Model")
			.setDesc(
				`Populated from /api/tags. ${SMALL_MACHINE_MODEL} is the fallback on a 16 GB machine.`,
			);

		setting.addDropdown((dropdown) => {
			const options = [...this.models];
			const current = this.host.settings.model;
			// Keep a configured-but-not-installed model selectable rather than
			// silently switching the user to something else.
			if (current !== "" && !options.includes(current)) options.unshift(current);
			if (options.length === 0) options.push(current === "" ? "(none found)" : current);
			for (const name of options) dropdown.addOption(name, name);
			dropdown.setValue(current);
			dropdown.onChange(async (value) => {
				this.host.settings.model = value;
				await this.host.saveSettings();
			});
		});

		setting.addExtraButton((button) =>
			button
				.setIcon("refresh-cw")
				.setTooltip("Refresh model list")
				.onClick(() => {
					this.modelsLoaded = false;
					void this.loadModels();
				}),
		);

		if (!this.modelsLoaded) void this.loadModels();
	}

	private async loadModels(): Promise<void> {
		try {
			this.models = await this.host.client.listModels();
			this.modelsLoaded = true;
		} catch (error) {
			this.models = [];
			this.modelsLoaded = true;
			new Notice(
				`Could not list Ollama models: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		// Re-render so the dropdown picks up the new list; the tab may have been
		// closed while the request was in flight.
		if (this.containerEl.isShown()) this.display();
	}

	private renderTestConnection(containerEl: HTMLElement): void {
		const resultEl = containerEl.createEl("pre", { cls: "mise-connection-report" });
		resultEl.style.whiteSpace = "pre-wrap";
		resultEl.style.userSelect = "text";

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Reports the models installed, the selected model, and the round-trip time.")
			.addButton((button) =>
				button
					.setButtonText("Test connection")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("Testing...");
						resultEl.setText("");
						try {
							const report = await this.host.client.testConnection();
							resultEl.setText(formatConnectionReport(report));
							if (report.ok) {
								this.models = report.models;
								this.modelsLoaded = true;
								new Notice(
									`Ollama reachable in ${formatLatency(report.latencyMs)}.`,
								);
							}
						} finally {
							button.setDisabled(false);
							button.setButtonText("Test connection");
						}
					}),
			);
	}

	private renderWarnings(containerEl: HTMLElement): void {
		const warnings = settingsWarnings(this.host.settings);
		if (warnings.length === 0) return;
		const list = containerEl.createEl("ul");
		for (const warning of warnings) list.createEl("li", { text: warning });
	}

	private renderHelp(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Troubleshooting" });
		const list = containerEl.createEl("ul");
		list.createEl("li", {
			text:
				"Do not set OLLAMA_FLASH_ATTENTION=1. Since October 2025 unset means " +
				"auto-enable where the backend supports it; forcing it on enables it where " +
				"it is known broken. If long prompts hang during prefill, set it to 0 as an " +
				"escape hatch and report the model you were using.",
		});
		list.createEl("li", {
			text:
				"Google refreshed the Gemma 4 chat template on 2026-07-15 with the weights " +
				"unchanged. If tool calling or formatting looks wrong, re-pull the model.",
		});
		list.createEl("li", {
			text:
				"To stream token by token, allow Obsidian's origin on the server: " +
				"OLLAMA_ORIGINS=app://obsidian.md. Without it the plugin still works, " +
				"buffered.",
		});
	}
}
