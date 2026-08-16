import { describe, expect, it } from "vitest";

import type { ChatResult } from "../ollama/client";
import { IN_THE_W32_GAP, TODAY, buildFixturePack } from "./fixtures/harness";
import {
	type ChatSignal,
	hasWarning,
	packSignals,
	renderSignalsMarkdown,
	responseSignals,
} from "./signals";

const codes = (signals: readonly ChatSignal[]): string[] => signals.map((s) => s.code);

function result(overrides: Partial<ChatResult> = {}): ChatResult {
	return {
		content: "answer",
		streamed: true,
		latencyMs: 10,
		truncation: {
			status: "ok",
			promptEvalCount: 900,
			numCtx: 32_768,
			estimatedPromptTokens: 900,
			estimatedDroppedTokens: null,
			message: "Prompt fit: 900 of 32768 context tokens evaluated.",
		},
		final: { done: true, prompt_eval_count: 900 },
		...overrides,
	};
}

describe("packSignals", () => {
	it("surfaces the W32 gap as a warning naming both documents", async () => {
		const pack = await buildFixturePack({ date: IN_THE_W32_GAP });
		const gaps = packSignals(pack).filter((s) => s.code === "context-gap");
		const week = gaps.find((s) => s.text.includes("W32"));
		expect(week).toBeDefined();
		expect(week?.level).toBe("warning");
		// Both halves matter: what was asked for, and what was used instead.
		expect(week?.text).toContain("26 W32 Goals");
		expect(week?.text).toContain("26 W31 Goals");
	});

	it("reports the missing month doc even on a day whose week doc exists", async () => {
		// 2026 has `26 M07` and no `26 M08`; 16 August is in ISO week 33, which
		// the vault does have. So the month falls back while the week does not.
		const pack = await buildFixturePack({ date: TODAY });
		const gaps = packSignals(pack).filter((s) => s.code === "context-gap");
		expect(gaps.map((s) => s.text).join("\n")).toContain("26 M08 Goals");
		expect(gaps.map((s) => s.text).join("\n")).not.toContain("W33");
	});

	it("says nothing at all when the vault answered every request", async () => {
		const pack = await buildFixturePack({ date: TODAY });
		// The month gap is real, so this asserts the shape rather than silence:
		// every signal is traceable to a notice the pack recorded.
		expect(packSignals(pack)).toHaveLength(pack.notices.length);
	});

	it("warns when the budget dropped a document", async () => {
		const base = await buildFixturePack();
		const squeezed = await buildFixturePack({
			budget: { ...base.budget, groups: { ...base.budget.groups, dailies: 0 } },
		});
		const dropped = packSignals(squeezed).filter((s) => s.code === "context-dropped");
		expect(dropped.length).toBeGreaterThan(0);
		expect(dropped.every((s) => s.level === "warning")).toBe(true);
	});

	it("keeps duplicate reports as information rather than alarm", async () => {
		const pack = await buildFixturePack();
		for (const signal of packSignals(pack)) {
			if (signal.code === "context-duplicate") expect(signal.level).toBe("info");
		}
	});
});

describe("responseSignals", () => {
	it("says nothing when the request was ordinary", () => {
		expect(responseSignals(result())).toEqual([]);
	});

	it("surfaces a prompt pinned at num_ctx", () => {
		const signals = responseSignals(
			result({
				truncation: {
					status: "truncated",
					promptEvalCount: 32_768,
					numCtx: 32_768,
					estimatedPromptTokens: 40_000,
					estimatedDroppedTokens: 7232,
					message: "Prompt was truncated: Ollama evaluated 32768 tokens.",
				},
			}),
		);
		expect(codes(signals)).toContain("prompt-truncated");
		expect(hasWarning(signals)).toBe(true);
		// The client's own wording, not a paraphrase: it is the module that
		// knows the numbers.
		expect(signals[0]?.text).toContain("32768");
	});

	it("surfaces a reply cut off at num_predict", () => {
		const signals = responseSignals(
			result({ final: { done: true, done_reason: "length", prompt_eval_count: 900 } }),
		);
		expect(codes(signals)).toContain("reply-capped");
		expect(hasWarning(signals)).toBe(true);
	});

	it("does not cry cap when the model simply stopped", () => {
		const signals = responseSignals(
			result({ final: { done: true, done_reason: "stop", prompt_eval_count: 900 } }),
		);
		expect(codes(signals)).not.toContain("reply-capped");
	});

	it("surfaces an answer that was buffered rather than streamed", () => {
		const signals = responseSignals(result({ streamed: false }));
		expect(codes(signals)).toContain("not-streamed");
		// Not a warning: the answer is fine. But the user's cancel button had
		// less to cancel than they thought, so it is still said out loud.
		expect(hasWarning(signals)).toBe(false);
		expect(signals[0]?.text).toContain("OLLAMA_ORIGINS");
	});

	it("admits when truncation could not be checked at all", () => {
		const signals = responseSignals(
			result({
				truncation: {
					status: "unknown",
					promptEvalCount: null,
					numCtx: 32_768,
					estimatedPromptTokens: null,
					estimatedDroppedTokens: null,
					message: "Ollama returned no prompt_eval_count.",
				},
			}),
		);
		expect(codes(signals)).toEqual(["prompt-truncation-unknown"]);
		expect(hasWarning(signals)).toBe(false);
	});

	it("reports all three at once when all three happened", () => {
		const signals = responseSignals(
			result({
				streamed: false,
				truncation: {
					status: "truncated",
					promptEvalCount: 32_768,
					numCtx: 32_768,
					estimatedPromptTokens: 40_000,
					estimatedDroppedTokens: 7232,
					message: "Prompt was truncated.",
				},
				final: { done: true, done_reason: "length", prompt_eval_count: 32_768 },
			}),
		);
		expect(codes(signals)).toEqual(["not-streamed", "prompt-truncated", "reply-capped"]);
	});
});

describe("renderSignalsMarkdown", () => {
	it("is empty for an unremarkable turn", () => {
		expect(renderSignalsMarkdown([])).toBe("");
	});

	it("bolds warnings and leaves information plain", () => {
		const markdown = renderSignalsMarkdown([
			{ code: "a", level: "warning", text: "the week doc is a fallback" },
			{ code: "b", level: "info", text: "buffered" },
		]);
		expect(markdown).toContain("**the week doc is a fallback**");
		expect(markdown).toContain("- buffered");
		expect(markdown).not.toContain("**buffered**");
	});
});
