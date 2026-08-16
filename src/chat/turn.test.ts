import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanForObsidianDependencies } from "../testing/purity";

import { fixtureReader } from "../context/fixtures/notes";
import type { ContextBudget, ConversationTurn } from "../context/types";
import type { OllamaChatMessage } from "../ollama/types";
import { PrefixTracker } from "./prefix";
import {
	EMPTY_SESSION,
	type ChatEvent,
	type ChatSessionState,
	conversationTurns,
	reduceAll,
} from "./session";
import { IN_THE_W32_GAP, TODAY, fakeModel, vault } from "./fixtures/harness";
import { type ChatTurnDeps, type ChatSend, runChatTurn } from "./turn";

interface RunOptions {
	readonly question?: string;
	readonly conversation?: readonly ConversationTurn[];
	readonly send: ChatSend;
	readonly date?: typeof TODAY;
	readonly signal?: AbortSignal;
	readonly tracker?: PrefixTracker;
	readonly budget?: ContextBudget;
	readonly state?: ChatSessionState;
}

interface RunResult {
	readonly events: ChatEvent[];
	readonly state: ChatSessionState;
}

/** Drive one turn and reduce its events, exactly as the view does. */
async function run(options: RunOptions): Promise<RunResult> {
	const events: ChatEvent[] = [];
	const deps: ChatTurnDeps = {
		index: vault,
		date: options.date ?? TODAY,
		read: fixtureReader(),
		send: options.send,
		numCtx: 32_768,
		numPredict: 2048,
		tracker: options.tracker ?? new PrefixTracker(),
		...(options.budget === undefined ? {} : { budget: options.budget }),
	};
	await runChatTurn({
		question: options.question ?? "What did I say I'd focus on this quarter?",
		conversation: options.conversation ?? [],
		deps,
		dispatch: (event) => events.push(event),
		signal: options.signal ?? new AbortController().signal,
	});
	return { events, state: reduceAll(options.state ?? EMPTY_SESSION, events) };
}

const kinds = (events: readonly ChatEvent[]): string[] => events.map((e) => e.kind);

function onlyExchange(state: ChatSessionState) {
	const exchange = state.exchanges[state.exchanges.length - 1];
	if (exchange === undefined) throw new Error("no exchange");
	return exchange;
}

describe("the question the plan is graded on", () => {
	it("answers from the vault and lists 26 Q3 Goals as a source", async () => {
		// `docs/plan.md`: "What did I say I'd focus on this quarter?" returns an
		// answer grounded in `26 Q3 Goals.md`, with that file listed as a source.
		// The model is a fake, so this proves the wiring, not the answer quality
		// — the grounding is provable, the fluency is not.
		const model = fakeModel({
			tokens: ["Finish the migration", ", and take two weeks entirely offline."],
		});
		const { state } = await run({ send: model.send });
		const exchange = onlyExchange(state);

		expect(exchange.status).toBe("done");
		expect(exchange.answer).toBe(
			"Finish the migration, and take two weeks entirely offline.",
		);
		expect(exchange.sources.map((s) => s.path)).toContain("Long Term/26 Q3 Goals.md");

		// And the document really was on the wire, not merely named in the
		// footer: the quarter goals are in the system message.
		const sent = model.calls[0] as OllamaChatMessage[];
		const system = sent.find((m) => m.role === "system");
		expect(system?.content).toContain("Source: Long Term/26 Q3 Goals.md");
		expect(system?.content).toContain("Finish the migration");
	});

	it("puts the question in the last message and the date beside it", async () => {
		const model = fakeModel();
		await run({ send: model.send, question: "what about this quarter?" });
		const sent = model.calls[0] as OllamaChatMessage[];
		const final = sent[sent.length - 1] as OllamaChatMessage;
		expect(final.role).toBe("user");
		expect(final.content).toContain("what about this quarter?");
		expect(final.content).toContain("Sunday 16 August 2026");
	});
});

describe("event order", () => {
	it("shows the question, then the sources, then the tokens", async () => {
		const model = fakeModel({ tokens: ["a", "b"] });
		const { events } = await run({ send: model.send });
		expect(kinds(events)).toEqual(["ask", "context", "token", "token", "finish"]);
	});

	it("delivers the sources before a single token has arrived", async () => {
		// The footer is what makes the answer auditable; it has to be readable
		// while the answer is still being written, not only afterwards.
		const model = fakeModel({ tokens: ["a"] });
		const { events } = await run({ send: model.send });
		expect(kinds(events).indexOf("context")).toBeLessThan(kinds(events).indexOf("token"));
	});
});

