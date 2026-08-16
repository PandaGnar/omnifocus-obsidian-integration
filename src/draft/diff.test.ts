import { describe, expect, it } from "vitest";

import { collapseDiff, diffLineText, diffLines, diffStats, isNoOpDiff } from "./diff";
import { HANDMADE_NOTE, TEMPLATE_TEXT } from "./fixtures/template";

/** The `after` side of a diff, reassembled. Must equal the text diffed. */
function rebuildAfter(before: string, after: string): string {
	return diffLines(before, after)
		.filter((line) => line.kind !== "remove")
		.map((line) => line.text)
		.join("\n");
}

/** The `before` side, likewise. */
function rebuildBefore(before: string, after: string): string {
	return diffLines(before, after)
		.filter((line) => line.kind !== "add")
		.map((line) => line.text)
		.join("\n");
}

describe("diffLines", () => {
	it("reports nothing for identical text", () => {
		const diff = diffLines(HANDMADE_NOTE, HANDMADE_NOTE);
		expect(isNoOpDiff(diff)).toBe(true);
		expect(diffStats(diff)).toEqual({ added: 0, removed: 0 });
	});

	it("reports a change for text that differs by one line", () => {
		const changed = HANDMADE_NOTE.replace("Slept badly.", "Slept fine.");
		const diff = diffLines(HANDMADE_NOTE, changed);
		expect(isNoOpDiff(diff)).toBe(false);
		expect(diffStats(diff)).toEqual({ added: 1, removed: 1 });
	});

	it("treats a new note as all additions and no removals", () => {
		const diff = diffLines("", HANDMADE_NOTE);
		expect(diffStats(diff)).toEqual({
			added: HANDMADE_NOTE.split("\n").length,
			removed: 0,
		});
		expect(diff.every((line) => line.kind === "add")).toBe(true);
	});

	it("keeps the shared lines as context rather than rewriting the note", () => {
		// Filling the template's empty sections should read as insertions into a
		// note whose skeleton is unchanged, not as a wholesale replacement.
		const filled = TEMPLATE_TEXT.replace("## Intention\n", "## Intention\n\nShip it.\n");
		const diff = diffLines(TEMPLATE_TEXT, filled);
		expect(diffStats(diff).removed).toBe(0);
		expect(diff.filter((line) => line.kind === "context").length).toBeGreaterThan(10);
	});

	const pairs: readonly (readonly [string, string, string])[] = [
		["identical", HANDMADE_NOTE, HANDMADE_NOTE],
		["created", "", HANDMADE_NOTE],
		["deleted", HANDMADE_NOTE, ""],
		["reordered", "a\nb\nc", "c\nb\na"],
		["template filled", TEMPLATE_TEXT, HANDMADE_NOTE],
		["one blank line", "\n", ""],
	];
	for (const [name, before, after] of pairs) {
		it(`round-trips both sides for the ${name} case`, () => {
			// Asserted against the inputs, not against anything the diff derived:
			// a diff that drops or invents a line fails here.
			expect(rebuildBefore(before, after)).toBe(before);
			expect(rebuildAfter(before, after)).toBe(after);
		});
	}
});

describe("collapseDiff", () => {
	const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
	const after = before.replace("1", "one");

	it("keeps every changed line and the requested context around it", () => {
		const collapsed = collapseDiff(diffLines(before, after), 2);
		const texts = collapsed.map(diffLineText);
		expect(texts).toContain("- 1");
		expect(texts).toContain("+ one");
		expect(texts).toContain("  2");
		expect(texts).toContain("  3");
		expect(texts).not.toContain("  4");
	});

	it("marks each elided run exactly once", () => {
		const collapsed = collapseDiff(diffLines(before, after), 1);
		expect(collapsed.filter((line) => line === null)).toHaveLength(1);
	});

	it("elides nothing from a diff with no unchanged lines", () => {
		const collapsed = collapseDiff(diffLines("", "a\nb"));
		expect(collapsed.every((line) => line !== null)).toBe(true);
	});
});
