// Shared scaffolding for the chat tests: a pack built over the fixture vault,
// and a fake `chat` function that hands back canned tokens.
//
// The fake is a function rather than a stub `OllamaClient` on purpose. What PR 5
// has to prove is that the *pack* reaches the model and the *sources* reach the
// footer; interposing a real client would drag settings, a transport and URL
// normalisation into every assertion without testing any of them again — they
// have their own suite in `src/ollama/`.

import { buildContextPack } from "../../context/pack";
import { fixtureReader } from "../../context/fixtures/notes";
import type { ContextBudget, ContextPack, ConversationTurn } from "../../context/types";
import type { ChatHandlers, ChatResult } from "../../ollama/client";
import type { OllamaChatMessage } from "../../ollama/types";
import type { CalendarDate } from "../../vault/dates";
import { VAULT_TREE } from "../../vault/fixtures/vaultTree";
import { createVaultIndex } from "../../vault/resolver";
import type { ChatSend } from "../turn";

export const d = (year: number, month: number, day: number): CalendarDate => ({
	year,
	month,
	day,
});

/** Sunday 2026-08-16: ISO week 33, quarter 3. The fixture vault's "today". */
export const TODAY = d(2026, 8, 16);

/** Inside ISO week 32, which the fixture vault does not have a goal doc for. */
export const IN_THE_W32_GAP = d(2026, 8, 5);

export const vault = createVaultIndex(VAULT_TREE);

export interface PackOptions {
	readonly date?: CalendarDate;
	readonly question?: string;
	readonly conversation?: readonly ConversationTurn[];
	readonly budget?: ContextBudget;
}

export function buildFixturePack(options: PackOptions = {}): Promise<ContextPack> {
	return buildContextPack(
		{
			index: vault,
			date: options.date ?? TODAY,
			question: options.question ?? "What should I focus on today?",
			conversation: options.conversation,
			...(options.budget === undefined ? {} : { budget: options.budget }),
		},
		fixtureReader(),
	);
}

export interface FakeModelOptions {
	/** Delivered one at a time through `onToken`. */
	readonly tokens?: readonly string[];
	/** False when the answer arrived buffered rather than streamed. */
	readonly streamed?: boolean;
	readonly promptEvalCount?: number;
	readonly numCtx?: number;
	readonly doneReason?: string;
	/** Reported through `onStreamingUnavailable` before the tokens arrive. */
	readonly streamingUnavailable?: string;
	/** Thrown instead of answering. */
	readonly failWith?: Error;
	/** Called with the messages the turn assembled, before anything is sent. */
	readonly onSend?: (messages: OllamaChatMessage[]) => void;
	/** Called between tokens, so a test can abort mid-stream. */
	readonly betweenTokens?: (index: number) => void;
}

export interface FakeModel {
	readonly send: ChatSend;
	/** Messages from every call, in order. */
	readonly calls: OllamaChatMessage[][];
}

/**
 * A `ChatSend` with no network behind it. Honours the abort signal the way the
 * real client does — it stops emitting and rejects with an `AbortError` — so a
 * cancel test exercises the same code path as a cancel in Obsidian.
 */
export function fakeModel(options: FakeModelOptions = {}): FakeModel {
	const calls: OllamaChatMessage[][] = [];
	const numCtx = options.numCtx ?? 32_768;

	const send: ChatSend = async (
		messages: OllamaChatMessage[],
		handlers: ChatHandlers,
		signal?: AbortSignal,
	): Promise<ChatResult> => {
		calls.push(messages);
		options.onSend?.(messages);
		if (options.failWith !== undefined) throw options.failWith;
		if (options.streamingUnavailable !== undefined) {
			handlers.onStreamingUnavailable?.(options.streamingUnavailable);
		}

		const tokens = options.tokens ?? ["ok"];
		let content = "";
		for (let i = 0; i < tokens.length; i += 1) {
			// Yield to the microtask queue so an abort scheduled by the test
			// lands between tokens rather than after all of them.
			await Promise.resolve();
			options.betweenTokens?.(i);
			if (signal?.aborted === true) throw abortError();
			const token = tokens[i] as string;
			content += token;
			handlers.onToken?.(token);
		}
		if (signal?.aborted === true) throw abortError();

		const promptEvalCount = options.promptEvalCount ?? 1234;
		return {
			content,
			streamed: options.streamed ?? true,
			latencyMs: 42,
			truncation:
				promptEvalCount >= numCtx
					? {
							status: "truncated",
							promptEvalCount,
							numCtx,
							estimatedPromptTokens: promptEvalCount + 500,
							estimatedDroppedTokens: 500,
							message: `Prompt was truncated: Ollama evaluated ${promptEvalCount} tokens against a num_ctx of ${numCtx}.`,
						}
					: {
							status: "ok",
							promptEvalCount,
							numCtx,
							estimatedPromptTokens: promptEvalCount,
							estimatedDroppedTokens: null,
							message: `Prompt fit: ${promptEvalCount} of ${numCtx} context tokens evaluated.`,
						},
			final: {
				done: true,
				...(options.doneReason === undefined ? {} : { done_reason: options.doneReason }),
				prompt_eval_count: promptEvalCount,
				message: { role: "assistant", content },
			},
		};
	};

	return { send, calls };
}

export function abortError(): Error {
	const error = new Error("The chat request was cancelled.");
	error.name = "AbortError";
	return error;
}
