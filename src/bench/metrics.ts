// Timing arithmetic for the benchmark. Pure — no `obsidian`, no network, no
// clock of its own — so every conversion below is unit-testable.
//
// THE UNIT TRAP, stated once: Ollama reports every duration in *nanoseconds*
// (`total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration`).
// Wall-clock numbers we take ourselves are milliseconds. Mixing the two is a
// 1,000,000x error that still renders as a plausible-looking table, which is
// exactly the kind of wrong number this whole PR exists to avoid. Every
// nanosecond value crosses into milliseconds through `nsToMs` and nowhere else.

import type { OllamaChatResponse } from "../ollama/types";

export const NS_PER_MS = 1_000_000;
export const NS_PER_SECOND = 1_000_000_000;

/**
 * Nanoseconds to milliseconds, or null when the server did not report a usable
 * number. Null is deliberate: a missing counter must render as "n/a", never as
 * a zero that reads like a measurement.
 */
export function nsToMs(ns: number | null | undefined): number | null {
	if (typeof ns !== "number" || !Number.isFinite(ns) || ns < 0) return null;
	return ns / NS_PER_MS;
}

/**
 * Tokens per second from a token count and a duration *in nanoseconds*.
 * Returns null rather than Infinity when the duration is zero — some builds
 * report `0` for a fully cache-hit prefill, and "∞ tok/s" is not a result.
 */
export function tokensPerSecond(
	count: number | null | undefined,
	durationNs: number | null | undefined,
): number | null {
	if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
	if (typeof durationNs !== "number" || !Number.isFinite(durationNs) || durationNs <= 0) {
		return null;
	}
	return count / (durationNs / NS_PER_SECOND);
}

