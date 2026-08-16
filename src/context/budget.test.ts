import { describe, expect, it } from "vitest";

import { DEFAULT_BUDGET, applyBudget, headroomTokens, packBudgetTokens } from "./budget";
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
		dropRank,
	};
}

const ids = (sections: readonly { id: string }[]): string[] => sections.map((s) => s.id);

describe("DEFAULT_BUDGET", () => {
	it("adds up to the figure in the plan", () => {
		expect(packBudgetTokens(DEFAULT_BUDGET)).toBe(17_500);
	});

	it("leaves room for num_predict and then some", () => {
		// The estimator in tokens.ts is a heuristic; this slack is what it is
		// allowed to be wrong by before anything is silently truncated.
		expect(headroomTokens(DEFAULT_BUDGET)).toBeGreaterThan(2000);
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

describe("applyBudget - whole-pack ceiling", () => {
	// An over-long question is the case that reaches the second pass: the
	// question is never dropped, so its excess has to come out of the sections
	// below it in the drop order instead of out of num_ctx.
	const sections = [
		section("system", "system", 400, null),
		section("stable:life", "stable", 1000, 500),
		section("stable:background", "stable", 1000, 200),
		section("stable:goal", "stable", 1000, 400),
		section("daily:0", "dailies", 500, 100),
		section("daily:1", "dailies", 500, 101),
		section("conversation:0", "conversation", 900, 300),
		section("question", "question", 12_000, null),
	];

	it("drops in the documented global order until the pack fits", () => {
		const outcome = applyBudget(sections, DEFAULT_BUDGET);
		// dailies oldest-first, then background standing docs, then the
		// conversation, then goal docs, and Life Goals last of all.
		expect(ids(outcome.dropped)).toEqual([
			"daily:0",
			"daily:1",
			"stable:background",
			"conversation:0",
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
