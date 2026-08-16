// Token *estimation*. There is no tokenizer available offline — the plugin is
// local-only and we are not shipping a 2 MB vocabulary file to count budget
// characters — so everything here is a heuristic.
//
// What the heuristic is
// ---------------------
//   ascii tokens = ceil(ascii characters / 3)
//   other tokens = non-ASCII code points x 2
//
// What it is *not*: a bound. Read the next section before leaning on it.
//
// Calibration, honestly
// ---------------------
// A SentencePiece/BPE tokenizer on English prose averages ~4 characters per
// token, so dividing by 3 over-estimates prose by roughly 10-40%. That much is
// true and it is the common case.
//
// But three characters per token is a *middling* rate for this vault, not a
// pessimistic one, because the vault is not prose. Its own dominant shapes
// tokenize below 3 chars/token and are therefore *under*-estimated here:
//
//   `| --- | --- | --- | --- | --- |`     31 chars, ~12 tokens   (~2.6)
//   `[[Long Term/26 W33 Goals|W33]]`      30 chars, ~12-14       (~2.3)
//   `# H1` / `## H2` / `### H3` runs                             (~1.5)
//
// Those are tables, wikilinks and heading runs — which is exactly what
// `Mise/xx.xx.xx Mise.md` and the `Goals` docs are made of. So the estimator is
// *roughly calibrated*: it over-estimates prose by 10-40% and under-estimates
// dense structure by 10-50%. Treating it as a ceiling is wrong. (These are
// informed estimates, not measurements — Gemma 4's tokenizer is not available
// to us offline either.)
//
// What actually keeps us safe
// ---------------------------
// **The headroom in `budget.ts`, not the divisor.** The failure being budgeted
// against is silent: when a prompt exceeds `num_ctx`, Ollama keeps the newest
// tokens and drops the oldest with no error, decapitating exactly the stable
// goal docs the pack puts at the top. What prevents that is the gap between the
// pack budget and `num_ctx` — see `headroomTokens`. For the whole pack to bust
// `num_ctx` the estimate would have to be wrong by the ratio of `num_ctx -
// num_predict` to the budget, i.e. a real aggregate rate of well under 2
// characters per token across the entire prompt, which mixed markdown does not
// reach even though individual lines do.
//
// **Therefore: do not tighten the budget toward `num_ctx` on the grounds that
// the estimator is conservative.** It is not conservative enough to carry that.
// A budget change has to be argued from the headroom that survives it.
//
// The authoritative check exists elsewhere and is ex-post: PR 2's Ollama client
// compares the response's `prompt_eval_count` against the count we believed we
// sent and reports a truncation when it comes back pinned at `num_ctx`. This
// file is the cheap ex-ante guess. The two meet at a seam, not a dependency —
// nothing here imports the client, and the client does not import this.

/**
 * ASCII characters assumed per token. Close to the real rate for this vault's
 * mixed markdown rather than a safe lower bound — see the header.
 */
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
 * `estimateTokens(result.text) <= maxTokens` is a post-condition on every path,
 * including the single-line fallback and including non-ASCII text. `pack.ts`
 * relies on it: the per-document caps are sized so that a group's worth of
 * documents at their cap still fits the group cap, and that arithmetic is only
 * sound if a document at its cap really is at its cap.
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
		// One enormous line — a minified block or a single unwrapped paragraph,
		// or an Obsidian note whose author let soft-wrap do the wrapping. Fall
		// back to a character cut so the section is not lost entirely.
		//
		// Walked code point by code point rather than sliced at
		// `budget * CHARS_PER_TOKEN`: that shortcut charges every character the
		// *ASCII* rate, while `estimateTokens` charges non-ASCII code points
		// `NON_ASCII_TOKENS_PER_CHAR`, so on CJK-heavy text it overshot the cap
		// by up to 6x (an 800-token cap measured 4,720). This is the one place
		// in the module that used to round in favour of the prompt.
		//
		// The running cost is recomputed the same way `estimateTokens` does it,
		// in integers, so `estimateTokens(head) <= budget` holds exactly rather
		// than up to a rounding error. It stops at the cap, so it is O(budget)
		// regardless of how long the line is.
		let ascii = 0;
		let other = 0;
		let end = 0;
		for (const ch of text) {
			const isAscii = (ch.codePointAt(0) ?? 0) < 128;
			const nextAscii = isAscii ? ascii + 1 : ascii;
			const nextOther = isAscii ? other : other + 1;
			const cost =
				Math.ceil(nextAscii / CHARS_PER_TOKEN) + nextOther * NON_ASCII_TOKENS_PER_CHAR;
			if (cost > budget) break;
			ascii = nextAscii;
			other = nextOther;
			// `ch` is a code point, so this advances past both halves of a
			// surrogate pair and never leaves a lone surrogate behind.
			end += ch.length;
		}
		const out = text.slice(0, end) + TRUNCATION_MARKER;
		return { text: out, truncated: true, originalTokens, tokens: estimateTokens(out) };
	}

	const out = lines.slice(0, kept).join("\n").trimEnd() + TRUNCATION_MARKER;
	return { text: out, truncated: true, originalTokens, tokens: estimateTokens(out) };
}
