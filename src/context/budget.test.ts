import { describe, expect, it } from "vitest";

import {
	DEFAULT_BUDGET,
	applyBudget,
	documentCapTokens,
	headroomTokens,
	packBudgetTokens,
} from "./budget";
import { STANDING_CONTEXT_DOCS } from "./pack";
import { GOAL_HORIZONS } from "../vault/resolver";
import type { ContextBudget, PackSection, SectionGroup } from "./types";

function section(
	id: string,
	group: SectionGroup,
	tokens: number,
	dropRank: number | null,
): PackSection {
	return {
		id,
		kind: "daily",
		group,
		title: id,
		path: null,
		text: "",
		tokens,
		truncated: false,
		messageRole: null,
		note: null,
		dropRank,
	};
}

const ids = (sections: readonly { id: string }[]): string[] => sections.map((s) => s.id);

describe("DEFAULT_BUDGET", () => {
	it("adds up to the figure in the header table", () => {
		expect(packBudgetTokens(DEFAULT_BUDGET)).toBe(19_500);
	});

	it("leaves room for num_predict and then some", () => {
		// The estimator in tokens.ts is roughly calibrated, not a ceiling, so
		// this slack — not the divisor — is what keeps the pack inside num_ctx.
		// Any change here has to be argued from the headroom that survives it.
		expect(headroomTokens(DEFAULT_BUDGET)).toBeGreaterThan(10_000);
		expect(
			packBudgetTokens(DEFAULT_BUDGET) +
				DEFAULT_BUDGET.numPredict +
				headroomTokens(DEFAULT_BUDGET),
		).toBe(DEFAULT_BUDGET.numCtx);
	});

	it("caps a single document below its group, so one file cannot take it all", () => {
		expect(DEFAULT_BUDGET.perDocument.goal).toBeLessThan(DEFAULT_BUDGET.groups.stable);
		expect(DEFAULT_BUDGET.perDocument.daily).toBeLessThan(DEFAULT_BUDGET.groups.dailies);
	});

	it("sizes the per-document caps so a full group fits its group cap", () => {
		// The calibration that makes truncation the binding constraint. The weak
		// form of this — one document is smaller than its group — passed happily
		// while five dailies at 800 came to 4000 against a 3000 cap, so the group
		// cap bound first and its only remedy is dropping documents whole.
		const stableSlots = STANDING_CONTEXT_DOCS.length + GOAL_HORIZONS.length;
		const standing = documentCapTokens(
			DEFAULT_BUDGET,
			"stable",
			stableSlots,
			DEFAULT_BUDGET.perDocument.standing,
		);
		const goal = documentCapTokens(
			DEFAULT_BUDGET,
			"stable",
			stableSlots,
			DEFAULT_BUDGET.perDocument.goal,
		);
		const daily = documentCapTokens(
			DEFAULT_BUDGET,
			"dailies",
			DEFAULT_BUDGET.dailyNoteCandidates,
			DEFAULT_BUDGET.perDocument.daily,
		);
		expect(Math.max(standing, goal) * stableSlots).toBeLessThanOrEqual(
			DEFAULT_BUDGET.groups.stable,
		);
		expect(daily * DEFAULT_BUDGET.dailyNoteCandidates).toBeLessThanOrEqual(
			DEFAULT_BUDGET.groups.dailies,
		);
		// And the caps are still worth having: a document is not cut to nothing.
		expect(Math.min(standing, goal, daily)).toBeGreaterThan(500);
	});
});

describe("documentCapTokens", () => {
	it("lowers a declared ceiling to the group's fair share", () => {
		expect(documentCapTokens(DEFAULT_BUDGET, "dailies", 5, 800)).toBe(600);
	});

	it("leaves a ceiling that already fits alone", () => {
		expect(documentCapTokens(DEFAULT_BUDGET, "dailies", 5, 100)).toBe(100);
	});

	it("has nothing to divide by when a group is sized for no documents", () => {
		expect(documentCapTokens(DEFAULT_BUDGET, "dailies", 0, 800)).toBe(800);
	});
});

describe("applyBudget - group caps", () => {
	const budget: ContextBudget = {
		...DEFAULT_BUDGET,
		groups: { ...DEFAULT_BUDGET.groups, dailies: 3000 },
	};

	const dailies = [
		section("daily:oldest", "dailies", 1000, 100),
		section("daily:middle", "dailies", 1000, 101),
		section("daily:newer", "dailies", 1000, 102),
		section("daily:newest", "dailies", 1000, 103),
	];

	it("drops the lowest-ranked section until the group fits", () => {
		const outcome = applyBudget(dailies, budget);
		expect(ids(outcome.kept)).toEqual(["daily:middle", "daily:newer", "daily:newest"]);
		expect(ids(outcome.dropped)).toEqual(["daily:oldest"]);
		expect(outcome.dropped[0]?.reason).toContain("dailies cap of 3000");
	});

	it("is deterministic across runs", () => {
		const a = applyBudget(dailies, budget);
		const b = applyBudget(dailies, budget);
		expect(ids(a.kept)).toEqual(ids(b.kept));
		expect(ids(a.dropped)).toEqual(ids(b.dropped));
	});

	it("keeps wire order rather than drop order in what survives", () => {
		const outcome = applyBudget([...dailies, section("daily:extra", "dailies", 1000, 99)], budget);
		// `daily:extra` has the lowest rank so it goes first even though it was
		// listed last; the survivors stay in the order they were handed over.
		expect(ids(outcome.kept)).toEqual(["daily:middle", "daily:newer", "daily:newest"]);
		expect(ids(outcome.dropped)).toEqual(["daily:extra", "daily:oldest"]);
	});

	it("reports an overflow rather than dropping something undroppable", () => {
		const outcome = applyBudget(
			[section("system", "system", 9000, null)],
			DEFAULT_BUDGET,
		);
		expect(outcome.dropped).toEqual([]);
		expect(outcome.overflowed).toContain("system");
		expect(ids(outcome.kept)).toEqual(["system"]);
	});
});

