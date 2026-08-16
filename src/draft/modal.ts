// The diff preview: the last thing between the model and the user's vault, and
// the only thing in `src/draft/` that imports `obsidian`.
//
// Everything with a decision in it lives next door and is unit-tested — the
// template parser (`template.ts`), the merge and the clobber rules (`plan.ts`),
// the diff (`diff.ts`), the whole turn (`run.ts`). What is left here is DOM, an
// `AbortController`, and three vault calls.
//
// The rules this shell is responsible for honouring:
//
//   - **Nothing is written until the user presses Write.** The modal opens with
//     the draft already computed and the file untouched.
//   - **The proposal is editable.** The textarea holds the note as it would be;
//     the diff below it re-renders as the user types, so what they are about to
//     write and what they are looking at can never disagree.
//   - **The file is re-read at the moment of writing.** `confirmWrite` refuses
//     if it moved while the preview was open — Obsidian is a text editor and
//     the note is very likely open in the next pane.
//
// Styling is inline and uses Obsidian's CSS variables: the build produces
// `main.js` and nothing else, so a `styles.css` would never reach the vault.

import { type App, Modal, Notice, TFile } from "obsidian";

import { type ChatSignal, hasWarning } from "../chat/signals";
import { sourceAnnotation, sourceLinkText } from "../chat/sources";
import { collapseDiff, diffLineText, diffLines, diffStats, isNoOpDiff } from "./diff";
import { confirmWrite } from "./plan";
import type { DraftTurnResult } from "./run";

/**
 * Shown while the model is generating.
 *
 * It exists for the cancel button. Drafting a note is the longest request the
 * plugin makes — a full context pack in, a whole note out — and a modal with no
 * way out would leave the user watching a spinner they cannot stop. Closing it
 * by any route aborts, since a generation nobody is watching is a generation
 * nobody wanted.
 */
export class DraftProgressModal extends Modal {
	private outputEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private finished = false;

	constructor(
		app: App,
		private readonly label: string,
		private readonly controller: AbortController,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl, titleEl } = this;
		contentEl.empty();
		titleEl.setText(this.label);
		this.statusEl = contentEl.createEl("p", {
			text: "Reading your planning notes…",
			cls: "setting-item-description",
		});
		this.outputEl = contentEl.createEl("pre");
		this.outputEl.style.whiteSpace = "pre-wrap";
		this.outputEl.style.maxHeight = "16rem";
		this.outputEl.style.overflowY = "auto";
		this.outputEl.style.fontSize = "var(--font-ui-smaller)";
		this.outputEl.style.color = "var(--text-muted)";

		const cancel = contentEl.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
	}

	appendToken(text: string): void {
		if (this.outputEl === null) return;
		if (this.outputEl.textContent === "") this.setStatus("Drafting…");
		this.outputEl.textContent += text;
		this.outputEl.scrollTop = this.outputEl.scrollHeight;
	}

	setStatus(text: string): void {
		this.statusEl?.setText(text);
	}

	/** Close without cancelling: the generation finished on its own. */
	finish(): void {
		this.finished = true;
		this.close();
	}

	override onClose(): void {
		if (!this.finished) this.controller.abort();
		this.contentEl.empty();
	}
}

