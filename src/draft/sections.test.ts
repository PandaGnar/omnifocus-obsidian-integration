import { describe, expect, it } from "vitest";

import {
	headingKey,
	headingOutline,
	isEmptyBody,
	lineContent,
	lineEndingOf,
	parseNote,
	renderNote,
	textWithLineEnding,
	trimBlankEdges,
	withLineEnding,
} from "./sections";
import { HALF_WRITTEN_NOTE, HANDMADE_NOTE, TEMPLATE_TEXT } from "./fixtures/template";

describe("round trip", () => {
	// Exactness here is what makes "running it twice is a no-op" decidable by
	// string comparison downstream. A parser that trimmed trailing newlines
	// would report a change on a note nobody touched.
	const cases: readonly (readonly [string, string])[] = [
		["the template", TEMPLATE_TEXT],
		["a hand-made note", HANDMADE_NOTE],
		["a half-written note", HALF_WRITTEN_NOTE],
		["empty", ""],
		["no headings at all", "just a sentence\n\nand another\n"],
		["no trailing newline", "# a\nbody"],
		["several trailing newlines", "# a\nbody\n\n\n"],
		["CRLF", "# a\r\nbody\r\n\r\n## b\r\n- [ ] \r\n"],
		["frontmatter", "---\nkind: mise\n---\n\n## a\n\nbody\n"],
		["a heading with a closing sequence", "## a ##\n\nbody\n"],
		["setext-looking underline", "a\n---\n\n## b\n"],
		["indented heading-ish line", "  # not a heading at the margin\n"],
	];

	for (const [name, text] of cases) {
		it(`is byte-identical for ${name}`, () => {
			expect(renderNote(parseNote(text))).toBe(text);
		});
	}
});

describe("parsing", () => {
	it("splits the template into its headings, in order, with levels", () => {
		const parsed = parseNote(TEMPLATE_TEXT);
		expect(parsed.sections.map((s) => [s.level, s.heading])).toEqual([
			[1, "xx.xx.xx"],
			[2, "Intention"],
			[2, "Today"],
			[2, "Schedule"],
			[2, "Waiting on"],
			[2, "Notes"],
			[3, "Threads"],
			[2, "Tomorrow"],
		]);
	});

	it("puts everything before the first heading in the preamble", () => {
		const parsed = parseNote("---\nkind: mise\n---\n\n## Today\n- [ ] \n");
		expect(parsed.preambleLines).toEqual(["---", "kind: mise", "---", ""]);
		expect(parsed.sections).toHaveLength(1);
	});

	it("does not read a comment inside a fenced block as a heading", () => {
		const parsed = parseNote(
			["## Today", "", "```sh", "# rebuild the index", "make", "```", ""].join("\n"),
		);
		expect(parsed.sections.map((s) => s.heading)).toEqual(["Today"]);
		expect(parsed.sections[0]?.bodyLines).toContain("# rebuild the index");
	});

	it("closes a fence only with its own marker", () => {
		const parsed = parseNote(["## a", "~~~", "```", "# still fenced", "~~~", "## b"].join("\n"));
		expect(parsed.sections.map((s) => s.heading)).toEqual(["a", "b"]);
	});

	it("requires whitespace after the hashes", () => {
		// `#tag` is an Obsidian tag, not a heading, and treating it as one would
		// invent a section the merge could then fill.
		expect(parseNote("#project\n\nbody\n").sections).toHaveLength(0);
	});
});

describe("headingKey", () => {
	it("matches the variations a model produces", () => {
		expect(headingKey("Waiting on")).toBe(headingKey("**waiting  on**"));
		expect(headingKey("Today")).toBe(headingKey("Today:"));
	});

	it("keeps different sections apart", () => {
		expect(headingKey("Today")).not.toBe(headingKey("Tomorrow"));
		expect(headingKey("Notes")).not.toBe(headingKey("Threads"));
	});
});

describe("emptiness", () => {
	const empty = [
		[],
		[""],
		["", ""],
		["- "],
		["- [ ] "],
		["- [x]"],
		["1. "],
		["> "],
		["> - [ ] "],
		["", "- [ ] ", ""],
	];
	for (const body of empty) {
		it(`treats ${JSON.stringify(body)} as scaffolding`, () => {
			expect(isEmptyBody(body)).toBe(true);
		});
	}

	const filled = [
		["- [ ] Invoice"],
		["prose"],
		["- [x] done"],
		["", "> a quoted line", ""],
		["- ", "- something"],
		["1. first"],
		// No template in this vault ships a horizontal rule, so a rule under a
		// heading is a divider the user typed. The `fill` path *replaces* an empty
		// body, so calling it scaffolding would delete it.
		["---"],
		["***"],
		["___"],
		["", "---", ""],
	];
	for (const body of filled) {
		it(`treats ${JSON.stringify(body)} as the user's`, () => {
			expect(isEmptyBody(body)).toBe(false);
		});
	}

	it("reads content off a line by stripping only structure", () => {
		expect(lineContent("- [ ] Cutover rehearsal")).toBe("Cutover rehearsal");
		expect(lineContent("   - [ ]   ")).toBe("");
	});
});

