import { type App, Modal, Notice, Plugin, TFile } from "obsidian";

import { renderPackInspection } from "./context/inspect";
import { PREVIEW_QUESTION, buildContextPack } from "./context/pack";
import { formatPingMessage } from "./ping";
import { toCalendarDate } from "./vault/dates";
import { createVaultIndex } from "./vault/resolver";

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

		this.addCommand({
			id: "show-context-pack",
			name: "Show context pack",
			callback: () => {
				// addCommand's callback is synchronous; reading notes is not.
				void this.showContextPack();
			},
		});
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