describe("cancelling", () => {
	it("stops mid-stream and reports a cancel, not a failure", async () => {
		const controller = new AbortController();
		const model = fakeModel({
			tokens: ["one ", "two ", "three ", "four"],
			// Abort after the second token, the way a user hitting Cancel does.
			betweenTokens: (index) => {
				if (index === 2) controller.abort();
			},
		});
		const { events, state } = await run({ send: model.send, signal: controller.signal });

		expect(kinds(events)).toEqual(["ask", "context", "token", "token", "cancel"]);
		expect(onlyExchange(state).status).toBe("cancelled");
		expect(onlyExchange(state).answer).toBe("one two ");
		expect(state.busy).toBe(false);
	});

	it("never starts a generation for a signal that fired during pack assembly", async () => {
		const controller = new AbortController();
		controller.abort();
		const model = fakeModel();
		const { events, state } = await run({ send: model.send, signal: controller.signal });

		// Building the pack reads a dozen notes; a cancel that lands in that
		// window must not go on to occupy the model for a reply nobody wants.
		expect(model.calls).toHaveLength(0);
		expect(kinds(events)).toEqual(["ask", "cancel"]);
		expect(onlyExchange(state).status).toBe("cancelled");
	});

	it("treats an AbortError from the client as a cancel", async () => {
		const abort = new Error("The chat request was cancelled.");
		abort.name = "AbortError";
		const { events } = await run({ send: fakeModel({ failWith: abort }).send });
		expect(kinds(events)).toEqual(["ask", "context", "cancel"]);
	});

	it("hands the signal to the client rather than only watching it here", async () => {
		// The cancel button is only real if the signal reaches the transport.
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const send: ChatSend = async (_messages, _handlers, signal) => {
			received = signal;
			return fakeModel().send(_messages, _handlers, signal);
		};
		await run({ send, signal: controller.signal });
		expect(received).toBe(controller.signal);
	});
});

describe("failing", () => {
	it("reports the message instead of throwing at the view", async () => {
		const { events, state } = await run({
			send: fakeModel({ failWith: new Error("connection refused") }).send,
		});
		expect(kinds(events)).toEqual(["ask", "context", "fail"]);
		expect(onlyExchange(state).error).toBe("connection refused");
	});

	it("survives a note it cannot read", async () => {
		// `buildContextPack` records an unreadable note as a notice and carries
		// on, so a single missing file must not cost the whole answer.
		const events: ChatEvent[] = [];
		await runChatTurn({
			question: "and now?",
			conversation: [],
			deps: {
				index: vault,
				date: TODAY,
				read: (path) =>
					path === "Long Term/Childcare.md"
						? Promise.reject(new Error("permission denied"))
						: fixtureReader()(path),
				send: fakeModel().send,
				numCtx: 32_768,
				numPredict: 2048,
				tracker: new PrefixTracker(),
			},
			dispatch: (event) => events.push(event),
			signal: new AbortController().signal,
		});
		expect(kinds(events)).toContain("finish");
		const context = events.find((e) => e.kind === "context");
		expect(context?.kind === "context" && context.sources.map((s) => s.path)).not.toContain(
			"Long Term/Childcare.md",
		);
	});
});

