// Deterministic synthetic prompts of a requested size.
//
// Two properties matter and both are load-bearing for the results:
//
//  1. **Byte-identical across runs.** The prompt-cache measurement compares two
//     requests that must share their entire prefix. Any drift — a timestamp, a
//     Math.random, a Map iteration order — invalidates the cache and turns the
//     headline measurement into noise. Hence a seeded generator over a fixed
//     vocabulary, and nothing else.
//  2. **No shared prefix between cases.** The 8K case must not warm the cache
//     for the 32K case, or every size after the first reports a false cache hit
//     on its "cold" run. Each case's text is seeded from, and prefixed with,
//     its own label, so the two prompts diverge in the first line.
//
// The token targets are approximate by construction: Ollama exposes no
// tokeniser over HTTP, so sizing uses the same chars/4 estimate as the rest of
// the plugin. That is fine here because the report prints the *server's*
// `prompt_eval_count` next to the nominal size — the label is the intent, the
// counter is the fact.

import { estimatePromptTokens } from "../ollama/protocol";
import type { OllamaChatMessage } from "../ollama/types";

/**
 * A short, bounded, easily-checked generation task. Bounded matters: decode
 * throughput is measured over these tokens, and an open-ended question would
 * make the decode sample length depend on the model's mood.
 */
export const BENCH_QUESTION =
	"Ignore the notes above. Reply with the numbers 1 to 40, one per line, and nothing else.";

const SYSTEM_PREAMBLE =
	"You are a benchmark fixture. Follow the final instruction exactly and add no commentary.";

/** Fixed vocabulary. Prose-shaped so tokenisation resembles the real workload. */
const VOCABULARY = [
	"goal",
	"quarter",
	"review",
	"weekly",
	"planning",
	"note",
	"vault",
	"draft",
	"focus",
	"habit",
	"project",
	"deadline",
	"morning",
	"evening",
	"context",
	"budget",
	"decision",
	"outcome",
	"blocker",
	"progress",
	"session",
	"cadence",
	"backlog",
	"checklist",
	"reflection",
	"intention",
	"energy",
	"attention",
	"commitment",
	"tradeoff",
] as const;

/** mulberry32: small, fast, and fully specified, so results reproduce exactly. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** FNV-1a, so a label maps to a stable seed without pulling in a hash library. */
function hashLabel(label: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < label.length; i += 1) {
		hash ^= label.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Filler text of at least `targetChars` characters, deterministic in `label`.
 * Shaped as numbered lines of prose rather than one blob, because a document of
 * repeated identical lines is not representative of what the plugin sends.
 */
export function buildFillerText(label: string, targetChars: number): string {
	if (targetChars <= 0) return "";
	const random = makeRandom(hashLabel(label));
	const lines: string[] = [];
	let length = 0;
	let index = 1;
	while (length < targetChars) {
		const wordCount = 8 + Math.floor(random() * 9);
		const words: string[] = [];
		for (let i = 0; i < wordCount; i += 1) {
			words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)] ?? "note");
		}
		const line = `${index}. ${words.join(" ")}.`;
		lines.push(line);
		length += line.length + 1;
		index += 1;
	}
	return lines.join("\n");
}

export interface BenchPrompt {
	/** Stable identifier for the case; also the generator seed. */
	label: string;
	messages: OllamaChatMessage[];
	/** Our chars/4 estimate for the whole message array. */
	estimatedTokens: number;
}

/**
 * Build a prompt of roughly `targetTokens`, identified by `label`.
 *
 * The label appears in the first line of the system message, which is the
 * cache-prefix guarantee: two cases cannot share a prefix beyond the chat
 * template's own preamble.
 */
export function buildBenchPrompt(params: {
	label: string;
	targetTokens: number;
}): BenchPrompt {
	const { label } = params;
	const targetTokens = Math.max(0, Math.floor(params.targetTokens));
	const system = `Benchmark case ${label}.\n${SYSTEM_PREAMBLE}`;
	const withoutFiller: OllamaChatMessage[] = [
		{ role: "system", content: system },
		{ role: "user", content: `\n\n${BENCH_QUESTION}` },
	];
	const overhead = estimatePromptTokens(withoutFiller);
	const fillerTokens = Math.max(0, targetTokens - overhead);
	// estimateTokens is ceil(chars / 4), so ask for 4 chars per wanted token.
	const filler = buildFillerText(label, fillerTokens * 4);
	const messages: OllamaChatMessage[] = [
		{ role: "system", content: system },
		{ role: "user", content: `${filler}\n\n${BENCH_QUESTION}` },
	];
	return { label, messages, estimatedTokens: estimatePromptTokens(messages) };
}
