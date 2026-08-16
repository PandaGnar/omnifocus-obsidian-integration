import { describe, expect, it } from "vitest";

import {
	CHARS_PER_TOKEN,
	TRUNCATION_MARKER,
	estimateMessageTokens,
	estimateTokens,
	truncateToTokens,
} from "./tokens";

const MARKDOWN = [
	"# 26 W33",
	"",
	"- [ ] Cutover rehearsal",
	"- [x] Dentist",
	"",
	"Notes: the migration plan is in `Long Term/26 Q3 Goals.md`.",
].join("\n");

describe("estimateTokens", () => {
	it("is zero for the empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("charges ASCII at the documented ratio, rounded up", () => {
		expect(estimateTokens("abc")).toBe(1);
		expect(estimateTokens("abcd")).toBe(2);
		expect(estimateTokens("a".repeat(300))).toBe(100);
	});

	it("charges non-ASCII far more than ASCII", () => {
		// CJK and emoji tokenize at roughly one to two tokens per character, so
		// dividing them by three would be an under-estimate — the one direction
		// the budget must never err in.
		expect(estimateTokens("日本語")).toBe(6);
		expect(estimateTokens("—")).toBe(2);
		// An astral code point is one character, not two surrogates.
		expect(estimateTokens("🙂")).toBe(2);
	});

	it("over-estimates against the four-characters-per-token rule of thumb", () => {
		// The whole point of the heuristic: it must sit above the number a real
		// tokenizer would return for ordinary English markdown, so the budget
		// errs towards sending less rather than towards silent truncation.
		const optimistic = MARKDOWN.length / 4;
		expect(estimateTokens(MARKDOWN)).toBeGreaterThan(optimistic);
	});

	it("is a flat three characters per token, which dense markdown beats", () => {
		// The other half of the calibration, and the reason the header comment
		// does not claim the estimator is a ceiling. These are the vault's own
		// shapes, not pathological input, and a real tokenizer splits them finer
		// than three characters per token — so they are *under*-estimated here.
		const table = "| --- | --- | --- | --- | --- |";
		expect(table.length).toBe(31);
		expect(estimateTokens(table)).toBe(11); // a tokenizer gives ~12
		const wikilink = "[[Long Term/26 W33 Goals|W33]]";
		expect(wikilink.length).toBe(30);
		expect(estimateTokens(wikilink)).toBe(10); // a tokenizer gives ~12-14
		// What keeps the pack safe is therefore the headroom under num_ctx, not
		// this divisor — see budget.test.ts.
	});

	it("is stable — the same string always costs the same", () => {
		expect(estimateTokens(MARKDOWN)).toBe(estimateTokens(MARKDOWN));
	});

	it("grows monotonically as text is appended", () => {
		expect(estimateTokens(`${MARKDOWN}\nmore`)).toBeGreaterThanOrEqual(
			estimateTokens(MARKDOWN),
		);
	});

	it("charges chat-template overhead per message", () => {
		expect(estimateMessageTokens(MARKDOWN)).toBeGreaterThan(estimateTokens(MARKDOWN));
	});
});

describe("truncateToTokens", () => {
	const long = Array.from({ length: 200 }, (_, i) => `- line ${i} of the note`).join("\n");

	it("leaves text that fits completely alone", () => {
		const cut = truncateToTokens(MARKDOWN, 1000);
		expect(cut.truncated).toBe(false);
		expect(cut.text).toBe(MARKDOWN);
		expect(cut.tokens).toBe(cut.originalTokens);
	});

	it("cuts to at most the cap, marker included", () => {
		const cut = truncateToTokens(long, 100);
		expect(cut.truncated).toBe(true);
		expect(cut.tokens).toBeLessThanOrEqual(100);
		expect(estimateTokens(cut.text)).toBeLessThanOrEqual(100);
		expect(cut.originalTokens).toBeGreaterThan(100);
	});

	it("keeps the head and says that it cut", () => {
		const cut = truncateToTokens(long, 100);
		expect(cut.text.startsWith("- line 0 of the note")).toBe(true);
		expect(cut.text.endsWith(TRUNCATION_MARKER)).toBe(true);
		expect(cut.text).not.toContain("- line 199 ");
	});

	it("cuts at a line boundary", () => {
		const body = truncateToTokens(long, 100).text.slice(0, -TRUNCATION_MARKER.length);
		for (const line of body.split("\n")) {
			expect(line === "" || /^- line \d+ of the note$/.test(line)).toBe(true);
		}
	});

	it("is deterministic — the same document always cuts at the same line", () => {
		expect(truncateToTokens(long, 100).text).toBe(truncateToTokens(long, 100).text);
	});

	it("falls back to a character cut when a single line is too long", () => {
		const oneLine = "x".repeat(5000);
		const cut = truncateToTokens(oneLine, 50);
		expect(cut.truncated).toBe(true);
		expect(cut.tokens).toBeLessThanOrEqual(50);
		expect(cut.text.length).toBeGreaterThan(CHARS_PER_TOKEN * 10);
	});

	it("honours the cap on a single long line of non-ASCII text", () => {
		// The character cut used to charge every code point the *ASCII* rate
		// while `estimateTokens` charges non-ASCII two tokens each, so it
		// overshot by up to 6x: an 800-token cap measured 4,720. One unwrapped
		// paragraph is all it takes, and Obsidian's soft wrap means people write
		// them routinely.
		const oneLine = "日".repeat(100_000);
		const cut = truncateToTokens(oneLine, 800);
		expect(cut.truncated).toBe(true);
		expect(estimateTokens(cut.text)).toBeLessThanOrEqual(800);
		expect(cut.tokens).toBe(estimateTokens(cut.text));
		// Still worth sending: it keeps as much as the cap allows.
		expect(estimateTokens(cut.text)).toBeGreaterThan(700);
	});

	it("never leaves a lone surrogate behind when it cuts", () => {
		const cut = truncateToTokens("🙂".repeat(5000), 100);
		expect(cut.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		expect(estimateTokens(cut.text)).toBeLessThanOrEqual(100);
	});

	it("keeps its cap on mixed content at every cap worth trying", () => {
		// The post-condition `pack.ts` leans on: the derived per-document caps
		// only add up to a group cap if a document at its cap really is at it.
		const mixed = [
			"# 見出し — a heading with an em dash",
			"| --- | --- | --- |",
			"- [ ] ascii task line that goes on for a while",
			"日本語の長い行".repeat(40),
			"[[Long Term/26 W33 Goals|W33]] ".repeat(30),
		].join("\n");
		for (const cap of [1, 2, 5, 17, 50, 123, 400, 1000]) {
			expect(estimateTokens(truncateToTokens(mixed, cap).text)).toBeLessThanOrEqual(cap);
		}
		for (const cap of [1, 2, 5, 17, 50, 123, 400]) {
			const oneLine = "日本語".repeat(3000);
			expect(estimateTokens(truncateToTokens(oneLine, cap).text)).toBeLessThanOrEqual(cap);
		}
	});

	it("returns nothing rather than a bare apology when the cap is tiny", () => {
		expect(truncateToTokens(long, 2).text).toBe("");
	});
});