describe("applyBudget - what it reports when nothing can be dropped", () => {
	// Pass 2 used to blame the `system` group for a whole-pack overflow, which
	// put "the system group is over its cap" in front of the user when the
	// system prompt was 400 tokens against a cap of 500. This is the one report
	// anybody reads when things have gone wrong.
	const oversizedQuestion = [
		section("system", "system", 400, null),
		section("question", "question", 40_000, null),
	];

	it("names the pack, not the system group", () => {
		const outcome = applyBudget(oversizedQuestion, DEFAULT_BUDGET);
		expect(outcome.packOverflow).toBe(true);
		expect(outcome.overflowed).not.toContain("system");
		expect(outcome.overflowed).toContain("question");
	});

	it("says nothing about the pack when the pack fits", () => {
		const outcome = applyBudget([section("system", "system", 400, null)], DEFAULT_BUDGET);
		expect(outcome.packOverflow).toBe(false);
	});
});

describe("applyBudget - chat template overhead", () => {
	// The overhead used to be added to the reported total *after* the budget had
	// finished enforcing, so `tokens.total` could exceed the figure anything had
	// actually checked. Small, but it made the headline number unfalsifiable.
	const atTheCeiling = [
		section("system", "system", 400, null),
		section("daily:0", "dailies", 500, 100),
		section("question", "question", 15_100, null),
	];

	it("is held back before the last section that would have fitted without it", () => {
		const total = packBudgetTokens(DEFAULT_BUDGET);
		const withoutOverhead = applyBudget(atTheCeiling, DEFAULT_BUDGET);
		expect(withoutOverhead.dropped).toEqual([]);
		const kept = withoutOverhead.kept.reduce((sum, s) => sum + s.tokens, 0);
		expect(kept + DEFAULT_BUDGET.groups.retrieved).toBe(total);

		const withOverhead = applyBudget(atTheCeiling, DEFAULT_BUDGET, { messageOverhead: 24 });
		expect(ids(withOverhead.dropped)).toEqual(["daily:0"]);
		const keptNow = withOverhead.kept.reduce((sum, s) => sum + s.tokens, 0);
		expect(keptNow + DEFAULT_BUDGET.groups.retrieved + 24).toBeLessThanOrEqual(total);
	});
});

describe("applyBudget - whole-pack ceiling", () => {
	// An over-long question is the case that reaches the second pass: the
	// question is never dropped, so its excess has to come out of the sections
	// below it in the drop order instead of out of num_ctx.
	const sections = [
		section("system", "system", 400, null),
		section("stable:life", "stable", 1000, 500),
		section("stable:background", "stable", 1000, 300),
		section("stable:goal", "stable", 1000, 400),
		section("daily:0", "dailies", 500, 100),
		section("daily:1", "dailies", 500, 101),
		section("conversation:0", "conversation", 900, 200),
		section("question", "question", 14_000, null),
	];

	it("drops in the documented global order until the pack fits", () => {
		const outcome = applyBudget(sections, DEFAULT_BUDGET);
		// Colour, then continuity, then grounding weakest-first: dailies
		// oldest-first, then the conversation, then background standing docs,
		// then goal docs, and Life Goals last of all.
		expect(ids(outcome.dropped)).toEqual([
			"daily:0",
			"daily:1",
			"conversation:0",
			"stable:background",
			"stable:goal",
		]);
		const kept = outcome.kept.reduce((sum, s) => sum + s.tokens, 0);
		const reserved = DEFAULT_BUDGET.groups.retrieved;
		expect(kept + reserved).toBeLessThanOrEqual(packBudgetTokens(DEFAULT_BUDGET));
	});

	it("never drops the system prompt or the question", () => {
		const outcome = applyBudget(sections, DEFAULT_BUDGET);
		expect(ids(outcome.kept)).toContain("system");
		expect(ids(outcome.kept)).toContain("question");
	});

	it("charges the retrieval reserve even though the slot is empty", () => {
		const outcome = applyBudget(sections, DEFAULT_BUDGET);
		const retrieved = outcome.byGroup.find((g) => g.group === "retrieved");
		expect(retrieved?.tokens).toBe(0);
		expect(retrieved?.cap).toBe(3500);
		// Without the reserve the pack above fits with room to spare; with it,
		// five sections have to go. Turning RAG on later must not be what
		// discovers that.
		expect(outcome.dropped.length).toBeGreaterThan(0);
	});
});
