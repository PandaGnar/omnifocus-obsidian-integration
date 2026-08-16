import { describe, expect, it } from "vitest";

import type { ChatSource } from "./sources";
import {
	EMPTY_SESSION,
	type ChatEvent,
	type ChatSessionState,
	activeExchange,
	conversationTurns,
	reduceAll,
	reduceChat,
} from "./session";

const ask = (question: string): ChatEvent => ({ kind: "ask", question });
const token = (text: string): ChatEvent => ({ kind: "token", text });
const finish: ChatEvent = { kind: "finish", signals: [] };

const source: ChatSource = {
	id: "goal:quarter",
	path: "Long Term/26 Q3 Goals.md",
	title: "Quarter goals - 26 Q3 Goals",
	kind: "goal",
	truncated: false,
	note: null,
};

const answered = (question: string, answer: string): ChatEvent[] => [
	ask(question),
	token(answer),
	finish,
];

function last(state: ChatSessionState) {
	const exchange = state.exchanges[state.exchanges.length - 1];
	if (exchange === undefined) throw new Error("no exchanges");
	return exchange;
}

describe("asking", () => {
	it("opens an exchange and marks the session busy", () => {
		const state = reduceChat(EMPTY_SESSION, ask("what now?"));
		expect(state.busy).toBe(true);
		expect(last(state).question).toBe("what now?");
		expect(last(state).status).toBe("pending");
		expect(last(state).answer).toBe("");
	});

	it("refuses a second question while one is generating", () => {
		const busy = reduceChat(EMPTY_SESSION, ask("first"));
		// Identity, not just equality: the view repaints only when the state
		// actually moved, so a dropped event has to be the same object.
		expect(reduceChat(busy, ask("second"))).toBe(busy);
	});

	it("hands each exchange a distinct id, including across a clear", () => {
		const state = reduceAll(EMPTY_SESSION, [
			...answered("one", "a"),
			...answered("two", "b"),
		]);
		const ids = state.exchanges.map((e) => e.id);
		expect(new Set(ids).size).toBe(2);
		const cleared = reduceAll(state, [{ kind: "clear" }, ask("three")]);
		expect(ids).not.toContain(last(cleared).id);
	});
});

describe("streaming", () => {
	it("accumulates tokens in arrival order", () => {
		const state = reduceAll(EMPTY_SESSION, [
			ask("q"),
			token("Focus "),
			token("on "),
			token("the migration."),
		]);
		expect(last(state).answer).toBe("Focus on the migration.");
		expect(last(state).status).toBe("streaming");
	});

	it("attaches the sources and the pack's signals before any token", () => {
		const state = reduceAll(EMPTY_SESSION, [
			ask("q"),
			{
				kind: "context",
				sources: [source],
				signals: [{ code: "context-gap", level: "warning", text: "no W32" }],
			},
		]);
		expect(last(state).sources).toEqual([source]);
		expect(last(state).signals.map((s) => s.code)).toEqual(["context-gap"]);
		expect(last(state).status).toBe("pending");
	});

	it("appends the response signals at the end without losing the pack's", () => {
		const state = reduceAll(EMPTY_SESSION, [
			ask("q"),
			{ kind: "context", sources: [source], signals: [{ code: "a", level: "info", text: "a" }] },
			token("x"),
			{ kind: "finish", signals: [{ code: "b", level: "warning", text: "b" }] },
		]);
		expect(last(state).signals.map((s) => s.code)).toEqual(["a", "b"]);
		expect(last(state).status).toBe("done");
		expect(state.busy).toBe(false);
	});
});

