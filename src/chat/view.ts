// The right-sidebar chat view: the thin Obsidian shell over `src/chat/`.
//
// Everything with a decision in it lives next door and is unit-tested —
// conversation state (`session.ts`), the source footer (`sources.ts`), the
// warnings (`signals.ts`), cache accounting (`prefix.ts`), the turn itself
// (`turn.ts`) and the saved markdown (`transcript.ts`). What is left here is
// DOM, an `AbortController`, and the vault reads and writes, none of which can
// be tested without an Obsidian runtime and none of which decide anything.
//
// Rendering is incremental rather than a full repaint per token: a repaint
// would drop the user's text selection every few milliseconds, which makes an
// answer impossible to copy while it is arriving.
//
// Styling is inline. The build produces `main.js` and nothing else, so a
// `styles.css` would not reach the vault; the plugin uses Obsidian's own CSS
// variables so it follows the user's theme rather than inventing colours.

import { ItemView, Notice, type WorkspaceLeaf, TFile } from "obsidian";

import type { OllamaClient } from "../ollama/client";
import type { MiseSettings } from "../settings/settings";
import { dailyNoteStem, toCalendarDate } from "../vault/dates";
import { createVaultIndex, newDailyNotePath, resolveDailyNote } from "../vault/resolver";
import { PrefixTracker } from "./prefix";
import {
	EMPTY_SESSION,
	type ChatEvent,
	type ChatExchange,
	type ChatSessionState,
	conversationTurns,
	reduceChat,
} from "./session";
import { type ChatSignal, hasWarning } from "./signals";
import { type ChatSource, sourceAnnotation, sourceLinkText } from "./sources";
import { appendExchange, newNoteWithExchange, renderExchangeMarkdown } from "./transcript";
import { runChatTurn } from "./turn";

export const CHAT_VIEW_TYPE = "mise-chat";

/** What the view needs from the plugin, declared here to avoid an import cycle. */
export interface ChatHost {
	settings: MiseSettings;
	client: OllamaClient;
}

/** Per-exchange DOM, kept so a token can be appended without a repaint. */
interface ExchangeCard {
	readonly statusEl: HTMLElement;
	readonly answerEl: HTMLElement;
	readonly footerEl: HTMLElement;
	readonly actionsEl: HTMLElement;
	/** How much of the answer is already on screen. */
	renderedAnswerLength: number;
	renderedSources: number;
	renderedSignals: number;
	renderedStatus: string;
}

export class MiseChatView extends ItemView {
	private state: ChatSessionState = EMPTY_SESSION;
	private controller: AbortController | null = null;
	/** One lineage per conversation; cleared with the conversation. */
	private readonly tracker = new PrefixTracker();
	private readonly cards = new Map<number, ExchangeCard>();

