import { type App, Modal, Notice, Setting } from "obsidian";

import type { MiseSettings } from "../settings/settings";
import { type OllamaClient, formatChatSummary } from "./client";
import { assessPromptBudget, estimatePromptTokens } from "./protocol";

/**
 * The by-hand proof that the round trip works: type a prompt, watch tokens
 * arrive, cancel mid-generation. No vault content is involved — context
 * assembly is PR 4's job.
 */
export class AskRawModal extends Modal {
	private controller: AbortController | null = null;
	private outputEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly client: OllamaClient,
		private readonly getSettings: () => MiseSettings,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Ask the model (raw prompt)" });
		contentEl.createEl("p", {
			text: `Sent to ${this.getSettings().model} with no vault context.`,
			cls: "setting-item-description",
		});

		let prompt = "";
		new Setting(contentEl).setName("Prompt").addTextArea((area) => {
			area.setPlaceholder("Say something to the model...");
			area.onChange((value) => {
				prompt = value;
			});
			area.inputEl.rows = 4;
			area.inputEl.style.width = "100%";
			window.setTimeout(() => area.inputEl.focus(), 0);
		});

		this.statusEl = contentEl.createEl("p", { cls: "setting-item-description" });
		this.outputEl = contentEl.createEl("pre");
		this.outputEl.style.whiteSpace = "pre-wrap";
		this.outputEl.style.userSelect = "text";
		this.outputEl.style.maxHeight = "18rem";
		this.outputEl.style.overflowY = "auto";

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Send")
					.setCta()
					.onClick(() => {
						if (prompt.trim() === "") {
							new Notice("Nothing to send.");
							return;
						}
						button.setDisabled(true);
						void this.send(prompt).finally(() => button.setDisabled(false));
					}),
			)
			.addButton((button) =>
				button.setButtonText("Cancel generation").onClick(() => {
					if (this.controller === null) {
						new Notice("Nothing is generating.");
						return;
					}
					this.controller.abort();
				}),
			);
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}

	private async send(prompt: string): Promise<void> {
		const settings = this.getSettings();
		const messages = [{ role: "user" as const, content: prompt }];
		const budget = assessPromptBudget({
			estimatedPromptTokens: estimatePromptTokens(messages),
			numCtx: settings.numCtx,
			numPredict: settings.numPredict,
		});
		if (budget.status !== "ok") new Notice(budget.message);

		this.outputEl?.setText("");
		this.setStatus("Waiting for the first token...");
		this.controller = new AbortController();
		try {
			const result = await this.client.chat(
				messages,
				{
					onToken: (text) => {
						if (this.outputEl) this.outputEl.textContent += text;
					},
					onStreamingUnavailable: (reason) => {
						this.setStatus(
							`Streaming unavailable (${reason}); waiting for the full reply.`,
						);
					},
				},
				this.controller.signal,
			);
			const summary = formatChatSummary(result);
			this.setStatus(summary);
			// Truncation is the failure the whole detector exists for: it is
			// silent server-side, so it gets a notice of its own.
			if (result.truncation.status === "truncated") {
				new Notice(result.truncation.message, 10_000);
			}
		} catch (error) {
			if (isAbort(error)) {
				this.setStatus("Cancelled. Partial output kept above.");
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.setStatus(`Failed: ${message}`);
			new Notice(`Ollama request failed: ${message}`, 10_000);
		} finally {
			this.controller = null;
		}
	}

	override onClose(): void {
		// Closing the modal must not leave a generation running against a UI
		// that no longer exists.
		this.controller?.abort();
		this.controller = null;
		this.contentEl.empty();
	}
}

function isAbort(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		String((error as { name: unknown }).name) === "AbortError"
	);
}
