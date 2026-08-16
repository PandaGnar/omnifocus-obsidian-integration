import { describe, expect, it } from "vitest";

import type { ContextPack, ConversationTurn } from "../context/types";
import type { CalendarDate } from "../vault/dates";
import { PrefixTracker, comparePrefixes, prefixSignal, snapshotPrefix } from "./prefix";
import { TODAY, buildFixturePack, d } from "./fixtures/harness";

/** Turns 1..n of a conversation, as `session.ts` would hand them to the pack. */
function history(n: number): ConversationTurn[] {
	const turns: ConversationTurn[] = [];
	for (let i = 1; i <= n; i += 1) {
		turns.push({ role: "user", text: `question number ${i}` });
		turns.push({ role: "assistant", text: `answer number ${i}, at some length` });
	}
	return turns;
}

describe("stable block across the turns of a conversation", () => {
	it("is byte-identical when the pack is rebuilt for each turn", async () => {
		// This is the property the chat view has to preserve and the reason the
		// pack is rebuilt rather than mutated: five turns, five separate builds,
		// one set of bytes for the ~6K-token stable block. If this fails, every
		// follow-up pays a cold prefill.
		const blocks: string[] = [];
		for (let turn = 0; turn < 5; turn += 1) {
			const pack = await buildFixturePack({
				question: `question number ${turn + 1}`,
				conversation: history(turn),
			});
			blocks.push(snapshotPrefix(pack).stableBlock);
		}
		expect(new Set(blocks).size).toBe(1);
		// Non-vacuous: the block is the real thing, not an empty string.
		expect(blocks[0]?.length).toBeGreaterThan(1000);
		expect(blocks[0]).toContain("26 Q3 Goals");
	});

	it("holds no date, because a date at the top would expire the cache daily", async () => {
		const pack = await buildFixturePack({ date: TODAY });
		const { stableBlock } = snapshotPrefix(pack);
		expect(stableBlock).not.toContain("Sunday 16 August 2026");
		expect(stableBlock).not.toContain("2026-08-16");
		// The date is present in the prompt, just not in the cached part.
		const question = pack.messages[pack.messages.length - 1]?.content ?? "";
		expect(question).toContain("Sunday 16 August 2026");
	});

	it("grows by appending only, never by rewriting", async () => {
		let previous: string | null = null;
		for (let turn = 0; turn < 4; turn += 1) {
			const pack = await buildFixturePack({
				question: `question number ${turn + 1}`,
				conversation: history(turn),
			});
			const { prefix } = snapshotPrefix(pack);
			if (previous !== null) {
				expect(prefix.startsWith(previous)).toBe(true);
				expect(prefix.length).toBeGreaterThan(previous.length);
			}
			previous = prefix;
		}
	});

	it("reports a held cache turn after turn", async () => {
		const tracker = new PrefixTracker();
		const observed = [];
		for (let turn = 0; turn < 3; turn += 1) {
			const pack = await buildFixturePack({
				question: `question number ${turn + 1}`,
				conversation: history(turn),
			});
			observed.push(tracker.observe(pack));
		}
		expect(observed.map((c) => c.first)).toEqual([true, false, false]);
		expect(observed.map((c) => c.cacheHeld)).toEqual([false, true, true]);
		expect(observed.every((c) => c.stableBlockUnchanged)).toBe(true);
		expect(observed.slice(1).every((c) => prefixSignal(c) === null)).toBe(true);
	});
});

