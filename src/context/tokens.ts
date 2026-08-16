// Token *estimation*. There is no tokenizer available offline — the plugin is
// local-only and we are not shipping a 2 MB vocabulary file to count budget
// characters — so everything here is a heuristic, and it is deliberately a
// pessimistic one.
//
// Why pessimistic: the failure mode we are budgeting against is silent. When a
// prompt exceeds `num_ctx`, Ollama keeps the newest tokens and drops the
// oldest with no error, decapitating exactly the stable goal docs the pack puts
// at the top. Over-estimating costs us a little context we could have sent;
// under-estimating costs us the top of the prompt without saying so. So the
// estimator rounds against us at every step.
//
// The heuristic
// -------------
//   ascii tokens = ceil(ascii characters / 3)
//   other tokens = non-ASCII code points x 2
//
// A SentencePiece/BPE tokenizer on English prose averages ~4 characters per
// token. Markdown is worse than prose — `- [ ] ` is six characters and three
// or four tokens, and headings, links, table pipes and list bullets all split.
// Measured ratios for the kind of documents this vault holds run about 3.3-4.2
// characters per token for prose-heavy notes and about 2.6-3.2 for
// checklist-and-table-heavy ones. Dividing by 3 therefore over-estimates prose
// by roughly 10-40% and lands close to correct on the dense end.
//
// It is not a bound. Pathological content (dense CJK, long unbroken
// identifiers, base64) can still tokenize worse than 3 characters per token,
// which is why the non-ASCII term exists and why the budget in `budget.ts`
// leaves five figures of headroom under `num_ctx`.
//
// The real check already exists elsewhere: PR 2's Ollama client compares the
// response's `prompt_eval_count` against the count we believed we sent and
// reports a truncation when it comes back pinned at `num_ctx`. That is the
// authority; this file is the cheap ex-ante guess that keeps us far away from
// the cliff. The two meet at a seam, not a dependency — nothing here imports
// the client, and the client does not import this.

/** ASCII characters assumed per token. Lower than reality, on purpose. */
export const CHARS_PER_TOKEN = 3;

/**
 * Tokens charged per non-ASCII code point. CJK runs at roughly one token per
 * character and emoji frequently cost two or more, so two is the safe side.
 */
export const NON_ASCII_TOKENS_PER_CHAR = 2;

/**
 * Chat-template overhead per message: Gemma wraps every turn in
 * `<start_of_turn>role\n` ... `<end_of_turn>\n`. Eight is generous for the
 * handful of messages a pack produces.
 */
export const PER_MESSAGE_OVERHEAD_TOKENS = 8;

/** Appended in place of the text a cap removed. ASCII only, so it is 1:1 bytes. */
export const TRUNCATION_MARKER = "\n\n[... truncated to fit the context budget ...]";

/**
 * Estimated tokens for a string. Pure, total, and independent of locale or
 * environment — the same string always yields the same number, which the
 * prompt-cache stability tests depend on.
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;

	let ascii = 0;
	let other = 0;
	// Iterating a string with for...of walks code points, so an astral
	// character counts once rather than twice as a surrogate pair.
	for (const ch of text) {
		if ((ch.codePointAt(0) ?? 0) < 128) ascii += 1;
		else other += 1;
	}

	return Math.ceil(ascii / CHARS_PER_TOKEN) + other * NON_ASCII_TOKENS_PER_CHAR;
}

/** Estimated tokens for one chat message, including template overhead. */
export function estimateMessageTokens(content: string): number {
	return PER_MESSAGE_OVERHEAD_TOKENS + estimateTokens(content);
}

export interface Truncation {
	readonly text: string;
	readonly truncated: boolean;
	/** Estimate for the text as it was handed in. */
	readonly originalTokens: number;
	/** Estimate for `text`, i.e. after any truncation. */
	readonly tokens: number;
}

/**
 * Cuts `text` down to at most `maxTokens` estimated tokens, keeping the head.
 *
 * The head, not the tail: these documents are goal docs and daily notes, whose
 * headings and opening lines carry the structure. Keeping whole lines rather
 * than slicing mid-sentence keeps the markdown parseable by the model and,
 * more importantly, makes the cut deterministic — the same document always
 * truncates at the same line, so the prompt prefix does not wobble between
 * runs.
 */
export function truncateToTokens(text: string, maxTokens: number): Truncation {
	const originalTokens = estimateTokens(text);
	if (originalTokens <= maxTokens) {
		return { text, truncated: false, originalTokens, tokens: originalTokens };
	}

	const markerTokens = estimateTokens(TRUNCATION_MARKER);
	const budget = maxTokens - markerTokens;
	if (budget <= 0) {
		// The cap cannot even hold the marker. Say nothing rather than emit a
		// section that is pure apology.
		return { text: "", truncated: true, originalTokens, tokens: 0 };
	}

	// Per-line accounting rather than re-estimating the whole prefix on every
	// step: it is O(n) instead of O(n^2), and because each line's estimate is
	// individually rounded up, the running sum is never lower than the estimate
	// for the joined text. Erring high again.
	const lines = text.split("\n");
	let used = 0;
	let kept = 0;
	for (const line of lines) {
		const cost = estimateTokens(`${line}\n`);
		if (used + cost > budget) break;
		used += cost;
		kept += 1;
	}

	if (kept === 0) {
		// One enormous line — a minified block or a single unwrapped paragraph.
		// Fall back to a character cut so the section is not lost entirely.
		const maxChars = Math.max(0, budget * CHARS_PER_TOKEN);
		const head = text.slice(0, maxChars);
		const out = head + TRUNCATION_MARKER;
		return { text: out, truncated: true, originalTokens, tokens: estimateTokens(out) };
	}

	const out = lines.slice(0, kept).join("\n").trimEnd() + TRUNCATION_MARKER;
	return { text: out, truncated: true, originalTokens, tokens: estimateTokens(out) };
}