function finiteOrNull(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * One measured `/api/chat` call, with prefill and decode kept strictly apart.
 *
 * They are separate because they fail separately: the user's complaint is
 * time-to-first-token on a long prompt (prefill), while decode on a small local
 * model is generally fine. A single blended tokens/sec number would average the
 * problem away — which is how tuning becomes folklore.
 */
export interface ChatMeasurement {
	/** Wall clock from request issued to the final frame, in ms. */
	wallMs: number;
	/**
	 * Wall clock from request issued to the *first* token reaching us, in ms.
	 * This is time-to-first-token as the user experiences it: it includes model
	 * load, queueing and prefill. Null if nothing streamed.
	 */
	ttftMs: number | null;
	/** Tokens the server actually evaluated. Far below the prompt on a cache hit. */
	promptEvalCount: number | null;
	/** Server-side prefill time, converted from `prompt_eval_duration` (ns). */
	prefillMs: number | null;
	/** Prefill throughput: prompt tokens evaluated per second. */
	prefillTokensPerSecond: number | null;
	/** Tokens generated. */
	evalCount: number | null;
	/** Server-side decode time, converted from `eval_duration` (ns). */
	decodeMs: number | null;
	/** Decode throughput: generated tokens per second. */
	decodeTokensPerSecond: number | null;
	/** Model load time (ns → ms). Non-trivial only on the first call after unload. */
	loadMs: number | null;
	/** Server's own end-to-end figure (ns → ms), for cross-checking `wallMs`. */
	totalMs: number | null;
	/** `stop`, `length`, … — `length` means we hit the num_predict cap. */
	doneReason: string | null;
}

export interface MeasureChatParams {
	final: OllamaChatResponse | null;
	/** Wall-clock milliseconds for the whole call. */
	wallMs: number;
	/** Wall-clock milliseconds to the first streamed token, if any arrived. */
	ttftMs: number | null;
}

/**
 * Fold a final `/api/chat` frame plus our own wall-clock stopwatch into one
 * measurement. Fields the server omitted stay null.
 */
export function measureChat(params: MeasureChatParams): ChatMeasurement {
	const final = params.final;
	const promptEvalCount = finiteOrNull(final?.prompt_eval_count);
	const evalCount = finiteOrNull(final?.eval_count);
	const doneReason = typeof final?.done_reason === "string" ? final.done_reason : null;
	return {
		wallMs: params.wallMs,
		ttftMs: finiteOrNull(params.ttftMs),
		promptEvalCount,
		prefillMs: nsToMs(final?.prompt_eval_duration),
		prefillTokensPerSecond: tokensPerSecond(promptEvalCount, final?.prompt_eval_duration),
		evalCount,
		decodeMs: nsToMs(final?.eval_duration),
		decodeTokensPerSecond: tokensPerSecond(evalCount, final?.eval_duration),
		loadMs: nsToMs(final?.load_duration),
		totalMs: nsToMs(final?.total_duration),
		doneReason,
	};
}

/**
 * What the second run of an identical prompt bought us.
 *
 * Ollama reuses the KV cache by longest common prefix, so a repeat of the same
 * prefix should come back with a `prompt_eval_count` near zero and a much lower
 * time-to-first-token. That is the single highest-leverage claim in the plan,
 * and this is the number that demonstrates it instead of asserting it.
 */
export interface CacheDelta {
	coldTtftMs: number | null;
	warmTtftMs: number | null;
	/**
	 * cold − warm, in ms, model load included. Positive means the cold run was
	 * slower. This is *not* the prompt-cache saving: see `loadFreeSavedMs`.
	 */
	ttftSavedMs: number | null;
	/**
	 * Model-load time the server reported inside each run's wall-clock TTFT.
	 * Rendered next to the saving rather than left in the JSON dump, because it
	 * is the one component of `cold − warm` that has nothing to do with the
	 * prompt cache.
	 */
	coldLoadMs: number | null;
	warmLoadMs: number | null;
	/**
	 * The prompt-cache saving proper: cold − warm with each side's model-load
	 * time removed.
	 *
	 * The benchmark changes `num_ctx` between cases, which forces the runtime to
	 * reload the model before every cold run and before no warm run. A raw
	 * cold − warm therefore charges a whole model load — seconds, on a multi-GB
	 * model — to the prompt cache. Null when the server did not report
	 * `load_duration` for both runs, because a saving that cannot be separated
	 * from a load is not a saving we can claim.
	 */
	loadFreeSavedMs: number | null;
	coldPromptEvalCount: number | null;
	warmPromptEvalCount: number | null;
	/**
	 * Fraction of the cold run's evaluated prompt tokens the warm run skipped,
	 * 0..1. Null when either count is missing or the cold count was zero.
	 */
	reusedFraction: number | null;
}

/**
 * Time-to-first-token with the model load taken out of it, or null when either
 * half is unknown. Clamped at zero: a `load_duration` larger than our own
 * stopwatch means the two clocks disagree, and a negative "time before the
 * first token" would be worse than an honest zero.
 */
function ttftExcludingLoad(measurement: ChatMeasurement): number | null {
	if (measurement.ttftMs === null || measurement.loadMs === null) return null;
	return Math.max(0, measurement.ttftMs - measurement.loadMs);
}

export function cacheDelta(cold: ChatMeasurement, warm: ChatMeasurement): CacheDelta {
	const ttftSavedMs =
		cold.ttftMs !== null && warm.ttftMs !== null ? cold.ttftMs - warm.ttftMs : null;
	const coldExcludingLoad = ttftExcludingLoad(cold);
	const warmExcludingLoad = ttftExcludingLoad(warm);
	const loadFreeSavedMs =
		coldExcludingLoad !== null && warmExcludingLoad !== null
			? coldExcludingLoad - warmExcludingLoad
			: null;
	const coldCount = cold.promptEvalCount;
	const warmCount = warm.promptEvalCount;
	const reusedFraction =
		coldCount !== null && warmCount !== null && coldCount > 0
			? Math.max(0, Math.min(1, (coldCount - warmCount) / coldCount))
			: null;
	return {
		coldTtftMs: cold.ttftMs,
		warmTtftMs: warm.ttftMs,
		ttftSavedMs,
		coldLoadMs: cold.loadMs,
		warmLoadMs: warm.loadMs,
		loadFreeSavedMs,
		coldPromptEvalCount: coldCount,
		warmPromptEvalCount: warmCount,
		reusedFraction,
	};
}

/** `1234.5 ms` / `2.31 s`, or `n/a` for a counter the server never sent. */
export function formatMs(ms: number | null): string {
	if (ms === null) return "n/a";
	if (ms < 1000) return `${ms.toFixed(1)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

/** `18.4 tok/s`, or `n/a`. */
export function formatRate(perSecond: number | null): string {
	if (perSecond === null) return "n/a";
	return `${perSecond.toFixed(1)} tok/s`;
}

/** `42%`, or `n/a`. */
export function formatPercent(fraction: number | null): string {
	if (fraction === null) return "n/a";
	return `${Math.round(fraction * 100)}%`;
}

/** `8192`, or `n/a` — never `0`, which would read as a measured zero. */
export function formatCount(count: number | null): string {
	return count === null ? "n/a" : String(count);
}