describe("stable block across days", () => {
	// The other half of the same property, and the one the chat view inherits
	// rather than owns: a conversation held on Tuesday and continued on
	// Wednesday must reuse Tuesday's prefill when the vault has not moved on.
	// `pack.test.ts` asserts this of `stablePrefix`; this asserts it of the
	// bytes the chat view actually puts in the system message, which is what
	// Ollama matches on. The two are meant to be the same thing, and the day
	// they stop being the same thing is the day this becomes the test that
	// notices.

	/** The documents a pack settled on, ignoring how they were rendered. */
	const documents = (pack: ContextPack): string =>
		JSON.stringify(
			pack.sections
				.filter((section) => section.group === "stable" || section.group === "dailies")
				.map((section) => [section.id, section.path]),
		);

	const days = (start: CalendarDate, count: number): CalendarDate[] => {
		const out: CalendarDate[] = [];
		for (let i = 0; i < count; i += 1) {
			const at = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
			out.push({ year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() });
		}
		return out;
	};

	it("is byte-identical on any two days that resolve to the same documents", async () => {
		const seen = new Map<string, { date: CalendarDate; block: string }>();
		let comparisons = 0;
		for (const date of days(d(2026, 6, 1), 120)) {
			const pack = await buildFixturePack({ date });
			const block = snapshotPrefix(pack).stableBlock;
			const key = documents(pack);
			const first = seen.get(key);
			if (first === undefined) {
				seen.set(key, { date, block });
				continue;
			}
			comparisons += 1;
			expect(
				block,
				`${date.year}-${date.month}-${date.day} and ${first.date.year}-${first.date.month}-` +
					`${first.date.day} resolve to the same documents but sent different stable blocks`,
			).toBe(first.block);
		}
		// Non-vacuous in both directions: the sweep compared real pairs, and it
		// found more than one document set rather than trivially one.
		expect(comparisons).toBeGreaterThan(80);
		expect(seen.size).toBeGreaterThan(3);
	});

	it("is identical across a month boundary that falls back to the same goal doc", async () => {
		// The reported leak, at the chat layer. August asks for `26 M08` and
		// September for `26 M09`; the fixture has neither, so both settle on
		// `26 M07 Goals.md`. The admission that the asked-for doc is missing is
		// still made — at the bottom of the prompt, where a daily change is free.
		const august = await buildFixturePack({ date: d(2026, 8, 20) });
		const september = await buildFixturePack({ date: d(2026, 9, 20) });
		expect(documents(september)).toBe(documents(august));
		expect(snapshotPrefix(september).stableBlock).toBe(snapshotPrefix(august).stableBlock);
		expect(snapshotPrefix(august).stableBlock).not.toContain("26 M08");
		const tail = september.messages[september.messages.length - 1]?.content ?? "";
		expect(tail).toContain("no `26 M09 Goals` note exists");
	});
});

describe("when the cache is genuinely lost", () => {
	it("notices when an over-long question cost the pack a document", async () => {
		// The reachable route to a changed stable block, exercised end to end
		// rather than asserted about. The question is never truncated and never
		// dropped, so a question over its allowance takes the room out of the
		// context — and the next turn inherits a different prefix. The budget
		// here is shrunk so the test is a few kilobytes rather than a hundred;
		// the mechanism is `applyBudget`'s own, unmodified.
		const base = await buildFixturePack();
		const budget = {
			...base.budget,
			groups: {
				system: 200,
				stable: 400,
				dailies: 300,
				retrieved: 0,
				conversation: 200,
				question: 50,
			},
		};
		const tracker = new PrefixTracker();
		const first = await buildFixturePack({ budget, question: "short one?" });
		expect(tracker.observe(first).first).toBe(true);

		const second = await buildFixturePack({
			budget,
			question: "and now the long one. ".repeat(200),
		});
		expect(second.dropped.length).toBeGreaterThan(first.dropped.length);

		const comparison = tracker.observe(second);
		expect(comparison.stableBlockUnchanged).toBe(false);
		expect(comparison.cacheHeld).toBe(false);
		expect(prefixSignal(comparison)?.code).toBe("cache-invalidated");
	});

	it("points at the first byte that moved", () => {
		const comparison = comparePrefixes(
			{ stableBlock: "system prompt\nLife Goals", prefix: "system prompt\nLife Goals" },
			{ stableBlock: "system prompt\nLife Goalz", prefix: "system prompt\nLife Goalz" },
		);
		expect(comparison.stableBlockUnchanged).toBe(false);
		expect(comparison.divergedAt).toBe(23);
		expect(comparison.cacheHeld).toBe(false);
		expect(prefixSignal(comparison)?.text).toContain("standing context changed");
	});

	it("catches a rewritten turn even when the stable block held", () => {
		const comparison = comparePrefixes(
			{ stableBlock: "S", prefix: "S\n\nturn one\n\nturn two" },
			{ stableBlock: "S", prefix: "S\n\nturn one\n\nturn TWO\n\nturn three" },
		);
		expect(comparison.stableBlockUnchanged).toBe(true);
		expect(comparison.appendOnly).toBe(false);
		expect(comparison.cacheHeld).toBe(false);
		expect(prefixSignal(comparison)?.text).toContain("rewritten");
	});

	it("says nothing on the first turn, which has no cache to lose", () => {
		const comparison = comparePrefixes(null, { stableBlock: "S", prefix: "S" });
		expect(comparison.first).toBe(true);
		expect(prefixSignal(comparison)).toBeNull();
	});

	it("treats a cleared conversation as a fresh lineage", async () => {
		const tracker = new PrefixTracker();
		tracker.observe(await buildFixturePack());
		tracker.reset();
		expect(tracker.observe(await buildFixturePack()).first).toBe(true);
	});
});

describe("snapshotPrefix", () => {
	it("reads the system message that is actually sent", async () => {
		const pack = await buildFixturePack();
		const system = pack.messages.find((m) => m.role === "system");
		expect(snapshotPrefix(pack).stableBlock).toBe(system?.content);
	});

	it("excludes the final user message, which carries the date and question", async () => {
		const pack = await buildFixturePack({ question: "what am I doing today?" });
		expect(snapshotPrefix(pack).prefix).not.toContain("what am I doing today?");
	});
});