export class DraftPreviewModal extends Modal {
	private edited: string;
	private diffEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private writeEl: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private readonly result: DraftTurnResult,
	) {
		super(app);
		this.edited = result.plan.after;
	}

	override onOpen(): void {
		const contentEl = this.contentEl;
		const titleEl = this.titleEl;
		const plan = this.result.plan;
		contentEl.empty();
		titleEl.setText(`Draft ${plan.path}`);

		contentEl.createEl("p", {
			text: describeAction(this.result),
			cls: "setting-item-description",
		});

		this.renderSignals(contentEl, this.result.signals);
		this.renderSources(contentEl);

		const area = contentEl.createEl("textarea");
		area.value = this.edited;
		area.rows = 14;
		area.style.width = "100%";
		area.style.fontFamily = "var(--font-monospace)";
		area.style.resize = "vertical";
		area.addEventListener("input", () => {
			this.edited = area.value;
			this.renderDiff();
		});

		contentEl.createEl("h4", { text: "What would change" });
		this.diffEl = contentEl.createEl("pre");
		this.diffEl.style.whiteSpace = "pre-wrap";
		this.diffEl.style.wordBreak = "break-word";
		this.diffEl.style.userSelect = "text";
		this.diffEl.style.maxHeight = "16rem";
		this.diffEl.style.overflow = "auto";
		this.diffEl.style.fontSize = "var(--font-ui-smaller)";

		this.statusEl = contentEl.createEl("p", { cls: "setting-item-description" });

		const buttons = contentEl.createDiv();
		buttons.style.display = "flex";
		buttons.style.gap = "0.35rem";
		buttons.style.marginTop = "0.5rem";

		this.writeEl = buttons.createEl("button", { text: "Write", cls: "mod-cta" });
		this.writeEl.addEventListener("click", () => void this.write());

		if (this.result.plan.before !== "") {
			const open = buttons.createEl("button", { text: "Open the existing note" });
			open.addEventListener("click", () => {
				void this.app.workspace.openLinkText(this.result.plan.path, "", false);
				this.close();
			});
		}

		const discard = buttons.createEl("button", { text: "Discard" });
		discard.addEventListener("click", () => this.close());

		this.renderDiff();
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	// --- rendering ---------------------------------------------------------

	private renderDiff(): void {
		const diff = diffLines(this.result.plan.before, this.edited);
		const target = this.diffEl;
		if (target === null) return;
		target.empty();

		if (isNoOpDiff(diff)) {
			target.createDiv({ text: "Nothing would change." }).style.color = "var(--text-muted)";
		} else {
			for (const line of collapseDiff(diff)) {
				const el = target.createDiv({ text: diffLineText(line) });
				if (line === null) el.style.color = "var(--text-faint)";
				else if (line.kind === "add") el.style.color = "var(--text-success)";
				else if (line.kind === "remove") el.style.color = "var(--text-error)";
				else el.style.color = "var(--text-muted)";
			}
		}

		const stats = diffStats(diff);
		this.statusEl?.setText(`${stats.added} line(s) added, ${stats.removed} removed.`);
		if (this.writeEl !== null) this.writeEl.disabled = isNoOpDiff(diff);
	}

	private renderSignals(parent: HTMLElement, signals: readonly ChatSignal[]): void {
		if (signals.length === 0) return;
		const box = parent.createDiv();
		box.style.fontSize = "var(--font-ui-smaller)";
		box.style.borderLeft = `2px solid ${
			hasWarning(signals) ? "var(--text-warning)" : "var(--background-modifier-border)"
		}`;
		box.style.paddingLeft = "0.5rem";
		box.style.margin = "0.4rem 0";
		for (const signal of signals) {
			const line = box.createDiv({ text: signal.text });
			line.style.color =
				signal.level === "warning" ? "var(--text-warning)" : "var(--text-muted)";
		}
	}

	/**
	 * Which notes the draft was built from. Same reasoning as the chat footer:
	 * a plan the user cannot trace back to their own documents is a plan they
	 * have no way to check.
	 */
	private renderSources(parent: HTMLElement): void {
		const box = parent.createDiv();
		box.style.fontSize = "var(--font-ui-smaller)";
		const heading = box.createDiv({
			text:
				this.result.sources.length === 0
					? "No notes were in context"
					: "Drafted from",
		});
		heading.style.color = "var(--text-muted)";
		if (this.result.sources.length === 0) return;

		const list = box.createEl("ul");
		list.style.margin = "0 0 0.5rem 0";
		list.style.paddingLeft = "1.1rem";
		for (const source of this.result.sources) {
			const item = list.createEl("li");
			const link = item.createEl("a", {
				text: sourceLinkText(source.path),
				href: "#",
				title: source.path,
			});
			link.addEventListener("click", (event) => {
				event.preventDefault();
				void this.app.workspace.openLinkText(source.path, "", false);
			});
			const annotation = sourceAnnotation(source);
			if (annotation === null) continue;
			item.createSpan({ text: ` — ${annotation}` }).style.color = "var(--text-warning)";
		}
	}

	// --- the write ---------------------------------------------------------

	private async write(): Promise<void> {
		const plan = this.result.plan;
		try {
			const file = this.app.vault.getAbstractFileByPath(plan.path);
			if (file !== null && !(file instanceof TFile)) {
				new Notice(`${plan.path} is not a file. Nothing was written.`);
				return;
			}
			// `read`, not `cachedRead`: this is the one moment the plugin writes,
			// and a cache filled before the user started editing the note would
			// hide exactly the change this check exists to catch.
			const current = file === null ? null : await this.app.vault.read(file);
			const decision = confirmWrite(plan, current, this.edited);
			if (!decision.ok) {
				new Notice(decision.reason, 10_000);
				return;
			}

			if (file === null) await this.app.vault.create(plan.path, decision.text);
			else await this.app.vault.modify(file, decision.text);

			new Notice(`${plan.action === "create" ? "Created" : "Updated"} ${plan.path}.`);
			this.close();
			await this.app.workspace.openLinkText(plan.path, "", false);
		} catch (error) {
			new Notice(
				`Could not write ${plan.path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				10_000,
			);
		}
	}
}

function describeAction(result: DraftTurnResult): string {
	const plan = result.plan;
	switch (plan.action) {
		case "create":
			return `${plan.path} does not exist. The draft below would create it, filling the template's sections from your planning notes.`;
		case "fill":
			return `${plan.path} already exists, so only its empty sections would be filled. Everything you have already written stays exactly as it is.`;
		case "noop":
			return `${plan.path} already says everything this draft would say. Nothing to write — open it instead.`;
	}
}
