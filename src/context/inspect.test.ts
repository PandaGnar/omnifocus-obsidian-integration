import { describe, expect, it } from "vitest";

import { VAULT_TREE } from "../vault/fixtures/vaultTree";
import { createVaultIndex } from "../vault/resolver";
import { DEFAULT_BUDGET } from "./budget";
import { fixtureReader } from "./fixtures/notes";
import { renderPackInspection } from "./inspect";
import { buildContextPack, renderPromptText } from "./pack";
import type { ContextPack } from "./types";

const index = createVaultIndex(VAULT_TREE);

function pack(budgetOverride?: Partial<typeof DEFAULT_BUDGET.groups>): Promise<ContextPack> {
	return buildContextPack(
		{
			index,
			date: { year: 2026, month: 8, day: 16 },
			question: "What should I focus on today?",
			budget:
				budgetOverride === undefined
					? undefined
					: { ...DEFAULT_BUDGET, groups: { ...DEFAULT_BUDGET.groups, ...budgetOverride } },
		},
		fixtureReader(),
	);
}

describe("renderPackInspection", () => {
	it("shows exactly what would be sent", async () => {
		const built = await pack();
		const report = renderPackInspection(built);
		expect(report).toContain(renderPromptText(built));
	});

	it("gives a token count per document", async () => {
		const built = await pack();
		const report = renderPackInspection(built);
		for (const section of built.sections) {
			if (section.path === null) continue;
			const line = report
				.split("\n")
				.find((l) => l.includes(section.path as string) && l.includes(section.title));
			expect(line, `no line for ${section.path}`).toBeDefined();
			expect(line).toContain(String(section.tokens));
		}
	});

	it("says what was dropped and why", async () => {
		const built = await pack({ dailies: 0 });
		const report = renderPackInspection(built);
		expect(report).toContain("Daily note 26.08.14 - over the dailies cap of 0 tokens");
		expect(report).toContain("Dropped (5)");
	});

	it("says when nothing was dropped", async () => {
		expect(renderPackInspection(await pack())).toContain("Dropped: nothing");
	});

	it("surfaces the goal-doc gap", async () => {
		expect(renderPackInspection(await pack())).toContain(
			"no `26 M08 Goals` - using `26 M07 Goals`",
		);
	});

	it("admits that the counts are estimates", async () => {
		const report = renderPackInspection(await pack());
		expect(report).toContain("heuristic estimates");
		expect(report).toContain("prompt_eval_count");
	});

	it("formats numbers without a locale", async () => {
		// `toLocaleString` would put a separator in 17,500 on one machine and
		// 17.500 on another. In a module about determinism, that would be funny.
		const report = renderPackInspection(await pack());
		expect(report).toContain("of 17500 budgeted tokens");
		expect(report).toContain("num_ctx 32768");
	});
});