describe("headingOutline", () => {
	it("is the same for a hand-made note and for the template it came from", () => {
		expect(headingOutline(HANDMADE_NOTE)).toEqual(headingOutline(TEMPLATE_TEXT.replace(/xx\.xx\.xx/g, "26.08.16")));
	});

	it("notices a missing section", () => {
		const without = HANDMADE_NOTE.replace(/## Schedule\n\n09:30 standup\n\n/, "");
		expect(headingOutline(without)).not.toEqual(headingOutline(HANDMADE_NOTE));
	});
});

describe("trimBlankEdges", () => {
	it("removes blanks from both ends and nothing from the middle", () => {
		expect(trimBlankEdges(["", "a", "", "b", "  ", ""])).toEqual(["a", "", "b"]);
	});

	it("collapses an all-blank body to nothing", () => {
		expect(trimBlankEdges(["", "  ", ""])).toEqual([]);
	});
});

describe("CRLF notes", () => {
	// The round-trip case above passes whether or not CRLF parses at all: with no
	// headings found, every line lands in the preamble and renders back unchanged.
	// These assert the parse itself, which is what actually broke — a `(.*)$` tail
	// matches nothing on a line ending in `\r`, so a Windows note read as having no
	// sections and the merge appended the entire draft underneath it.
	const NOTE = "# 26.08.16\r\n\r\n## Today\r\n- [ ] \r\n\r\n## Notes\r\n\r\n";

	it("finds the headings", () => {
		expect(parseNote(NOTE).sections.map((s) => [s.level, s.heading])).toEqual([
			[1, "26.08.16"],
			[2, "Today"],
			[2, "Notes"],
		]);
	});

	it("leaves no carriage return in the heading or its key", () => {
		for (const section of parseNote(NOTE).sections) {
			expect(section.heading).not.toContain("\r");
			expect(section.key).not.toContain("\r");
		}
	});

	it("keeps the heading line verbatim, so the round trip stays exact", () => {
		expect(parseNote(NOTE).sections[0]?.headingLine).toBe("# 26.08.16\r");
		expect(renderNote(parseNote(NOTE))).toBe(NOTE);
	});

	it("still sees a CRLF template section as empty scaffolding", () => {
		const today = parseNote(NOTE).sections.find((s) => s.key === "today");
		expect(isEmptyBody(today?.bodyLines ?? [])).toBe(true);
	});

	it("strips a closing hash sequence as well as the line ending", () => {
		expect(parseNote("## a ##\r\n").sections[0]?.heading).toBe("a");
	});

	it("does not read a CRLF tag line as a heading", () => {
		expect(parseNote("#project\r\n\r\nbody\r\n").sections).toHaveLength(0);
	});
});

describe("line endings", () => {
	it("reports the ending a note uses", () => {
		expect(lineEndingOf("# a\n")).toBe("\n");
		expect(lineEndingOf("# a\r\n")).toBe("\r\n");
		expect(lineEndingOf("")).toBe("\n");
		// A mixed note counts as CRLF, so added lines match the majority.
		expect(lineEndingOf("# a\r\nb\n")).toBe("\r\n");
	});

	it("converts lines in both directions and is idempotent", () => {
		expect(withLineEnding(["a", "", "b"], "\r\n")).toEqual(["a\r", "\r", "b\r"]);
		expect(withLineEnding(["a\r", "\r"], "\n")).toEqual(["a", ""]);
		expect(withLineEnding(withLineEnding(["a"], "\r\n"), "\r\n")).toEqual(["a\r"]);
	});

	it("converts a whole string without stranding a carriage return at the end", () => {
		expect(textWithLineEnding("## a\n\nbody\n", "\r\n")).toBe("## a\r\n\r\nbody\r\n");
		expect(textWithLineEnding("## a\r\n\r\nbody\r\n", "\n")).toBe("## a\n\nbody\n");
		expect(textWithLineEnding("## a\r\n", "\r\n")).toBe("## a\r\n");
	});
});