	private logEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendEl: HTMLButtonElement | null = null;
	private cancelEl: HTMLButtonElement | null = null;
	private clearEl: HTMLButtonElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: ChatHost,
	) {
		super(leaf);
		// A sidebar view the user reads *alongside* a note, not one they
		// navigate away from.
		this.navigation = false;
		this.icon = "message-square";
	}

	override getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return "Mise chat";
	}

	protected override async onOpen(): Promise<void> {
		this.build();
	}

	protected override async onClose(): Promise<void> {
		// Closing the sidebar must not leave a generation running against DOM
		// that no longer exists.
		this.controller?.abort();
		this.controller = null;
		this.cards.clear();
		this.contentEl.empty();
	}

	// --- construction ------------------------------------------------------

	private build(): void {
		const root = this.contentEl;
		root.empty();
		root.style.display = "flex";
		root.style.flexDirection = "column";
		root.style.height = "100%";
		root.style.gap = "0.5rem";
		root.style.padding = "0.5rem";

		const intro = root.createDiv({ cls: "mise-chat-intro" });
		intro.style.fontSize = "var(--font-ui-smaller)";
		intro.style.color = "var(--text-muted)";
		intro.setText(
			"Answers are grounded in your planning notes. Every answer lists the notes " +
				"it was built from. The conversation is not saved — use Save to daily note.",
		);

		this.logEl = root.createDiv({ cls: "mise-chat-log" });
		this.logEl.style.flex = "1 1 auto";
		this.logEl.style.overflowY = "auto";
		this.logEl.style.display = "flex";
		this.logEl.style.flexDirection = "column";
		this.logEl.style.gap = "0.75rem";

		const composer = root.createDiv({ cls: "mise-chat-composer" });
		composer.style.flex = "0 0 auto";
		composer.style.display = "flex";
		composer.style.flexDirection = "column";
		composer.style.gap = "0.35rem";

		const input = composer.createEl("textarea");
		input.placeholder = "What did I say I'd focus on this quarter?";
		input.rows = 3;
		input.style.width = "100%";
		input.style.resize = "vertical";
		// Enter sends; Shift+Enter is a newline. Matches every chat box the
		// user already has muscle memory for.
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
			event.preventDefault();
			void this.ask();
		});
		this.inputEl = input;

		const buttons = composer.createDiv();
		buttons.style.display = "flex";
		buttons.style.gap = "0.35rem";

		this.sendEl = buttons.createEl("button", { text: "Ask", cls: "mod-cta" });
		this.sendEl.addEventListener("click", () => void this.ask());

		this.cancelEl = buttons.createEl("button", { text: "Cancel" });
		this.cancelEl.addEventListener("click", () => this.cancel());

		this.clearEl = buttons.createEl("button", { text: "Clear" });
		this.clearEl.addEventListener("click", () => this.clear());

		this.syncControls();
	}

	// --- the turn ----------------------------------------------------------

	private async ask(): Promise<void> {
		const input = this.inputEl;
		if (input === null) return;
		const question = input.value.trim();
		if (question === "") {
			new Notice("Type a question first.");
			return;
		}
		if (this.state.busy) {
			new Notice("Still answering the last question. Cancel it first.");
			return;
		}
		if (this.host.settings.model.trim() === "") {
			new Notice("No Ollama model is configured. Pick one in the settings tab.");
			return;
		}

		input.value = "";
		const controller = new AbortController();
		this.controller = controller;

		try {
			await runChatTurn({
				question,
				// Computed before the ask lands, so this turn's own question
				// goes in the pack's question slot and not into its history.
				conversation: conversationTurns(this.state),
				deps: {
					index: createVaultIndex(
						this.app.vault.getMarkdownFiles().map((file) => file.path),
					),
					date: toCalendarDate(new Date()),
					read: (path) => this.readNote(path),
					send: (messages, handlers, signal) =>
						this.host.client.chat(messages, handlers, signal),
					numCtx: this.host.settings.numCtx,
					numPredict: this.host.settings.numPredict,
					tracker: this.tracker,
				},
				dispatch: (event) => this.dispatch(event),
				signal: controller.signal,
			});
		} finally {
			if (this.controller === controller) this.controller = null;
			this.syncControls();
		}
	}

	private cancel(): void {
		if (this.controller === null) {
			new Notice("Nothing is generating.");
			return;
		}
		// The client's streaming path watches this signal; the buffered
		// fallback cannot be stopped server-side, but its reply is discarded.
		this.controller.abort();
	}

	private clear(): void {
		this.controller?.abort();
		this.dispatch({ kind: "clear" });
		this.cards.clear();
		this.logEl?.empty();
		// A cleared conversation is a new prefix lineage; the next turn is a
		// first turn and should not be reported as having lost a cache.
		this.tracker.reset();
	}

	private dispatch(event: ChatEvent): void {
		const before = this.state;
		const after = reduceChat(before, event);
		// The reducer drops events with no active exchange — a token that
		// arrived after a cancel, say. Nothing changed, so nothing repaints.
		if (after === before) return;
		this.state = after;
		this.render();
	}

	/** `cachedRead` rather than `read`: assembling a prompt is not editing. */
	private async readNote(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`no such note: ${path}`);
		return this.app.vault.cachedRead(file);
	}

	// --- rendering ---------------------------------------------------------

	private render(): void {
		const log = this.logEl;
		if (log === null) return;
		const pinned = isScrolledToBottom(log);
		for (const exchange of this.state.exchanges) {
			this.syncCard(exchange);
		}
		this.syncControls();
		if (pinned) log.scrollTop = log.scrollHeight;
	}

	private syncControls(): void {
		const busy = this.state.busy;
		if (this.sendEl !== null) this.sendEl.disabled = busy;
		// The cancel button is only live while there is something to cancel;
		// enabling it otherwise invites the user to press a button that lies.
		if (this.cancelEl !== null) this.cancelEl.disabled = !busy;
		if (this.clearEl !== null) this.clearEl.disabled = this.state.exchanges.length === 0;
	}

	private syncCard(exchange: ChatExchange): void {
		const card = this.cards.get(exchange.id) ?? this.createCard(exchange);

		if (card.renderedStatus !== exchange.status) {
			card.renderedStatus = exchange.status;
			card.statusEl.setText(statusText(exchange));
			card.statusEl.style.color =
				exchange.status === "error" ? "var(--text-error)" : "var(--text-muted)";
		}

		// Append only the new characters: re-setting the whole answer on every
		// frame would clear the selection of anyone copying it as it arrives.
		if (exchange.answer.length > card.renderedAnswerLength) {
			card.answerEl.appendText(exchange.answer.slice(card.renderedAnswerLength));
			card.renderedAnswerLength = exchange.answer.length;
		} else if (exchange.answer.length < card.renderedAnswerLength) {
			card.answerEl.setText(exchange.answer);
			card.renderedAnswerLength = exchange.answer.length;
		}

		if (
			card.renderedSources !== exchange.sources.length ||
			card.renderedSignals !== exchange.signals.length
		) {
			card.renderedSources = exchange.sources.length;
			card.renderedSignals = exchange.signals.length;
			this.renderFooter(card.footerEl, exchange);
		}

		// The save action appears once there is something worth saving.
		const saveable = exchange.status !== "pending";
		card.actionsEl.style.display = saveable ? "flex" : "none";
	}

	private createCard(exchange: ChatExchange): ExchangeCard {
		const log = this.logEl;
		// `render` returns early when the log is gone, so this is unreachable;
		// the fallback keeps the type honest rather than asserting non-null.
		const parent = log ?? this.contentEl;

		const root = parent.createDiv({ cls: "mise-chat-exchange" });
		root.style.border = "1px solid var(--background-modifier-border)";
		root.style.borderRadius = "var(--radius-m)";
		root.style.padding = "0.6rem";
		root.style.display = "flex";
		root.style.flexDirection = "column";
		root.style.gap = "0.4rem";

		const question = root.createDiv({ text: exchange.question });
		question.style.fontWeight = "var(--font-semibold)";
		question.style.whiteSpace = "pre-wrap";

		const statusEl = root.createDiv();
		statusEl.style.fontSize = "var(--font-ui-smaller)";
		statusEl.style.color = "var(--text-muted)";

		const answerEl = root.createDiv();
		answerEl.style.whiteSpace = "pre-wrap";
		answerEl.style.userSelect = "text";

		const footerEl = root.createDiv();

		const actionsEl = root.createDiv();
		actionsEl.style.display = "none";
		actionsEl.style.gap = "0.35rem";
		const save = actionsEl.createEl("button", { text: "Save to daily note" });
		save.addEventListener("click", () => {
			const current = this.state.exchanges.find((e) => e.id === exchange.id);
			if (current !== undefined) void this.save(current);
		});

		const card: ExchangeCard = {
			statusEl,
			answerEl,
			footerEl,
			actionsEl,
			renderedAnswerLength: 0,
			renderedSources: -1,
			renderedSignals: -1,
			renderedStatus: "",
		};
		this.cards.set(exchange.id, card);
		return card;
	}

	/**
	 * The footer: which notes were in context, and everything that was
	 * substituted, dropped or capped on the way to this answer.
	 *
	 * The sources are the reason this view is worth trusting, so they are always
	 * rendered — including the empty case, which says so rather than showing
	 * nothing and letting an ungrounded answer look grounded.
	 */
	private renderFooter(footerEl: HTMLElement, exchange: ChatExchange): void {
		footerEl.empty();
		if (exchange.signals.length > 0) {
			this.renderSignals(footerEl, exchange.signals);
		}
		this.renderSources(footerEl, exchange.sources);
	}

	private renderSignals(parent: HTMLElement, signals: readonly ChatSignal[]): void {
		const box = parent.createDiv();
		box.style.fontSize = "var(--font-ui-smaller)";
		box.style.borderLeft = `2px solid ${
			hasWarning(signals) ? "var(--text-warning)" : "var(--background-modifier-border)"
		}`;
		box.style.paddingLeft = "0.5rem";
		box.style.marginBottom = "0.4rem";
		for (const signal of signals) {
			const line = box.createDiv({ text: signal.text });
			line.style.color =
				signal.level === "warning" ? "var(--text-warning)" : "var(--text-muted)";
		}
	}

	private renderSources(parent: HTMLElement, sources: readonly ChatSource[]): void {
		const box = parent.createDiv();
		box.style.fontSize = "var(--font-ui-smaller)";

		const heading = box.createDiv({
			text: sources.length === 0 ? "No notes were in context" : "Notes in context",
		});
		heading.style.color = "var(--text-muted)";
		heading.style.marginBottom = "0.2rem";
		if (sources.length === 0) return;

		const list = box.createEl("ul");
		list.style.margin = "0";
		list.style.paddingLeft = "1.1rem";
		for (const source of sources) {
			const item = list.createEl("li");
			const link = item.createEl("a", {
				text: sourceLinkText(source.path),
				href: "#",
				title: source.path,
			});
			link.addEventListener("click", (event) => {
				event.preventDefault();
				// `false` opens in the main pane rather than in this sidebar
				// leaf, which is where the user wants the note.
				void this.app.workspace.openLinkText(source.path, "", false);
			});
			item.createSpan({ text: ` — ${source.title}` }).style.color = "var(--text-muted)";
			const annotation = sourceAnnotation(source);
			if (annotation === null) continue;
			const note = item.createDiv({ text: annotation });
			note.style.color = "var(--text-warning)";
		}
	}

	// --- save to note ------------------------------------------------------

	/**
	 * Append the exchange to today's daily note. Append-only, and it creates the
	 * note only when the day has none — never overwrites, never rewrites a line
	 * it did not add.
	 */
	private async save(exchange: ChatExchange): Promise<void> {
		try {
			const date = toCalendarDate(new Date());
			const index = createVaultIndex(
				this.app.vault.getMarkdownFiles().map((file) => file.path),
			);
			const entry = renderExchangeMarkdown(exchange, { stamp: clockStamp(new Date()) });
			const existing = resolveDailyNote(index, date);

			if (existing === null) {
				const path = newDailyNotePath(date);
				await this.app.vault.create(path, newNoteWithExchange(dailyNoteStem(date), entry));
				new Notice(`Created ${path} and saved the exchange to it.`);
				return;
			}

			const file = this.app.vault.getAbstractFileByPath(existing.path);
			if (!(file instanceof TFile)) throw new Error(`no such note: ${existing.path}`);
			// `read`, not `cachedRead`: this is the one place the plugin writes,
			// and appending to a stale copy would drop whatever the user typed
			// into the note since the cache was filled.
			const current = await this.app.vault.read(file);
			await this.app.vault.modify(file, appendExchange(current, entry));
			new Notice(`Saved to ${existing.path}.`);
		} catch (error) {
			new Notice(
				`Could not save to the daily note: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}

function statusText(exchange: ChatExchange): string {
	switch (exchange.status) {
		case "pending":
			return "Building the context pack…";
		case "streaming":
			return "Answering…";
		case "done":
			return "";
		case "cancelled":
			return "Cancelled. Partial answer kept.";
		case "error":
			return `Failed: ${exchange.error ?? "unknown error"}`;
	}
}

/** Within 4px counts as "at the bottom" — scroll positions are fractional. */
function isScrolledToBottom(el: HTMLElement): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight < 4;
}

/** `14:07`, from constant maths rather than a locale-dependent formatter. */
function clockStamp(now: Date): string {
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}
