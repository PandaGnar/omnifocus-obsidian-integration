import { describe, expect, it } from "vitest";

import { STANDING_CONTEXT_DOCS } from "../context/pack";
import type { ContextPack } from "../context/types";
import { IN_THE_W32_GAP, TODAY, buildFixturePack } from "./fixtures/harness";
import {
	type ChatSource,
	deriveSources,
	renderSourcesMarkdown,
	sourceAnnotation,
	sourceLinkText,
} from "./sources";

const paths = (pack: ContextPack): string[] => deriveSources(pack).map((s) => s.path);

/** Fails loudly rather than letting an assertion pass over an absent source. */
function sourceById(pack: ContextPack, id: string): ChatSource {
	const source = deriveSources(pack).find((s) => s.id === id);
	if (source === undefined) throw new Error(`no source with id ${id} in the pack`);
	return source;
}

describe("deriveSources", () => {
	it("lists every note that was in the pack, and nothing else", async () => {
		const pack = await buildFixturePack();
		// The invariant, stated in both directions: what was sent is what is
		// listed. A footer that quietly omits a document makes the answer
		// unauditable in exactly the way that matters.
		const inPack = pack.sections
			.map((section) => section.path)
			.filter((path): path is string => path !== null);
		expect(paths(pack).slice().sort()).toEqual([...new Set(inPack)].sort());
		expect(paths(pack)).toHaveLength(inPack.length);
	});

	it("keeps wire order: standing docs, then goals longest horizon first, then dailies", async () => {
		const pack = await buildFixturePack();
		expect(paths(pack)).toEqual([
			"Long Term/Life Goals.md",
			"Long Term/Getting Unstuck Checklist.md",
			"Long Term/Childcare.md",
			"Financial Planning.md",
			"Long Term.md",
			"The Work.md",
			"Long Term/26 Y+ Goals.md",
			"Long Term/26 Q3 Goals.md",
			"Long Term/26 M07 Goals.md",
			"Long Term/26 W33 Goals.md",
			"Mise/26.08.10.md",
			"Mise/26.08.11.md",
			"Mise/26.08.12.md",
			"Mise/26.08.13.md",
			"Mise/26.08.14.md",
		]);
	});

	it("includes the quarter goals doc the plan's acceptance question turns on", async () => {
		const pack = await buildFixturePack({
			question: "What did I say I'd focus on this quarter?",
		});
		const quarter = sourceById(pack, "goal:quarter");
		expect(quarter.path).toBe("Long Term/26 Q3 Goals.md");
		expect(quarter.title).toBe("Quarter goals - 26 Q3 Goals");
		expect(quarter.note).toBeNull();
	});

	it("carries the resolver's fallback explanation onto the source", async () => {
		// 2026-08-05 is in ISO week 32, and the fixture vault has no
		// `26 W32 Goals` — the same gap the real vault has.
		const pack = await buildFixturePack({ date: IN_THE_W32_GAP });
		const week = sourceById(pack, "goal:week");
		expect(week.path).toBe("Long Term/26 W31 Goals.md");
		expect(week.note).toContain("26 W32 Goals");
		expect(sourceAnnotation(week)).toContain("most recent doc");
	});

	it("says nothing extra about a document that was the one asked for", async () => {
		const pack = await buildFixturePack({ date: TODAY });
		const week = sourceById(pack, "goal:week");
		expect(week.path).toBe("Long Term/26 W33 Goals.md");
		expect(sourceAnnotation(week)).toBeNull();
	});

	it("marks a document the per-document cap cut short", async () => {
		const pack = await buildFixturePack();
		const budgeted = await buildFixturePack({
			budget: {
				...pack.budget,
				perDocument: { ...pack.budget.perDocument, goal: 3 },
			},
		});
		const quarter = sourceById(budgeted, "goal:quarter");
		expect(quarter.truncated).toBe(true);
		expect(sourceAnnotation(quarter)).toContain("per-document cap");
	});

	it("drops a document from the list when the budget dropped it from the pack", async () => {
		const pack = await buildFixturePack();
		const squeezed = await buildFixturePack({
			budget: { ...pack.budget, groups: { ...pack.budget.groups, dailies: 0 } },
		});
		expect(paths(squeezed).some((path) => path.startsWith("Mise/"))).toBe(false);
		// ... and the pack agrees, which is the point: the footer follows the
		// pack rather than a second, independent guess at what was sent.
		expect(squeezed.sections.some((s) => s.group === "dailies")).toBe(false);
	});

	it("lists a path once even if two sections claim it", async () => {
		const pack = await buildFixturePack();
		const doubled: ContextPack = {
			...pack,
			sections: [...pack.sections, ...pack.sections],
		};
		expect(deriveSources(doubled)).toHaveLength(deriveSources(pack).length);
	});

	it("ignores sections that came from no file", async () => {
		const pack = await buildFixturePack();
		for (const source of deriveSources(pack)) {
			expect(source.kind).not.toBe("system");
			expect(source.kind).not.toBe("question");
			expect(source.kind).not.toBe("date");
		}
	});

	it("covers every standing doc the pack declares", async () => {
		const pack = await buildFixturePack();
		for (const doc of STANDING_CONTEXT_DOCS) {
			expect(paths(pack)).toContain(doc.path);
		}
	});
});

