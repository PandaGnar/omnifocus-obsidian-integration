import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VAULT_TREE } from "../vault/fixtures/vaultTree";
import type { CalendarDate } from "../vault/dates";
import { createVaultIndex } from "../vault/resolver";
import { GOAL_HORIZONS } from "../vault/resolver";
import { DEFAULT_BUDGET, documentCapTokens, packBudgetTokens } from "./budget";
import { STANDING_CONTEXT_DOCS } from "./pack";
import { fixtureReader } from "./fixtures/notes";
import {
	PREVIEW_QUESTION,
	SYSTEM_PROMPT,
	buildContextPack,
	formatIsoDate,
	renderPromptText,
	stablePrefix,
} from "./pack";
import { estimateTokens } from "./tokens";
import type { ContextBudget, ContextPack, ConversationTurn } from "./types";

const d = (year: number, month: number, day: number): CalendarDate => ({ year, month, day });

const TODAY = d(2026, 8, 16);
const QUESTION = "What should I focus on today?";

const vault = createVaultIndex(VAULT_TREE);

/** The cap the pack actually applies to a stable document — see budget.ts. */
const STABLE_DOC_CAP = documentCapTokens(
	DEFAULT_BUDGET,
	"stable",
	STANDING_CONTEXT_DOCS.length + GOAL_HORIZONS.length,
	DEFAULT_BUDGET.perDocument.standing,
);

interface BuildOptions {
	readonly date?: CalendarDate;
	readonly question?: string;
	readonly conversation?: readonly ConversationTurn[];
	readonly budget?: ContextBudget;
	readonly paths?: readonly string[];
	readonly read?: (path: string) => Promise<string>;
}

function build(options: BuildOptions = {}): Promise<ContextPack> {
	return buildContextPack(
		{
			index: options.paths === undefined ? vault : createVaultIndex(options.paths),
			date: options.date ?? TODAY,
			question: options.question ?? QUESTION,
			conversation: options.conversation,
			budget: options.budget,
		},
		options.read ?? fixtureReader(),
	);
}

const ids = (pack: ContextPack): string[] => pack.sections.map((s) => s.id);

