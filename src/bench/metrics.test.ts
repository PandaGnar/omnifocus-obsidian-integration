import { describe, expect, it } from "vitest";

import type { OllamaChatResponse } from "../ollama/types";
import {
	NS_PER_MS,
	NS_PER_SECOND,
	cacheDelta,
	formatCount,
	formatMs,
	formatPercent,
	formatRate,
	measureChat,
	nsToMs,
	tokensPerSecond,
	type ChatMeasurement,
} from "./metrics";

/**
 * A recorded-shape final frame. The numbers are chosen so that a unit mistake
 * cannot hide: prefill and decode differ by a factor of 40 in rate, and both
 * durations are round numbers in nanoseconds.
 */
const FINAL: OllamaChatResponse = {
	model: "test-model",
	done: true,
	done_reason: "stop",
	// 8000 prompt tokens in 4 s → 2000 tok/s prefill.
	prompt_eval_count: 8000,
	prompt_eval_duration: 4 * NS_PER_SECOND,
	// 128 generated tokens in 2.56 s → 50 tok/s decode.
	eval_count: 128,
	eval_duration: 2.56 * NS_PER_SECOND,
	load_duration: 250 * NS_PER_MS,
	total_duration: 7 * NS_PER_SECOND,
};

describe("nsToMs", () => {
	it("converts nanoseconds to milliseconds", () => {
		expect(nsToMs(1_000_000)).toBe(1);
		expect(nsToMs(4 * NS_PER_SECOND)).toBe(4000);
		expect(nsToMs(250_000)).toBe(0.25);
	});

	it("returns null for values that are not a usable duration", () => {
		expect(nsToMs(undefined)).toBeNull();
		expect(nsToMs(null)).toBeNull();
		expect(nsToMs(-1)).toBeNull();
		expect(nsToMs(Number.NaN)).toBeNull();
		expect(nsToMs(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("treats zero as a real duration, not a missing one", () => {
		expect(nsToMs(0)).toBe(0);
	});
});

describe("tokensPerSecond", () => {
	it("divides a token count by a nanosecond duration", () => {
		expect(tokensPerSecond(8000, 4 * NS_PER_SECOND)).toBe(2000);
		expect(tokensPerSecond(128, 2.56 * NS_PER_SECOND)).toBeCloseTo(50, 6);
	});

	it("returns null rather than Infinity for a zero duration", () => {
		// Seen on a fully cache-hit prefill: count 1, duration 0.
		expect(tokensPerSecond(1, 0)).toBeNull();
	});

	it("returns null when either side is missing", () => {
		expect(tokensPerSecond(undefined, NS_PER_SECOND)).toBeNull();
		expect(tokensPerSecond(100, undefined)).toBeNull();
	});
});

describe("measureChat", () => {
	const measurement = measureChat({ final: FINAL, wallMs: 6800, ttftMs: 4300 });

	it("reports prefill and decode separately, and does not swap them", () => {
		expect(measurement.prefillMs).toBe(4000);
		expect(measurement.decodeMs).toBe(2560);
		expect(measurement.prefillTokensPerSecond).toBe(2000);
		expect(measurement.decodeTokensPerSecond).toBeCloseTo(50, 6);
		// The whole point of the harness: these two are not interchangeable.
		expect(measurement.prefillTokensPerSecond).not.toBeCloseTo(
			measurement.decodeTokensPerSecond ?? 0,
			6,
		);
	});

	it("converts every server duration out of nanoseconds", () => {
		expect(measurement.loadMs).toBe(250);
		expect(measurement.totalMs).toBe(7000);
		// A nanosecond value mistaken for milliseconds would be a million times
		// larger than the wall clock, which is the mistake this pins.
		expect(measurement.totalMs).toBeLessThan(measurement.wallMs * 2);
	});

	it("keeps our wall-clock numbers in milliseconds, untouched", () => {
		expect(measurement.wallMs).toBe(6800);
		expect(measurement.ttftMs).toBe(4300);
	});

	it("carries the stop reason through", () => {
		expect(measurement.doneReason).toBe("stop");
		expect(measureChat({ final: { done_reason: "length" }, wallMs: 1, ttftMs: null }).doneReason).toBe(
			"length",
		);
	});

	it("degrades to nulls when the server sent no counters", () => {
		const empty = measureChat({ final: null, wallMs: 12, ttftMs: null });
		expect(empty.promptEvalCount).toBeNull();
		expect(empty.prefillMs).toBeNull();
		expect(empty.decodeTokensPerSecond).toBeNull();
		expect(empty.doneReason).toBeNull();
		// Never zero: a zero would render as a measurement.
		expect(empty.prefillTokensPerSecond).not.toBe(0);
		expect(empty.wallMs).toBe(12);
	});
});

function measurementWith(overrides: Partial<ChatMeasurement>): ChatMeasurement {
	return { ...measureChat({ final: FINAL, wallMs: 100, ttftMs: 50 }), ...overrides };
}

describe("cacheDelta", () => {
	it("reports the time-to-first-token the cache saved", () => {
		const cold = measurementWith({ ttftMs: 4300, promptEvalCount: 8000 });
		const warm = measurementWith({ ttftMs: 210, promptEvalCount: 12 });
		const delta = cacheDelta(cold, warm);
		expect(delta.ttftSavedMs).toBeCloseTo(4090, 6);
		expect(delta.coldTtftMs).toBe(4300);
		expect(delta.warmTtftMs).toBe(210);
		expect(delta.reusedFraction).toBeCloseTo((8000 - 12) / 8000, 6);
	});

	it("does not invert the subtraction when the warm run was slower", () => {
		const delta = cacheDelta(
			measurementWith({ ttftMs: 100 }),
			measurementWith({ ttftMs: 400 }),
		);
		expect(delta.ttftSavedMs).toBe(-300);
	});

	it("clamps reuse into 0..1 and returns null when it cannot be computed", () => {
		expect(
			cacheDelta(
				measurementWith({ promptEvalCount: 100 }),
				measurementWith({ promptEvalCount: 250 }),
			).reusedFraction,
		).toBe(0);
		expect(
			cacheDelta(
				measurementWith({ promptEvalCount: 0 }),
				measurementWith({ promptEvalCount: 0 }),
			).reusedFraction,
		).toBeNull();
		expect(
			cacheDelta(
				measurementWith({ promptEvalCount: null }),
				measurementWith({ promptEvalCount: 10 }),
			).reusedFraction,
		).toBeNull();
	});

	it("returns a null saving when either run never streamed a token", () => {
		expect(
			cacheDelta(measurementWith({ ttftMs: null }), measurementWith({ ttftMs: 10 }))
				.ttftSavedMs,
		).toBeNull();
	});

	it("keeps model-load time out of the prompt-cache saving", () => {
		// The shape the benchmark actually produces: changing num_ctx per case
		// reloads the model before every cold run and before no warm run, so the
		// cold TTFT carries 3 s of load the cache had nothing to do with. The raw
		// difference is 4090 ms; the cache is worth 1090 ms of it.
		const cold = measurementWith({ ttftMs: 4300, loadMs: 3000, promptEvalCount: 8000 });
		const warm = measurementWith({ ttftMs: 210, loadMs: 0, promptEvalCount: 12 });
		const delta = cacheDelta(cold, warm);
		expect(delta.ttftSavedMs).toBeCloseTo(4090, 6);
		expect(delta.loadFreeSavedMs).toBeCloseTo(1090, 6);
		expect(delta.coldLoadMs).toBe(3000);
		expect(delta.warmLoadMs).toBe(0);
	});

	it("reports no load-free saving at all rather than guessing when load is unreported", () => {
		const cold = measurementWith({ ttftMs: 4300, loadMs: null });
		const warm = measurementWith({ ttftMs: 210, loadMs: 0 });
		const delta = cacheDelta(cold, warm);
		expect(delta.loadFreeSavedMs).toBeNull();
		// The raw figure survives, clearly labelled as the one that includes load.
		expect(delta.ttftSavedMs).toBeCloseTo(4090, 6);
	});

	it("does not invert the load-free subtraction either", () => {
		const delta = cacheDelta(
			measurementWith({ ttftMs: 100, loadMs: 10 }),
			measurementWith({ ttftMs: 400, loadMs: 0 }),
		);
		expect(delta.loadFreeSavedMs).toBe(-310);
	});
});

describe("formatting", () => {
	it("uses milliseconds below a second and seconds above", () => {
		expect(formatMs(942.37)).toBe("942.4 ms");
		expect(formatMs(4300)).toBe("4.30 s");
		expect(formatMs(0)).toBe("0.0 ms");
	});

	it("renders a missing value as n/a rather than zero", () => {
		expect(formatMs(null)).toBe("n/a");
		expect(formatRate(null)).toBe("n/a");
		expect(formatPercent(null)).toBe("n/a");
		expect(formatCount(null)).toBe("n/a");
	});

	it("renders present values", () => {
		expect(formatRate(50.04)).toBe("50.0 tok/s");
		expect(formatPercent(0.9985)).toBe("100%");
		expect(formatPercent(0.5)).toBe("50%");
		expect(formatCount(8192)).toBe("8192");
		expect(formatCount(0)).toBe("0");
	});
});