describe("signals reaching the user", () => {
	it("surfaces the vault gap the resolver fell back through", async () => {
		const { state } = await run({ send: fakeModel().send, date: IN_THE_W32_GAP });
		const gap = onlyExchange(state).signals.find(
			(s) => s.code === "context-gap" && s.text.includes("W32"),
		);
		expect(gap?.level).toBe("warning");
		expect(gap?.text).toContain("26 W31 Goals");
	});

	it("surfaces a prompt that came back pinned at num_ctx", async () => {
		const { state } = await run({
			send: fakeModel({ promptEvalCount: 32_768, numCtx: 32_768 }).send,
		});
		expect(onlyExchange(state).signals.map((s) => s.code)).toContain("prompt-truncated");
	});

	it("surfaces a reply stopped by the num_predict cap", async () => {
		const { state } = await run({ send: fakeModel({ doneReason: "length" }).send });
		expect(onlyExchange(state).signals.map((s) => s.code)).toContain("reply-capped");
	});

	it("surfaces an answer that was buffered rather than streamed", async () => {
		const { state } = await run({
			send: fakeModel({ streamed: false, streamingUnavailable: "CORS rejected" }).send,
		});
		const codes = onlyExchange(state).signals.map((s) => s.code);
		// Twice over, and on purpose: once the moment the streaming transport
		// gives up, so the user knows why nothing is arriving, and once at the
		// end as a fact about the answer they are looking at.
		expect(codes).toContain("streaming-unavailable");
		expect(codes).toContain("not-streamed");
	});

	it("runs the pre-flight budget check the pack path depends on", async () => {
		// `detectTruncation` has a documented blind spot: a prompt-cache hit
		// hides a real truncation behind a low `prompt_eval_count`. This
		// estimate is the only guard on it, so it must be on this path.
		const events: ChatEvent[] = [];
		await runChatTurn({
			question: "and now?",
			conversation: [],
			deps: {
				index: vault,
				date: TODAY,
				read: fixtureReader(),
				send: fakeModel().send,
				numCtx: 512,
				numPredict: 2048,
				tracker: new PrefixTracker(),
			},
			dispatch: (event) => events.push(event),
			signal: new AbortController().signal,
		});
		const context = events.find((e) => e.kind === "context");
		const codes = context?.kind === "context" ? context.signals.map((s) => s.code) : [];
		expect(codes).toContain("prompt-budget-over");
	});

	it("says nothing about the cache on the first turn", async () => {
		const { state } = await run({ send: fakeModel().send });
		expect(onlyExchange(state).signals.map((s) => s.code)).not.toContain("cache-invalidated");
	});
});

describe("a multi-turn conversation", () => {
	it("sends the previous exchange as history and keeps the prefix stable", async () => {
		const tracker = new PrefixTracker();
		const model = fakeModel({ tokens: ["Finish the migration."] });

		const first = await run({
			send: model.send,
			tracker,
			question: "what is the quarter goal?",
		});
		const second = await run({
			send: model.send,
			tracker,
			question: "and this week?",
			conversation: conversationTurns(first.state),
			state: first.state,
		});

		const turnOne = model.calls[0] as OllamaChatMessage[];
		const turnTwo = model.calls[1] as OllamaChatMessage[];

		// The history is there...
		expect(turnTwo.map((m) => m.content)).toContain("what is the quarter goal?");
		expect(turnTwo).toHaveLength(turnOne.length + 2);

		// ...and the expensive part of the prompt did not move a byte.
		const systemOne = turnOne.find((m) => m.role === "system")?.content;
		const systemTwo = turnTwo.find((m) => m.role === "system")?.content;
		expect(systemTwo).toBe(systemOne);

		// So no cache warning was raised on the second turn.
		expect(onlyExchange(second.state).signals.map((s) => s.code)).not.toContain(
			"cache-invalidated",
		);
	});

	it("does not send the current question twice", async () => {
		const model = fakeModel();
		const first = await run({ send: model.send, question: "first question" });
		await run({
			send: model.send,
			question: "second question",
			conversation: conversationTurns(first.state),
			state: first.state,
		});
		const turnTwo = model.calls[1] as OllamaChatMessage[];
		const occurrences = turnTwo.filter((m) => m.content.includes("second question")).length;
		expect(occurrences).toBe(1);
	});
});

describe("no obsidian dependency", () => {
	it("imports nothing from obsidian anywhere under src/chat except the view", () => {
		// Same guard as `src/vault/resolver.test.ts` and `src/context/pack.test.ts`,
		// sharing their implementation. `view.ts` is the deliberate exception: it
		// is the Obsidian shell, and everything it would be tempting to put there
		// lives in these files instead precisely so it can be tested.
		//
		// This copy was the one that mattered. Anchored to `^\s*import[^\n]*`, it
		// passed a module whose import had been wrapped across lines — a real
		// impure file sat under `src/chat/` and the suite stayed green.
		const scan = scanForObsidianDependencies(dirname(fileURLToPath(import.meta.url)), {
			exclude: (file) => file.endsWith("view.ts"),
		});
		expect(scan.files.length).toBeGreaterThan(6);
		expect(scan.dependencies).toEqual([]);
	});
});
