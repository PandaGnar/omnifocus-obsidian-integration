// Conversation state, as a pure reduction over the events a chat turn produces.
//
// The point of pulling this out of the view is that streaming state is where UI
// code goes wrong: tokens arriving after a cancel, a second question sent while
// the first is still generating, a failure landing on the wrong exchange. Those
// are all orderings, and orderings are testable — but only if the state lives
// somewhere a test can drive it without an Obsidian workspace.
//
// So the view owns the DOM and the `AbortController`, and this owns what is
// true. Every event that names no exchange applies to the *active* one, and an
// event that arrives when there is no active exchange is dropped rather than
// applied to whatever is last: a token from a cancelled generation must not
// append itself to the answer the user just stopped reading.
//
// The conversation is deliberately ephemeral. It lives here, it is lost on
// reload, and `save to note` is the only way anything reaches the vault.
//
// Pure: no `obsidian` import.

import type { ConversationTurn } from "../context/types";
import type { ChatSignal } from "./signals";
import type { ChatSource } from "./sources";

export type ExchangeStatus =
	/** Sent; no token has come back yet. */
	| "pending"
	/** Tokens are arriving. */
	| "streaming"
	/** The model finished. */
	| "done"
	/** The user pressed cancel. Whatever arrived is kept and shown. */
	| "cancelled"
	| "error";

export interface ChatExchange {
	readonly id: number;
	readonly question: string;
	readonly answer: string;
	readonly status: ExchangeStatus;
	/** The notes that were in the prompt. Empty until the pack is built. */
	readonly sources: readonly ChatSource[];
	readonly signals: readonly ChatSignal[];
	readonly error: string | null;
}

export interface ChatSessionState {
	readonly exchanges: readonly ChatExchange[];
	/** True while a generation is in flight. The view refuses a second question. */
	readonly busy: boolean;
	readonly nextId: number;
}

export const EMPTY_SESSION: ChatSessionState = {
	exchanges: [],
	busy: false,
	nextId: 1,
};

export type ChatEvent =
	/** The user asked something. Opens a new exchange and makes it active. */
	| { readonly kind: "ask"; readonly question: string }
	/** The pack is built: these are the notes that went in, and the gaps in them. */
	| {
			readonly kind: "context";
			readonly sources: readonly ChatSource[];
			readonly signals: readonly ChatSignal[];
	  }
	| { readonly kind: "token"; readonly text: string }
	/** Something worth telling the user, mid-turn or at the end. */
	| { readonly kind: "signal"; readonly signal: ChatSignal }
	| { readonly kind: "finish"; readonly signals: readonly ChatSignal[] }
	| { readonly kind: "cancel" }
	| { readonly kind: "fail"; readonly message: string }
	/** Ephemeral by design: this is the only way the conversation ends. */
	| { readonly kind: "clear" };

/** The exchange events apply to: the last one, and only while it is running. */
function activeIndex(state: ChatSessionState): number {
	const index = state.exchanges.length - 1;
	if (index < 0) return -1;
	const status = (state.exchanges[index] as ChatExchange).status;
	return status === "pending" || status === "streaming" ? index : -1;
}

function replace(
	state: ChatSessionState,
	index: number,
	patch: Partial<ChatExchange>,
	busy: boolean,
): ChatSessionState {
	const exchanges = state.exchanges.map((exchange, i) =>
		i === index ? { ...exchange, ...patch } : exchange,
	);
	return { ...state, exchanges, busy };
}

export function reduceChat(state: ChatSessionState, event: ChatEvent): ChatSessionState {
	if (event.kind === "clear") return { ...EMPTY_SESSION, nextId: state.nextId };

	if (event.kind === "ask") {
		// One generation at a time. Two in flight would share an
		// AbortController and interleave their tokens into one answer.
		if (state.busy) return state;
		const exchange: ChatExchange = {
			id: state.nextId,
			question: event.question,
			answer: "",
			status: "pending",
			sources: [],
			signals: [],
			error: null,
		};
		return {
			exchanges: [...state.exchanges, exchange],
			busy: true,
			nextId: state.nextId + 1,
		};
	}

	const index = activeIndex(state);
	// No active exchange: a late token, a duplicated finish, or a cancel that
	// raced the completion. Dropped rather than applied to the previous answer.
	if (index === -1) return state;
	const active = state.exchanges[index] as ChatExchange;

	switch (event.kind) {
		case "context":
			return replace(
				state,
				index,
				{ sources: event.sources, signals: [...active.signals, ...event.signals] },
				true,
			);
		case "token":
			return replace(
				state,
				index,
				{ answer: active.answer + event.text, status: "streaming" },
				true,
			);
		case "signal":
			return replace(state, index, { signals: [...active.signals, event.signal] }, true);
		case "finish":
			return replace(
				state,
				index,
				{ status: "done", signals: [...active.signals, ...event.signals] },
				false,
			);
		case "cancel":
			// Partial output is kept: the user stopped it, they did not disown it.
			return replace(state, index, { status: "cancelled" }, false);
		case "fail":
			return replace(state, index, { status: "error", error: event.message }, false);
	}
}

/** Apply several events in order. Convenience for tests and for the view. */
export function reduceAll(
	state: ChatSessionState,
	events: readonly ChatEvent[],
): ChatSessionState {
	return events.reduce(reduceChat, state);
}

/**
 * The conversation as the context pack wants it.
 *
 * Only completed exchanges. A cancelled turn's half answer stays on screen —
 * the user asked for it to stop, not to vanish — but feeding half an answer
 * back as though the model had said it invites the next turn to continue a
 * thought that was never finished. A failed turn has no answer to send at all.
 *
 * The in-flight exchange is excluded by the same rule, which is what makes this
 * safe to call at the moment a question is asked: the new question belongs in
 * the pack's question slot, never in its conversation.
 */
export function conversationTurns(state: ChatSessionState): readonly ConversationTurn[] {
	const turns: ConversationTurn[] = [];
	for (const exchange of state.exchanges) {
		if (exchange.status !== "done") continue;
		turns.push({ role: "user", text: exchange.question });
		turns.push({ role: "assistant", text: exchange.answer });
	}
	return turns;
}

/** The exchange currently generating, if any. */
export function activeExchange(state: ChatSessionState): ChatExchange | null {
	const index = activeIndex(state);
	return index === -1 ? null : (state.exchanges[index] as ChatExchange);
}
