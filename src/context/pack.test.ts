import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VAULT_TREE } from "../vault/fixtures/vaultTree";
import type { CalendarDate } from "../vault/dates";
import { createVaultIndex } from "../vault/resolver";
import { DEFAULT_BUDGET, packBudgetTokens } from "./budget";
import { fixtureReader } from "./fixtures/notes";
import {
	PREVIEW_QUESTION,
	SYSTEM_PROMPT,
	buildContextPack,
	renderPromptText,
	stablePrefix,
} from "./pack";
import { estimateTokens } from "./tokens";
import type { ContextBudget, ContextPack, ConversationTurn } from "./types";

const d = (year: number, month: number, day: number): CalendarDate => ({ year, month, day });

const TODAY = d(2026, 8, 16);
const QUESTION = "What should I focus on today?";

const vault = createVaultIndex(VAULT_TREE);

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
			// The retrieval seam, then the volatile tail.
			"retrieved",
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

describe("the date lives at the bottom", () => {
	// This is the cache rule, not a stylistic preference: one changed byte in
	// the prefix invalidates every token after it, and the date changes daily.
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
		expect(month?.text).toContain("Note: no `26 M08 Goals` note exists");
	});

	it("reports the week gap too, and only when there is one", async () => {
		// 2026 has W29, W30, W31 and W33 — no W32.
		const gappy = await build({ date: d(2026, 8, 5) });
		expect(gappy.notices.map((n) => n.text)).toContain("no `26 W32 Goals` - using `26 W31 Goals`");

		const exact = await build();
		expect(exact.notices.filter((n) => n.kind === "gap").map((n) => n.text)).toEqual([
			"no `26 M08 Goals` - using `26 M07 Goals`",
		]);
		expect(exact.sections.find((s) => s.id === "goal:week")?.text).not.toContain("Note:");
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
		// The section is the document plus its two-line header, so it is allowed
		// to be a little over the document cap but nowhere near the group's.
		expect(life?.tokens).toBeLessThanOrEqual(DEFAULT_BUDGET.perDocument.standing + 50);
		expect(life?.text).toContain("[... truncated to fit the context budget ...]");
		expect(life?.text).toContain("- item 0 of");
		expect(life?.text).not.toContain("- item 999 of");
		expect(pack.notices.map((n) => n.text)).toContain(
			`Long Term/Life Goals.md truncated to the ${DEFAULT_BUDGET.perDocument.standing}-token ` +
				`per-document cap (estimated ${estimateTokens(huge)} tokens)`,
		);
	});

	it("drops the oldest daily note first when the daily group is over", async () => {
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
		expect(pack.dropped.map((s) => s.id)).toEqual(["daily:26.08.10"]);
		expect(ids(pack)).toContain("daily:26.08.14");
	});

	it("drops standing docs from the bottom of the declared list upwards", async () => {
		const full = await build();
		const stableTokens = full.sections
			.filter((s) => s.group === "stable")
			.reduce((sum, s) => sum + s.tokens, 0);
		const pack = await build({
			budget: {
				...DEFAULT_BUDGET,
				groups: { ...DEFAULT_BUDGET.groups, stable: stableTokens - 1 },
			},
		});
		expect(pack.dropped.map((s) => s.id)).toEqual(["standing:The Work.md"]);
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
