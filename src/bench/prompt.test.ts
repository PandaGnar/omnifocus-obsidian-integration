import { describe, expect, it } from "vitest";

import { estimatePromptTokens } from "../ollama/protocol";
import { BENCH_QUESTION, buildBenchPrompt, buildFillerText } from "./prompt";

describe("buildFillerText", () => {
	it("is deterministic for a given label", () => {
		expect(buildFillerText("ctx-8192", 4000)).toBe(buildFillerText("ctx-8192", 4000));
	});

	it("produces different text for different labels", () => {
		const a = buildFillerText("ctx-8192", 2000);
		const b = buildFillerText("ctx-32768", 2000);
		expect(a).not.toBe(b);
		// Not merely different somewhere — different from the very start, so the
		// two cases cannot share a cacheable prefix.
		expect(a.slice(0, 40)).not.toBe(b.slice(0, 40));
	});

	it("reaches at least the requested length", () => {
		for (const target of [10, 500, 20_000]) {
			expect(buildFillerText("ctx-2048", target).length).toBeGreaterThanOrEqual(target);
		}
	});

	it("returns nothing for a non-positive target", () => {
		expect(buildFillerText("ctx-2048", 0)).toBe("");
		expect(buildFillerText("ctx-2048", -100)).toBe("");
	});
});

describe("buildBenchPrompt", () => {
	it("is byte-identical when built twice, which the cache measurement depends on", () => {
		const a = buildBenchPrompt({ label: "ctx-16384", targetTokens: 4000 });
		const b = buildBenchPrompt({ label: "ctx-16384", targetTokens: 4000 });
		expect(a.messages).toEqual(b.messages);
		expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
	});

	it("puts the case label in the first line so cases share no prefix", () => {
		const small = buildBenchPrompt({ label: "ctx-2048", targetTokens: 1000 });
		const large = buildBenchPrompt({ label: "ctx-32768", targetTokens: 4000 });
		expect(small.messages[0]?.content.startsWith("Benchmark case ctx-2048.")).toBe(true);
		expect(large.messages[0]?.content.startsWith("Benchmark case ctx-32768.")).toBe(true);
		expect(small.messages[0]?.content).not.toBe(large.messages[0]?.content);
	});

	it("hits the requested token target within the estimator's tolerance", () => {
		for (const target of [1408, 7552, 15744, 32128]) {
			const prompt = buildBenchPrompt({ label: `ctx-${target}`, targetTokens: target });
			expect(prompt.estimatedTokens).toBeGreaterThanOrEqual(target);
			// The generator overshoots by at most one line of filler plus framing.
			expect(prompt.estimatedTokens).toBeLessThan(target + 64);
		}
	});

	it("reports the same estimate the protocol estimator would", () => {
		const prompt = buildBenchPrompt({ label: "ctx-8192", targetTokens: 7552 });
		expect(prompt.estimatedTokens).toBe(estimatePromptTokens(prompt.messages));
	});

	it("ends with the bounded generation task, so decode length is controlled", () => {
		const prompt = buildBenchPrompt({ label: "ctx-2048", targetTokens: 1408 });
		expect(prompt.messages.at(-1)?.content.endsWith(BENCH_QUESTION)).toBe(true);
		expect(prompt.messages.at(-1)?.role).toBe("user");
	});

	it("still produces a valid prompt when the target is smaller than the framing", () => {
		const prompt = buildBenchPrompt({ label: "ctx-tiny", targetTokens: 0 });
		expect(prompt.messages).toHaveLength(2);
		expect(prompt.messages[1]?.content).toContain(BENCH_QUESTION);
	});
});