describe("the fallback admission", () => {
	it("is the very sentence the model was shown, not a second wording of it", async () => {
		// The drift guard. The footer and the prompt have to agree about a
		// substituted document, and they agree by sharing a string rather than
		// by two pieces of code independently describing the same fallback.
		const pack = await buildFixturePack({ date: IN_THE_W32_GAP });
		const note = sourceById(pack, "goal:week").note;
		expect(note).not.toBeNull();
		const gaps = pack.sections.find((section) => section.id === "gaps");
		if (gaps === undefined) throw new Error("the pack emitted no gaps section");
		expect(gaps.text).toContain(`- ${note ?? ""}`);
	});

	it("stays out of the document's own prompt text", async () => {
		// Where it must not be. `26 W32 Goals` is computed from the calendar; in
		// the stable block it would give the same document different bytes on
		// different days and cost a prefill of the whole cached prefix. The
		// section carries it as metadata instead.
		const pack = await buildFixturePack({ date: IN_THE_W32_GAP });
		const week = pack.sections.find((section) => section.id === "goal:week");
		if (week === undefined) throw new Error("the pack resolved no week goal doc");
		expect(week.note).toContain("26 W32 Goals");
		expect(week.text).not.toContain("26 W32");
		expect(week.text).not.toContain("Note:");
	});

	it("appears once per gap and on no other document", async () => {
		// One admission per fallback, both directions: a document the pack got is
		// never annotated, and a fallback never goes unannotated. Counting
		// against the gaps section rather than a hard-coded number keeps the test
		// honest if the fixture vault's gaps ever change.
		const pack = await buildFixturePack({ date: IN_THE_W32_GAP });
		const annotated = deriveSources(pack).filter((source) => source.note !== null);
		const gaps = pack.sections.find((section) => section.id === "gaps");
		if (gaps === undefined) throw new Error("the pack emitted no gaps section");
		const lines = gaps.text.split("\n").filter((line) => line.startsWith("- "));
		expect(annotated).toHaveLength(lines.length);
		expect(annotated.map((source) => `- ${source.note ?? ""}`).sort()).toEqual(lines.slice().sort());
		// And the standing docs, which are addressed by path and can never fall
		// back, carry nothing.
		for (const source of deriveSources(pack)) {
			if (source.kind === "standing") expect(source.note).toBeNull();
		}
	});
});

describe("link text", () => {
	it("strips folder and extension", () => {
		expect(sourceLinkText("Long Term/26 Q3 Goals.md")).toBe("26 Q3 Goals");
		expect(sourceLinkText("Mise/26.08.14.md")).toBe("26.08.14");
		expect(sourceLinkText("Long Term.md")).toBe("Long Term");
	});
});

describe("renderSourcesMarkdown", () => {
	it("writes wikilinks that resolve from anywhere in the vault", async () => {
		const pack = await buildFixturePack();
		const markdown = renderSourcesMarkdown(deriveSources(pack));
		expect(markdown).toContain("[[Long Term/26 Q3 Goals|Quarter goals - 26 Q3 Goals]]");
		expect(markdown).not.toContain(".md|");
	});

	it("annotates a fallback in the saved markdown too", async () => {
		const pack = await buildFixturePack({ date: IN_THE_W32_GAP });
		expect(renderSourcesMarkdown(deriveSources(pack))).toContain("26 W32 Goals");
	});

	it("says so rather than nothing when the pack had no documents", () => {
		expect(renderSourcesMarkdown([])).toContain("none");
	});
});
