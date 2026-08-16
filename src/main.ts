import { type App, Modal, Notice, Plugin, TFile } from "obsidian";

import { renderPackInspection } from "./context/inspect";
import { PREVIEW_QUESTION, buildContextPack } from "./context/pack";
import { AskRawModal } from "./ollama/ask-raw";
import { OllamaClient } from "./ollama/client";
import { formatConnectionReport } from "./ollama/protocol";
import { createObsidianTransport } from "./ollama/transport";
import { formatPingMessage } from "./ping";
import { type MiseSettings, sanitizeSettings } from "./settings/settings";
import { MiseSettingTab } from "./settings/tab";
import { toCalendarDate } from "./vault/dates";
import { createVaultIndex } from "./vault/resolver";

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

		this.addCommand({
			id: "show-context-pack",
			name: "Show context pack",
			callback: () => {
				// addCommand's callback is synchronous; reading notes is not.
				void this.showContextPack();
			},
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	override onunload(): void {}

	/**
	 * The whole Obsidian surface of PR 4: a list of paths in, note contents on
	 * demand, a modal out. Everything between is pure.
	 */
	private async showContextPack(): Promise<void> {
		try {
			const index = createVaultIndex(
				this.app.vault.getMarkdownFiles().map((file) => file.path),
			);
			const pack = await buildContextPack(
				{
					index,
					date: toCalendarDate(new Date()),
					question: PREVIEW_QUESTION,
				},
				(path) => this.readNote(path),
			);
			new ContextPackModal(this.app, renderPackInspection(pack)).open();
		} catch (error) {
			new Notice(
				`Could not build the context pack: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/** `cachedRead` rather than `read`: this is display, not editing. */
	private async readNote(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`no such note: ${path}`);
		return this.app.vault.cachedRead(file);
	}
}

class ContextPackModal extends Modal {
	private readonly report: string;

	constructor(app: App, report: string) {
		super(app);
		this.report = report;
	}

	override onOpen(): void {
		this.titleEl.setText("Context pack");
		const pre = this.contentEl.createEl("pre", { text: this.report });
		// The report is wide and long, and the user needs to be able to select
		// it; Obsidian's default modal styling gives none of that.
		pre.style.whiteSpace = "pre-wrap";
		pre.style.wordBreak = "break-word";
		pre.style.userSelect = "text";
		pre.style.maxHeight = "60vh";
		pre.style.overflow = "auto";
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