describe("cancelling", () => {
	it("keeps whatever arrived and stops the session being busy", () => {
		const state = reduceAll(EMPTY_SESSION, [ask("q"), token("half an ans"), { kind: "cancel" }]);
		expect(last(state).status).toBe("cancelled");
		expect(last(state).answer).toBe("half an ans");
		expect(state.busy).toBe(false);
	});

	it("drops tokens that arrive after the cancel", () => {
		// The real failure this prevents: `requestUrl` cannot be aborted, so a
		// buffered generation can still deliver after the user has given up on
		// it. Appending it would rewrite an answer they stopped reading.
		const cancelled = reduceAll(EMPTY_SESSION, [
			ask("q"),
			token("half"),
			{ kind: "cancel" },
		]);
		const after = reduceChat(cancelled, token(" the rest"));
		expect(after).toBe(cancelled);
		expect(last(after).answer).toBe("half");
	});

	it("ignores a finish that lands after a cancel", () => {
		const cancelled = reduceAll(EMPTY_SESSION, [ask("q"), { kind: "cancel" }]);
		expect(reduceChat(cancelled, finish)).toBe(cancelled);
		expect(last(cancelled).status).toBe("cancelled");
	});

	it("ignores a cancel when nothing is generating", () => {
		const done = reduceAll(EMPTY_SESSION, answered("q", "a"));
		expect(reduceChat(done, { kind: "cancel" })).toBe(done);
		expect(reduceChat(EMPTY_SESSION, { kind: "cancel" })).toBe(EMPTY_SESSION);
	});

	it("frees the session so the next question can be asked", () => {
		const state = reduceAll(EMPTY_SESSION, [ask("q"), { kind: "cancel" }, ask("q2")]);
		expect(state.exchanges).toHaveLength(2);
		expect(last(state).question).toBe("q2");
	});
});

describe("failing", () => {
	it("records the message and frees the session", () => {
		const state = reduceAll(EMPTY_SESSION, [ask("q"), { kind: "fail", message: "boom" }]);
		expect(last(state).status).toBe("error");
		expect(last(state).error).toBe("boom");
		expect(state.busy).toBe(false);
	});

	it("keeps partial output next to the error", () => {
		const state = reduceAll(EMPTY_SESSION, [
			ask("q"),
			token("began "),
			{ kind: "fail", message: "connection reset" },
		]);
		expect(last(state).answer).toBe("began ");
	});
});

describe("clearing", () => {
	it("empties the conversation, because it is ephemeral by design", () => {
		const state = reduceAll(EMPTY_SESSION, [...answered("q", "a"), ...answered("q2", "b")]);
		const cleared = reduceChat(state, { kind: "clear" });
		expect(cleared.exchanges).toEqual([]);
		expect(cleared.busy).toBe(false);
	});
});

describe("conversationTurns", () => {
	it("pairs each completed exchange as user then assistant", () => {
		const state = reduceAll(EMPTY_SESSION, [
			...answered("what is the quarter goal?", "finish the migration"),
			...answered("and this week?", "cutover rehearsal"),
		]);
		expect(conversationTurns(state)).toEqual([
			{ role: "user", text: "what is the quarter goal?" },
			{ role: "assistant", text: "finish the migration" },
			{ role: "user", text: "and this week?" },
			{ role: "assistant", text: "cutover rehearsal" },
		]);
	});

	it("excludes the question currently being answered", () => {
		// This is what stops a turn's own question appearing twice — once as
		// history and once as the question.
		const state = reduceAll(EMPTY_SESSION, [...answered("first", "a"), ask("second")]);
		expect(conversationTurns(state)).toEqual([
			{ role: "user", text: "first" },
			{ role: "assistant", text: "a" },
		]);
	});

	it("excludes a cancelled turn's half answer", () => {
		const state = reduceAll(EMPTY_SESSION, [
			ask("q"),
			token("the first half of a thought"),
			{ kind: "cancel" },
		]);
		expect(conversationTurns(state)).toEqual([]);
	});

	it("excludes a failed turn", () => {
		const state = reduceAll(EMPTY_SESSION, [ask("q"), { kind: "fail", message: "boom" }]);
		expect(conversationTurns(state)).toEqual([]);
	});
});

describe("activeExchange", () => {
	it("is the in-flight exchange and nothing else", () => {
		expect(activeExchange(EMPTY_SESSION)).toBeNull();
		expect(activeExchange(reduceChat(EMPTY_SESSION, ask("q")))?.question).toBe("q");
		expect(activeExchange(reduceAll(EMPTY_SESSION, answered("q", "a")))).toBeNull();
	});
});