describe("pack order", () => {
	it("runs most stable to least stable", async () => {
		const pack = await build();
		expect(ids(pack)).toEqual([
			"system",
			// Standing background, Life Goals first.
			"standing:Long Term/Life Goals.md",
			"standing:Long Term/Getting Unstuck Checklist.md",
			"standing:Long Term/Childcare.md",
			"standing:Financial Planning.md",
			"standing:Long Term.md",
			"standing:The Work.md",
			// Longest horizon first.
			"goal:yearPlus",
			"goal:quarter",
			"goal:month",
			"goal:week",
			// The last five daily notes, oldest first, skipping the days that
			// were never written and never including today's own note.
			"daily:26.08.10",
			"daily:26.08.11",
			"daily:26.08.12",
			"daily:26.08.13",
			"daily:26.08.14",
			// The retrieval seam, then the volatile tail: everything computed
			// from today's date rather than from the vault lives here.
			"retrieved",
			"gaps",
			"date",
			"question",
		]);
	});

	it("puts the retrieval slot after the stable block and before the conversation", async () => {
		const pack = await build({
			conversation: [{ role: "user", text: "and before that?" }],
		});
		const order = ids(pack);
		expect(order.indexOf("retrieved")).toBeGreaterThan(order.indexOf("daily:26.08.14"));
		expect(order.indexOf("retrieved")).toBeLessThan(order.indexOf("conversation:0"));
	});

	it("reserves the retrieval slot without spending any bytes on it", async () => {
		const pack = await build();
		const retrieved = pack.sections.find((s) => s.id === "retrieved");
		expect(retrieved?.text).toBe("");
		expect(retrieved?.tokens).toBe(0);
		expect(pack.tokens.reservedRetrieved).toBe(DEFAULT_BUDGET.groups.retrieved);
		// Nothing of the slot leaks into the prompt: the system message still
		// ends with the newest daily note.
		expect(pack.messages[0]?.content.trimEnd().endsWith("- Migration dry run")).toBe(true);
	});

	it("opens with the system prompt and nothing before it", async () => {
		const pack = await build();
		expect(pack.messages[0]?.role).toBe("system");
		expect(pack.messages[0]?.content.startsWith(SYSTEM_PROMPT)).toBe(true);
	});

	it("keeps conversation turns as their own messages, in order", async () => {
		const pack = await build({
			conversation: [
				{ role: "user", text: "what did I say about the migration?" },
				{ role: "assistant", text: "the Q3 doc calls for a cutover." },
			],
		});
		expect(pack.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(pack.messages[1]?.content).toContain("what did I say about the migration?");
	});
});

describe("nothing date-derived lives in the prefix", () => {
	// This is the cache rule, not a stylistic preference: one changed byte in
	// the prefix invalidates every token after it, and the date changes daily.
	//
	// The requirement is stronger than "the prefix contains no date string", and
	// grepping for one is how a leak got in: the goal-doc fallback note named
	// `26 M08 Goals`, a document that does not exist, recomputed from the
	// calendar on every run. What follows asserts the property itself — same
	// resolved documents, same bytes — rather than the absence of four
	// particular substrings.

	/** The documents a pack settled on, ignoring how they were rendered. */
	const documents = (pack: ContextPack): string =>
		JSON.stringify(
			pack.sections
				.filter((s) => s.group === "stable" || s.group === "dailies")
				.map((s) => [s.id, s.path]),
		);

	const everyDay = (start: CalendarDate, days: number): CalendarDate[] => {
		const out: CalendarDate[] = [];
		for (let i = 0; i < days; i += 1) {
			const at = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
			out.push({
				year: at.getUTCFullYear(),
				month: at.getUTCMonth() + 1,
				day: at.getUTCDate(),
			});
		}
		return out;
	};

	it("gives two dates that resolve to the same documents the same prefix", async () => {
		// 220 days across the fixture's gaps, its W53 ISO week-year boundary and
		// the stretch beyond its last note, grouped by which documents resolved.
		// Every date in a group must produce byte-identical prefix bytes.
		const seen = new Map<string, { date: CalendarDate; prefix: string }>();
		let comparisons = 0;
		for (const date of everyDay(d(2026, 6, 1), 220)) {
			const pack = await build({ date });
			const key = documents(pack);
			const first = seen.get(key);
			if (first === undefined) {
				seen.set(key, { date, prefix: stablePrefix(pack) });
				continue;
			}
			comparisons += 1;
			expect(
				stablePrefix(pack),
				`${formatIsoDate(date)} and ${formatIsoDate(first.date)} resolve to the same ` +
					"documents but produced different prefixes",
			).toBe(first.prefix);
		}
		// The sweep has to have actually exercised the property, and to have
		// found more than one document set along the way.
		expect(comparisons).toBeGreaterThan(150);
		expect(seen.size).toBeGreaterThan(5);
	});

	it("gives the same prefix on two months that fall back to the same doc", async () => {
		// The reported case, minimised. August asks for `26 M08` and `26 W34`,
		// September for `26 M09` and `26 W38`; none of the four exists, and both
		// dates settle on `26 M07 Goals.md` and `26 W33 Goals.md`. Same
		// documents, so the first request of September must not pay for a cold
		// prefill of the whole stable block. (Both dates are past the fixture's
		// last readable daily note, so the dailies match too.)
		const august = await build({ date: d(2026, 8, 17) });
		const september = await build({ date: d(2026, 9, 16) });
		expect(documents(september)).toBe(documents(august));
		expect(stablePrefix(september)).toBe(stablePrefix(august));
		// The labels that differ are still in the prompt, below the cut.
		expect(renderPromptText(september)).toContain("26 M09 Goals");
		expect(renderPromptText(august)).toContain("26 M08 Goals");
	});

	it("keeps the label of a document that does not exist out of the prefix", async () => {
		for (const date of [TODAY, d(2026, 8, 5), d(2026, 9, 16), d(2027, 1, 4)]) {
			const pack = await build({ date });
			const prefix = stablePrefix(pack);
			for (const notice of pack.notices) {
				if (notice.kind !== "gap") continue;
				const requested = /^no `([^`]+)`/.exec(notice.text)?.[1];
				expect(requested).toBeDefined();
				expect(prefix).not.toContain(requested as string);
			}
		}
	});

	it("never appears in the stable prefix", async () => {
		const pack = await build();
		const prefix = stablePrefix(pack);
		expect(prefix).not.toContain("2026-08-16");
		expect(prefix).not.toContain("16 August 2026");
		expect(prefix).not.toContain("Sunday");
		expect(prefix).not.toContain("Today is");
	});

	it("appears immediately before the question, in the last message", async () => {
		const pack = await build();
		const last = pack.messages[pack.messages.length - 1]?.content ?? "";
		expect(last).toContain("Today is Sunday 16 August 2026 (ISO week 26 W33).");
		expect(last.indexOf("Today is")).toBeLessThan(last.indexOf("Question:"));
		expect(last).toContain(QUESTION);
	});

	it("does not move the prefix when only the date changes", async () => {
		// 26.08.15 was never written, so the 15th and the 16th resolve to the
		// same five daily notes and the same W/M/Q/Y+ docs. Same documents must
		// mean the same bytes — otherwise a follow-up the next morning pays for
		// a cold prefill of the whole stable block.
		const saturday = await build({ date: d(2026, 8, 15) });
		const sunday = await build({ date: TODAY });
		expect(stablePrefix(saturday)).toBe(stablePrefix(sunday));
		expect(renderPromptText(saturday)).not.toBe(renderPromptText(sunday));
	});
});

describe("byte identity", () => {
	it("is identical across two builds with identical inputs", async () => {
		const first = await build();
		const second = await build();
		expect(renderPromptText(second)).toBe(renderPromptText(first));
		expect(JSON.stringify(second.sections)).toBe(JSON.stringify(first.sections));
	});

	it("is identical when the input path array is permuted", async () => {
		// Obsidian hands over `getMarkdownFiles()` in its own order, which is not
		// promised to be stable between launches.
		const permutations = [
			[...VAULT_TREE].reverse(),
			[...VAULT_TREE].sort(),
			// A rotation, so the daily notes and the goal docs swap ends.
			[...VAULT_TREE.slice(7), ...VAULT_TREE.slice(0, 7)],
		];
		const expected = renderPromptText(await build());
		for (const paths of permutations) {
			expect(renderPromptText(await build({ paths }))).toBe(expected);
		}
	});

	it("is identical under permutation on a date whose notes collide", async () => {
		// 26.07.02 exists twice — `26.07.02.md` and Obsidian's `26.07.02 1.md`.
		// Which of them wins must not depend on which one was listed first, or
		// the prompt changes between launches for no reason the user can see.
		const date = d(2026, 7, 3);
		const expected = renderPromptText(await build({ date }));
		expect(expected).toContain("- The note I actually wrote in");
		expect(expected).not.toContain("- The accidental second copy");
		for (const paths of [[...VAULT_TREE].reverse(), [...VAULT_TREE].sort()]) {
			expect(renderPromptText(await build({ date, paths }))).toBe(expected);
		}
	});

	it("survives a lot of permutations, across dates, with and without archives", async () => {
		// The permutation test above uses three hand-picked orders. This one is
		// the property: Obsidian's `getMarkdownFiles()` order is arbitrary, so
		// *no* order may change the bytes. Seeded, so a failure is reproducible.
		let seed = 0x9e3779b9;
		const random = (): number => {
			seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
			return seed / 0x1_0000_0000;
		};
		const shuffled = (source: readonly string[]): string[] => {
			const out = [...source];
			for (let i = out.length - 1; i > 0; i -= 1) {
				const j = Math.floor(random() * (i + 1));
				[out[i], out[j]] = [out[j] as string, out[i] as string];
			}
			return out;
		};

		const dates = [
			TODAY,
			d(2026, 7, 3), // the 26.07.02 collision
			d(2026, 8, 5), // the missing W32
			d(2027, 1, 4), // ISO week-year 2026 running into January 2027
			d(2026, 6, 2), // the note misfiled into Mise/26.06/
			d(2025, 5, 11), // the 25.05.10 collision, deep in a bucket
		];
		for (const includeArchives of [false, true]) {
			for (const date of dates) {
				const expected = renderPromptText(
					await buildContextPack(
						{ index: createVaultIndex(VAULT_TREE, { includeArchives }), date, question: QUESTION },
						fixtureReader(),
					),
				);
				for (let i = 0; i < 40; i += 1) {
					const pack = await buildContextPack(
						{
							index: createVaultIndex(shuffled(VAULT_TREE), { includeArchives }),
							date,
							question: QUESTION,
						},
						fixtureReader(),
					);
					expect(
						renderPromptText(pack),
						`permutation ${i} on ${formatIsoDate(date)} (archives ${includeArchives})`,
					).toBe(expected);
				}
			}
		}
	});

	it("does not depend on how many times a pack has been built", async () => {
		const first = renderPromptText(await build({ conversation: [{ role: "user", text: "hi" }] }));
		await build({ date: d(2025, 1, 1) });
		await build({ question: "something else entirely" });
		const again = renderPromptText(await build({ conversation: [{ role: "user", text: "hi" }] }));
		expect(again).toBe(first);
	});
});

describe("gap reporting", () => {
	it("names the doc it fell back to instead of substituting silently", async () => {
		const pack = await build();
		// August 2026 has no `26 M08 Goals`; the resolver settles on M07.
		expect(pack.notices).toContainEqual({
			kind: "gap",
			text: "no `26 M08 Goals` - using `26 M07 Goals`",
		});
		const month = pack.sections.find((s) => s.id === "goal:month");
		expect(month?.path).toBe("Long Term/26 M07 Goals.md");
		// The document itself carries a header derived from the document and
		// nothing else — the admission is at the bottom of the prompt.
		expect(month?.text.startsWith("## Month goals - 26 M07 Goals\nSource:")).toBe(true);
		expect(month?.text).not.toContain("26 M08");
	});

	it("tells the model about the gap, at the bottom with the date", async () => {
		// Losing the in-prompt admission would be a real regression: a model
		// handed `26 M07 Goals` alone answers as though it were this month's.
		const pack = await build();
		const last = pack.messages[pack.messages.length - 1]?.content ?? "";
		expect(last).toContain(
			"no `26 M08 Goals` note exists; `26 M07 Goals` is the most recent doc at this horizon",
		);
		expect(last.indexOf("Gaps in the documents above:")).toBeLessThan(
			last.indexOf("Today is"),
		);
		expect(stablePrefix(pack)).not.toContain("Gaps in the documents above:");
	});

	it("says nothing about gaps when there are none", async () => {
		const pack = await build({ date: d(2026, 7, 3) });
		expect(pack.notices.filter((n) => n.kind === "gap")).toEqual([]);
		expect(ids(pack)).not.toContain("gaps");
		expect(renderPromptText(pack)).not.toContain("Gaps in the documents above:");
	});

	it("reports the week gap too, and only when there is one", async () => {
		// 2026 has W29, W30, W31 and W33 — no W32.
		const gappy = await build({ date: d(2026, 8, 5) });
		expect(gappy.notices.map((n) => n.text)).toContain("no `26 W32 Goals` - using `26 W31 Goals`");
		const lastMessage = gappy.messages[gappy.messages.length - 1]?.content ?? "";
		expect(lastMessage).toContain(
			"no `26 W32 Goals` note exists; `26 W31 Goals` is the most recent doc at this horizon",
		);

		const exact = await build();
		expect(exact.notices.filter((n) => n.kind === "gap").map((n) => n.text)).toEqual([
			"no `26 M08 Goals` - using `26 M07 Goals`",
		]);
		// The week doc resolved exactly, so it contributes no gap line.
		expect(exact.sections.find((s) => s.id === "gaps")?.text).not.toContain("W3");
	});

	it("says when a horizon has no doc at all rather than reaching forwards", async () => {
		const pack = await build({ date: d(2024, 5, 1) });
		const missing = pack.notices.filter((n) => n.kind === "missing").map((n) => n.text);
		expect(missing).toContain("no week goals doc at or before `24 W18 Goals`");
		expect(ids(pack)).not.toContain("goal:week");
	});

	it("names duplicate collision-suffixed files instead of merging them", async () => {
		const pack = await build({ date: d(2026, 7, 3) });
		expect(pack.notices.map((n) => n.text)).toContain(
			"ignoring duplicate of `26.07.02`: Mise/26.07/26.07.02 1.md",
		);
	});

	it("says when a standing doc is not in the vault", async () => {
		const pack = await build({ paths: VAULT_TREE.filter((p) => p !== "The Work.md") });
		expect(pack.notices.map((n) => n.text)).toContain(
			"standing doc not in the vault: The Work.md",
		);
		expect(ids(pack)).not.toContain("standing:The Work.md");
	});
});

describe("exclusions inherited from the resolver", () => {
	it("never pulls in a template or an archived note", async () => {
		const prompt = renderPromptText(await build());
		expect(prompt).not.toContain("xx.xx.xx");
		expect(prompt).not.toContain("xx Wxx");
		expect(prompt).not.toContain("Archive/");
		expect(prompt).not.toContain("zAssets");
	});
});

describe("reading failures", () => {
	it("reports an unreadable note and carries on", async () => {
		const base = fixtureReader();
		const pack = await build({
			read: (path) =>
				path === "Long Term/Childcare.md"
					? Promise.reject(new Error("EACCES"))
					: base(path),
		});
		expect(pack.notices.map((n) => n.text)).toContain(
			"could not read Long Term/Childcare.md: EACCES",
		);
		expect(ids(pack)).not.toContain("standing:Long Term/Childcare.md");
		expect(ids(pack)).toContain("standing:Long Term/Life Goals.md");
	});

	it("delivers at most dailyNoteCandidates dailies, and says when it is fewer", async () => {
		// The field is a candidate count, not a delivered count — the name says
		// so now. A candidate that cannot be read is reported and skipped, and
		// the pack does *not* reach further back to backfill: which notes reach
		// the prompt would then depend on which reads happened to fail, and the
		// pack would stop being a function of the vault.
		const base = fixtureReader();
		const pack = await build({
			read: (path) =>
				path === "Mise/26.08.12.md" ? Promise.reject(new Error("EACCES")) : base(path),
		});
		const delivered = ids(pack).filter((id) => id.startsWith("daily:"));
		expect(delivered).toEqual([
			"daily:26.08.10",
			"daily:26.08.11",
			"daily:26.08.13",
			"daily:26.08.14",
		]);
		expect(delivered.length).toBeLessThan(DEFAULT_BUDGET.dailyNoteCandidates);
		expect(pack.notices.map((n) => n.text)).toContain("could not read Mise/26.08.12.md: EACCES");
		// Not backfilled from further back, even though 26.08.09 was available.
		expect(delivered).not.toContain("daily:26.08.09");
	});

	it("skips an empty note rather than sending a bare header", async () => {
		const pack = await build({ read: fixtureReader([["Long Term.md", "   \n\n"]]) });
		expect(pack.notices.map((n) => n.text)).toContain("skipping empty note: Long Term.md");
		expect(ids(pack)).not.toContain("standing:Long Term.md");
	});
});

describe("budget", () => {
	it("fits, with every group inside its cap", async () => {
		const pack = await build();
		expect(pack.tokens.total).toBeLessThanOrEqual(pack.tokens.budget);
		expect(pack.tokens.budget).toBe(packBudgetTokens(DEFAULT_BUDGET));
		for (const group of pack.tokens.byGroup) {
			expect(group.tokens).toBeLessThanOrEqual(group.cap);
		}
		expect(pack.dropped).toEqual([]);
		expect(pack.tokens.total + pack.budget.numPredict).toBeLessThan(pack.budget.numCtx);
	});

	it("truncates a document that busts its own cap, and says so", async () => {
		const huge = Array.from(
			{ length: 1000 },
			(_, i) => `- item ${i} of a life goals list that got out of hand`,
		).join("\n");
		const pack = await build({ read: fixtureReader([["Long Term/Life Goals.md", huge]]) });
		const life = pack.sections.find((s) => s.id === "standing:Long Term/Life Goals.md");
		expect(life?.truncated).toBe(true);
		// The cap covers the whole section, header included — that is what makes
		// "ten documents at their cap" add up to the stable cap rather than to
		// the stable cap plus ten headers.
		expect(life?.tokens).toBeLessThanOrEqual(STABLE_DOC_CAP);
		expect(life?.text).toContain("[... truncated to fit the context budget ...]");
		expect(life?.text).toContain("- item 0 of");
		expect(life?.text).not.toContain("- item 999 of");
		expect(pack.notices.map((n) => n.text)).toContain(
			`Long Term/Life Goals.md truncated to the ${STABLE_DOC_CAP}-token ` +
				`per-document cap (estimated ${estimateTokens(huge)} tokens)`,
		);
	});

	it("truncates rather than dropping when every document is oversized", async () => {
		// The failure this replaces: profiled against realistically sized notes
		// the pack used to discard the multi-year and quarterly goal docs whole,
		// untruncated, while ~19,890 tokens of num_ctx sat unused — because the
		// group cap bound before the per-document cap ever did, and the group
		// cap's only remedy is dropping.
		const fat = (label: string, tokens: number): string =>
			Array.from({ length: tokens }, (_, i) => `- ${label} line ${i} with a few more words`).join(
				"\n",
			);
		const overrides: [string, string][] = [
			...STANDING_CONTEXT_DOCS.map((doc): [string, string] => [doc.path, fat(doc.title, 400)]),
			["Long Term/26 Y+ Goals.md", fat("Y+", 400)],
			["Long Term/26 Q3 Goals.md", fat("Q3", 400)],
			["Long Term/26 M07 Goals.md", fat("M07", 400)],
			["Long Term/26 W33 Goals.md", fat("W33", 400)],
			...["14", "13", "12", "11", "10"].map((day): [string, string] => [
				`Mise/26.08.${day}.md`,
				fat(`26.08.${day}`, 300),
			]),
		];
		const pack = await build({ read: fixtureReader(overrides) });

		expect(pack.dropped).toEqual([]);
		expect(pack.sections.filter((s) => s.truncated).length).toBeGreaterThan(10);
		// Every document the pack asked for is still there, cut to fit.
		expect(ids(pack)).toContain("goal:yearPlus");
		expect(ids(pack)).toContain("goal:quarter");
		expect(ids(pack)).toContain("standing:The Work.md");
		for (const group of pack.tokens.byGroup) {
			expect(group.tokens).toBeLessThanOrEqual(group.cap);
		}
		// And the group caps are now genuinely spent rather than 76% spent.
		const stable = pack.tokens.byGroup.find((g) => g.group === "stable");
		expect(stable?.tokens).toBeGreaterThan(DEFAULT_BUDGET.groups.stable * 0.95);
	});

	it("keeps tokens.total inside the figure the budget enforced", async () => {
		// Including the chat template overhead, which used to be added to the
		// reported total after the budget had finished checking things.
		const conversation = Array.from({ length: 12 }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			text: Array.from({ length: 200 }, (_, j) => `turn ${i} sentence ${j}.`).join(" "),
		}));
		const pack = await build({ conversation });
		expect(pack.tokens.messageOverhead).toBeGreaterThan(0);
		expect(pack.tokens.total).toBeLessThanOrEqual(pack.tokens.budget);
		expect(pack.tokens.sections + pack.tokens.messageOverhead + pack.tokens.reservedRetrieved).toBe(
			pack.tokens.total,
		);
	});

	it("does not drop a daily note merely because the group is tight", async () => {
		// It used to: `daily` was 800 tokens with five candidates against a 3000
		// group cap, so the group cap always bound first and its remedy is to
		// drop. Now the per-document cap is the group's fair share, and a tight
		// group cuts every note a little instead of losing the oldest whole.
		const full = await build();
		const dailyTokens = full.sections
			.filter((s) => s.group === "dailies")
			.reduce((sum, s) => sum + s.tokens, 0);
		const pack = await build({
			budget: {
				...DEFAULT_BUDGET,
				groups: { ...DEFAULT_BUDGET.groups, dailies: dailyTokens - 1 },
			},
		});
		expect(pack.dropped).toEqual([]);
		expect(ids(pack)).toContain("daily:26.08.10");
		expect(ids(pack)).toContain("daily:26.08.14");
		expect(pack.sections.some((s) => s.group === "dailies" && s.truncated)).toBe(true);
	});

	it("drops the oldest daily note first once dropping is unavoidable", async () => {
		// Unavoidable means the second pass: a question too big to truncate and
		// too important to drop, whose excess has to come out of the pack.
		const question = Array.from({ length: 3000 }, (_, i) => `part ${i} of it`).join(" ");
		const pack = await build({ question });
		const droppedDailies = pack.dropped
			.map((s) => s.id)
			.filter((id) => id.startsWith("daily:"));
		expect(droppedDailies[0]).toBe("daily:26.08.10");
		expect(ids(pack)).not.toContain("daily:26.08.10");
	});

	it("drops standing docs from the bottom of the declared list upwards", async () => {
		const pack = await build({
			budget: { ...DEFAULT_BUDGET, groups: { ...DEFAULT_BUDGET.groups, stable: 1 } },
		});
		// A stable cap of 1 leaves no document any room at all, so every one of
		// them goes — in the documented order, background docs from the bottom of
		// the declared list upwards and Life Goals last.
		expect(pack.dropped.map((s) => s.id).slice(0, 3)).toEqual([
			"standing:The Work.md",
			"standing:Long Term.md",
			"standing:Financial Planning.md",
		]);
		expect(pack.dropped[pack.dropped.length - 1]?.id).toBe("standing:Long Term/Life Goals.md");
	});

	it("follows the documented drop order all the way down", async () => {
		const pack = await build({
			budget: { ...DEFAULT_BUDGET, groups: { ...DEFAULT_BUDGET.groups, stable: 0 } },
		});
		expect(pack.dropped.map((s) => s.id)).toEqual([
			// Background standing docs, reverse of their declared order.
			"standing:The Work.md",
			"standing:Long Term.md",
			"standing:Financial Planning.md",
			"standing:Long Term/Childcare.md",
			"standing:Long Term/Getting Unstuck Checklist.md",
			// Then goal docs, longest horizon first.
			"goal:yearPlus",
			"goal:quarter",
			"goal:month",
			"goal:week",
			// Life Goals is the last thing to go.
			"standing:Long Term/Life Goals.md",
		]);
		// The daily notes have their own cap and are untouched by this one.
		expect(ids(pack)).toEqual([
			"system",
			"daily:26.08.10",
			"daily:26.08.11",
			"daily:26.08.12",
			"daily:26.08.13",
			"daily:26.08.14",
			"retrieved",
			"gaps",
			"date",
			"question",
		]);
	});

	it("never drops or truncates the question, and says when it is too big", async () => {
		const question = Array.from({ length: 400 }, (_, i) => `part ${i} of the question`).join(" ");
		const pack = await build({ question });
		expect(pack.sections.find((s) => s.id === "question")?.text).toContain(question);
		expect(pack.notices.some((n) => n.kind === "overflow")).toBe(true);
		// It is over its own 500-token allowance but the pack as a whole still
		// fits; had it not, the budget would have dropped context to make room
		// rather than let the prompt run past num_ctx (see budget.test.ts).
		expect(pack.tokens.total).toBeLessThanOrEqual(pack.tokens.budget);
	});

	it("sheds conversation before it sheds a standing constraint", async () => {
		// The judgement call, written down as an assertion. `Childcare.md` and
		// `Financial Planning.md` are not background reading, they are standing
		// constraints: a plan that ignores them is wrong, invisibly. An evicted
		// conversation turn degrades the same answer visibly, oldest first, in a
		// transcript the user can see and restate from. Grounding outranks
		// continuity here as it does everywhere else in the order.
		const turn = (i: number): ConversationTurn => ({
			role: i % 2 === 0 ? "user" : "assistant",
			text: Array.from({ length: 60 }, (_, j) => `turn ${i} sentence ${j}.`).join(" "),
		});
		// Standing docs at a realistic size, and a question too big to truncate
		// and too important to drop, so the second pass has to find the room.
		const bulky = Array.from(
			{ length: 120 },
			(_, i) => `- a standing constraint, line ${i}, with a few more words`,
		).join("\n");
		const question = Array.from({ length: 2400 }, (_, i) => `part ${i} of it`).join(" ");
		const pack = await build({
			conversation: [turn(0), turn(1), turn(2)],
			question,
			read: fixtureReader(STANDING_CONTEXT_DOCS.map((doc) => [doc.path, bulky] as const)),
		});

		expect(pack.dropped.map((s) => s.id)).toEqual([
			// Colour first, oldest first.
			"daily:26.08.10",
			"daily:26.08.11",
			"daily:26.08.12",
			"daily:26.08.13",
			"daily:26.08.14",
			// Then continuity, oldest first.
			"conversation:0",
			"conversation:1",
			"conversation:2",
			// Only then grounding, weakest first, from the bottom of the
			// declared list upwards.
			"standing:The Work.md",
			"standing:Long Term.md",
			"standing:Financial Planning.md",
		]);
		// The goal docs and Life Goals are untouched, as the spine says.
		expect(ids(pack)).toContain("standing:Long Term/Life Goals.md");
		expect(ids(pack)).toContain("goal:week");
	});

	it("keeps the conversation inside its band however long the chat gets", async () => {
		// Ranks are banded a hundred apart, so an unclamped `rank + index` would
		// put turn 100 among the standing docs and turn 200 among the goal docs
		// — silently inverting the policy above for exactly the long sessions
		// where it matters. With 130 turns and second-pass pressure, unclamped
		// ranks interleave: turns 0-99 go, then background docs, then the rest of
		// the conversation. Past the band the turns share a rank and wire order
		// keeps them going oldest-first.
		const bulky = Array.from(
			{ length: 120 },
			(_, i) => `- a standing constraint, line ${i}, with a few more words`,
		).join("\n");
		const conversation = Array.from({ length: 130 }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			text: `turn ${i}: something worth a sentence about the migration plan.`,
		}));
		const pack = await build({
			conversation,
			question: Array.from({ length: 2400 }, (_, i) => `part ${i} of it`).join(" "),
			read: fixtureReader(STANDING_CONTEXT_DOCS.map((doc) => [doc.path, bulky] as const)),
		});

		const dropped = pack.dropped.map((s) => s.id);
		const lastConversation = dropped.map((id) => id.startsWith("conversation:")).lastIndexOf(true);
		const firstBackground = dropped.findIndex((id) => id.startsWith("standing:"));
		expect(firstBackground).toBeGreaterThanOrEqual(0);
		expect(lastConversation).toBeLessThan(firstBackground);
		// Every turn went, oldest first and contiguously, before any doc did.
		expect(dropped.filter((id) => id.startsWith("conversation:"))).toEqual(
			Array.from({ length: conversation.length }, (_, i) => `conversation:${i}`),
		);
	});

	it("drops the oldest conversation turns when the history grows", async () => {
		const turn = (i: number): ConversationTurn => ({
			role: i % 2 === 0 ? "user" : "assistant",
			text: Array.from({ length: 120 }, (_, j) => `turn ${i} sentence ${j}.`).join(" "),
		});
		const conversation = Array.from({ length: 8 }, (_, i) => turn(i));
		const pack = await build({ conversation });
		const kept = ids(pack).filter((id) => id.startsWith("conversation:"));
		expect(kept.length).toBeLessThan(conversation.length);
		// Whatever survives is the newest run of turns, contiguous to the end.
		expect(kept[kept.length - 1]).toBe("conversation:7");
		expect(pack.dropped.map((s) => s.id)).toEqual(
			Array.from({ length: conversation.length - kept.length }, (_, i) => `conversation:${i}`),
		);
	});
});

describe("preview question", () => {
	it("builds without a real question", async () => {
		const pack = await build({ question: PREVIEW_QUESTION });
		expect(pack.messages[pack.messages.length - 1]?.content).toContain("preview");
		expect(pack.dropped).toEqual([]);
	});
});

describe("no obsidian dependency", () => {
	it("imports nothing from obsidian anywhere under src/context", () => {
		// Same guard as `src/vault/resolver.test.ts`, extended to walk
		// subdirectories so the fixtures are covered too. The pack is only a
		// pure function while nobody reaches for the Obsidian API "just once".
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((entry) => {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) return walk(full);
				return full.endsWith(".ts") ? [full] : [];
			});

		const files = walk(dirname(fileURLToPath(import.meta.url)));
		expect(files.length).toBeGreaterThan(4);
		for (const file of files) {
			expect(readFileSync(file, "utf8")).not.toMatch(/^\s*import[^\n]*["']obsidian["']/m);
		}
	});

	it("needs nothing but a string[] and a reader", async () => {
		const pack = await buildContextPack(
			{
				index: createVaultIndex(["Long Term/Life Goals.md"]),
				date: TODAY,
				question: "and now?",
			},
			() => Promise.resolve("# Life goals\n\n- One."),
		);
		expect(ids(pack)).toEqual([
			"system",
			"standing:Long Term/Life Goals.md",
			"retrieved",
			"date",
			"question",
		]);
	});
});
