import { type App, Modal, Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";

import { CHAT_VIEW_TYPE, MiseChatView } from "./chat/view";
import { renderPackInspection } from "./context/inspect";
import { PREVIEW_QUESTION, buildContextPack } from "./context/pack";
import { DraftPreviewModal, DraftProgressModal } from "./draft/modal";
import { runDraftTurn } from "./draft/run";
import { AskRawModal } from "./ollama/ask-raw";
import { OllamaClient, classifyStreamFailure } from "./ollama/client";
import { formatConnectionReport } from "./ollama/protocol";
import { createObsidianTransport } from "./ollama/transport";
import { formatPingMessage } from "./ping";
import { type MiseSettings, sanitizeSettings } from "./settings/settings";
import { MiseSettingTab } from "./settings/tab";
import { type CalendarDate, addDays, dailyNoteStem, toCalendarDate } from "./vault/dates";
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

		// `registerView` is unregistered by the base class on unload, along with
		// the commands and the ribbon icon below.
		this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new MiseChatView(leaf, this));
		this.addRibbonIcon("message-square", "Ask the Mise assistant", () => {
			void this.openChatView();
		});

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

		this.addCommand({
			id: "open-chat",
			name: "Ask a question about my notes",
			callback: () => {
				void this.openChatView();
			},
		});

		this.addCommand({
			id: "draft-today",
			name: "Draft today",
			callback: () => {
				void this.draftDailyNote(toCalendarDate(new Date()));
			},
		});

		this.addCommand({
			id: "draft-tomorrow",
			name: "Draft tomorrow",
			callback: () => {
				// The evening use: plan tomorrow before closing the laptop. The
				// pack's daily notes are those strictly before the drafted day, so
				// tomorrow's draft sees today's note and today's does not.
				void this.draftDailyNote(addDays(toCalendarDate(new Date()), 1));
			},
		});
	}

	/**
	 * Reveal the chat view, reusing the open one rather than stacking a second.
	 * The conversation is held in the view, so re-opening an existing leaf keeps
	 * it and the prompt cache it has warmed.
	 */
	private async openChatView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
		if (leaf === undefined || leaf === null) {
			new Notice("Could not open the sidebar to put the chat in.");
			return;
		}
		if (existing.length === 0) {
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
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

	/**
	 * PR 6, and the whole point of the project: draft the daily note.
	 *
	 * The Obsidian surface is again three calls wide — a path list in, note
	 * contents on demand, a modal out. Nothing is written here; `runDraftTurn`
	 * returns a *plan*, and only the preview modal's Write button acts on it.
	 */
	private async draftDailyNote(date: CalendarDate): Promise<void> {
		if (this.settings.model.trim() === "") {
			new Notice("No Ollama model is configured. Pick one in the settings tab.");
			return;
		}

		const controller = new AbortController();
		const progress = new DraftProgressModal(
			this.app,
			`Drafting ${dailyNoteStem(date)}`,
			controller,
		);
		progress.open();

		try {
			const result = await runDraftTurn({
				deps: {
					index: createVaultIndex(
						this.app.vault.getMarkdownFiles().map((file) => file.path),
					),
					date,
					read: (path) => this.readNote(path),
					// The note about to be written is read uncached, so the diff is
					// against what is on disk rather than against a cache filled
					// before the user started typing into it this morning.
					readCurrent: (path) => this.readNoteUncached(path),
					send: (messages, handlers, signal) =>
						this.client.chat(messages, handlers, signal),
					numCtx: this.settings.numCtx,
					numPredict: this.settings.numPredict,
				},
				onToken: (text) => progress.appendToken(text),
				onSignal: (signal) => progress.setStatus(signal.text),
				signal: controller.signal,
			});
			progress.finish();
			new DraftPreviewModal(this.app, result).open();
		} catch (error) {
			progress.finish();
			// A cancel is an outcome, not a fault — same classifier the chat turn
			// uses, so the two agree about what an abort looks like.
			if (controller.signal.aborted || classifyStreamFailure(error) === "aborted") {
				new Notice("Draft cancelled. Nothing was written.");
				return;
			}
			new Notice(
				`Could not draft the daily note: ${
					error instanceof Error ? error.message : String(error)
				}`,
				10_000,
			);
		}
	}

	/** `cachedRead` rather than `read`: this is display, not editing. */
	private async readNote(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`no such note: ${path}`);
		return this.app.vault.cachedRead(file);
	}

	/** Uncached, for the one note a command is about to propose changes to. */
	private async readNoteUncached(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`no such note: ${path}`);
		return this.app.vault.read(file);
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
