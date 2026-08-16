// One turn of the conversation, end to end: build the pack, check it fits, send
// it, stream the answer back, and report everything that was substituted,
// dropped, truncated or capped along the way.
//
// This is the wiring PR 5 exists to add, and it is deliberately not in the view.
// The view has a workspace, a DOM and an `AbortController`; this has a vault
// index, a note reader and a chat function. Given fakes for those three it runs
// under `vitest` with no Obsidian and no server, which is the only way the
// "asked a question, got an answer, with the right sources listed" path is
// provable at all on a machine with no model on it.
//
// Nothing here imports `obsidian`.

import { buildContextPack } from "../context/pack";
import type { ContextBudget, ConversationTurn } from "../context/types";
import type { NoteReader } from "../context/pack";
import type { ChatHandlers, ChatResult } from "../ollama/client";
import { classifyStreamFailure } from "../ollama/client";
import { assessPromptBudget, estimatePromptTokens } from "../ollama/protocol";
import type { OllamaChatMessage } from "../ollama/types";
import type { CalendarDate } from "../vault/dates";
import type { VaultIndex } from "../vault/resolver";
import { type PrefixTracker, prefixSignal } from "./prefix";
import type { ChatEvent } from "./session";
import { type ChatSignal, packSignals, responseSignals } from "./signals";
import { deriveSources } from "./sources";

/**
 * The client's `chat`, narrowed to what a turn needs. Declared structurally so
 * a test can pass a function that returns canned tokens without constructing an
 * `OllamaClient`, a transport and a settings object to reach it.
 */
export type ChatSend = (
	messages: OllamaChatMessage[],
	handlers: ChatHandlers,
	signal?: AbortSignal,
) => Promise<ChatResult>;

export interface ChatTurnDeps {
	readonly index: VaultIndex;
	/** The day the pack is *for*. Read once by the caller, never in here. */
	readonly date: CalendarDate;
	readonly read: NoteReader;
	readonly send: ChatSend;
	readonly numCtx: number;
	readonly numPredict: number;
	/** Carries the previous turn's prefix so cache loss can be reported. */
	readonly tracker: PrefixTracker;
	readonly budget?: ContextBudget;
}

export interface ChatTurnRequest {
	readonly question: string;
	/** Completed turns only — see `conversationTurns` in `session.ts`. */
	readonly conversation: readonly ConversationTurn[];
	readonly deps: ChatTurnDeps;
	readonly dispatch: (event: ChatEvent) => void;
	readonly signal: AbortSignal;
}

/**
 * Run one turn, reporting progress through `dispatch`.
 *
 * Never throws: a turn that fails ends in a `fail` event carrying the message,
 * because the view's job on failure is to show the user what went wrong, not to
 * unwind a stack. The one thing it distinguishes is cancellation, which is not
 * a failure and must not be reported as one.
 */
export async function runChatTurn(request: ChatTurnRequest): Promise<void> {
	const { deps, dispatch, signal } = request;
	// The date rides on the event rather than being read again later: the
	// exchange, the pack and anything eventually saved to a note all have to
	// agree about which day this was, and a second clock read across midnight
	// would disagree. See `ChatExchange.date`.
	dispatch({ kind: "ask", question: request.question, date: deps.date });

	try {
		const pack = await buildContextPack(
			{
				index: deps.index,
				date: deps.date,
				question: request.question,
				conversation: request.conversation,
				...(deps.budget === undefined ? {} : { budget: deps.budget }),
			},
			deps.read,
		);

		// Reading the vault takes long enough to cancel during, and a cancel
		// that lands here must not go on to start a generation.
		if (signal.aborted) {
			dispatch({ kind: "cancel" });
			return;
		}

		const signals: ChatSignal[] = [...packSignals(pack)];

		// The prompt cache is the difference between a sub-second follow-up and
		// a cold prefill, and losing it is invisible except as slowness.
		const cache = prefixSignal(deps.tracker.observe(pack));
		if (cache !== null) signals.push(cache);

		const messages: OllamaChatMessage[] = pack.messages.map((message) => ({
			role: message.role,
			content: message.content,
		}));

		// The pre-flight estimate. `detectTruncation` has a documented blind
		// spot — a prompt-cache hit hides a real truncation behind a low
		// `prompt_eval_count` — and this check is the only guard on it. The pack
		// path combines long prompts with cache hits by design, which is exactly
		// the combination that lands in the blind spot, so this is load-bearing
		// here in a way it never was for `ask raw`.
		const preflight = assessPromptBudget({
			estimatedPromptTokens: estimatePromptTokens(messages),
			numCtx: deps.numCtx,
			numPredict: deps.numPredict,
		});
		if (preflight.status !== "ok") {
			signals.push({
				code: `prompt-budget-${preflight.status}`,
				level: "warning",
				text: preflight.message,
			});
		}

		dispatch({ kind: "context", sources: deriveSources(pack), signals });

		const handlers: ChatHandlers = {
			onToken: (text) => dispatch({ kind: "token", text }),
			// Reported the moment it happens rather than only at the end: the
			// user is watching an empty box wondering why nothing is arriving.
			onStreamingUnavailable: (reason) =>
				dispatch({
					kind: "signal",
					signal: {
						code: "streaming-unavailable",
						level: "info",
						text: `Streaming failed (${reason}); waiting for the whole reply at once.`,
					},
				}),
		};

		const result = await deps.send(messages, handlers, signal);

		dispatch({ kind: "finish", signals: responseSignals(result) });
	} catch (error) {
		// A user cancel is an outcome, not a fault. Checked through the
		// classifier the client already uses so the two agree about what an
		// abort looks like across Electron versions.
		if (signal.aborted || classifyStreamFailure(error) === "aborted") {
			dispatch({ kind: "cancel" });
			return;
		}
		dispatch({
			kind: "fail",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
