import { describe, expect, it } from "vitest";

import { headingOutline, isEmptyBody, parseNote } from "./sections";
import {
	TemplateUnusableError,
	composeFromTemplate,
	frameBlankLines,
	instantiateTemplate,
} from "./template";
import { parseDraftReply } from "./prompt";
import {
	ALT_TEMPLATE_TEXT,
	HANDMADE_NOTE,
	MODEL_REPLY,
	TEMPLATE_TEXT,
} from "./fixtures/template";

const template = instantiateTemplate(TEMPLATE_TEXT, "26.08.16");

describe("instantiateTemplate", () => {
	it("resolves the date placeholder everywhere it appears", () => {
		expect(template.text).toContain("# 26.08.16");
		expect(template.text).not.toContain("xx.xx.xx");
	});

	it("derives the heading list from the file rather than from a constant", () => {
		expect(template.headings.map((h) => h.heading)).toEqual([
			"26.08.16",
			"Intention",
			"Today",
			"Schedule",
			"Waiting on",
			"Notes",
			"Threads",
			"Tomorrow",
		]);
	});

	it("follows a different template to a different outline", () => {
		// The guard against anyone inlining a copy of the headings above.
		const alt = instantiateTemplate(ALT_TEMPLATE_TEXT, "26.08.16");
		expect(alt.headings.map((h) => h.heading)).toEqual(["Rocks", "Admin", "Later"]);
		expect(alt.headings.map((h) => h.level)).toEqual([2, 2, 4]);
		expect(alt.parsed.preambleLines).toEqual(["---", "kind: mise", "---", ""]);
	});

	it("marks every section of a fresh template as scaffolding", () => {
		expect(template.headings.every((h) => h.placeholder)).toBe(true);
	});

	it("keeps the level-1 date title out of the sections to be filled", () => {
		// It is a name for the day, not a question. Asking for a body under it
		// puts a paragraph above the first `##` that no hand-made note has, and
		// reports the date as an unfilled section on every clean run.
		expect(template.fillable.map((h) => h.heading)).toEqual([
			"Intention",
			"Today",
			"Schedule",
			"Waiting on",
			"Notes",
			"Threads",
			"Tomorrow",
		]);
		expect(template.headings.map((h) => h.heading)).toContain("26.08.16");
	});

	it("is a rule about level, not about the title's text", () => {
		// A user who renames their title keeps the carve-out; nothing matches on
		// the date, the stem or the word.
		const renamed = instantiateTemplate("# Daily\n\n## Rocks\n- [ ] \n", "26.08.16");
		expect(renamed.fillable.map((h) => h.heading)).toEqual(["Rocks"]);
	});

	it("fills every heading of a template written entirely at level 1", () => {
		// The carve-out is for a title sitting above deeper sections. A template
		// that uses `#` for its real sections has no title to carve out, and must
		// not lose all of them.
		const flat = instantiateTemplate("# Rocks\n- [ ] \n\n# Admin\n\n", "26.08.16");
		expect(flat.fillable.map((h) => h.heading)).toEqual(["Rocks", "Admin"]);
	});

	it("leaves a template with no level-1 heading entirely fillable", () => {
		const alt = instantiateTemplate(ALT_TEMPLATE_TEXT, "26.08.16");
		expect(alt.fillable.map((h) => h.heading)).toEqual(["Rocks", "Admin", "Later"]);
	});

	it("refuses a template with no headings", () => {
		expect(() => instantiateTemplate("just a sentence\n", "26.08.16")).toThrow(
			TemplateUnusableError,
		);
	});
});

describe("composeFromTemplate", () => {
	const reply = parseDraftReply(MODEL_REPLY, template.headings);
	const composed = composeFromTemplate(template, reply.filled);

	it("produces the template's heading structure exactly", () => {
		expect(headingOutline(composed)).toEqual(headingOutline(template.text));
	});

	it("is structurally identical to a note the user wrote by hand", () => {
		// The stated done-when of PR 6: same headings, same levels, same order.
		expect(headingOutline(composed)).toEqual(headingOutline(HANDMADE_NOTE));
	});

	it("is byte-identical to the hand-made note when it says the same things", () => {
		// The outline check above compares headings, so it cannot see spacing —
		// prose butted against its heading passes it. This is the same claim at
		// the granularity the user actually reads: feed the hand-made note back as
		// if the model had written it, and the composed note must be that file,
		// byte for byte, blank lines included.
		const asIfFromTheModel = parseDraftReply(HANDMADE_NOTE, template.headings);
		expect(composeFromTemplate(template, asIfFromTheModel.filled)).toBe(HANDMADE_NOTE);
	});

	it("puts the model's content under the model's headings", () => {
		const sections = parseNote(composed).sections;
		const today = sections.find((s) => s.key === "today");
		expect(today?.bodyLines.join("\n")).toContain("- [ ] Send the invoice");
		expect(today?.bodyLines.join("\n")).not.toContain("Passport");
	});

	it("leaves a section the model declined to fill as the template wrote it", () => {
		const schedule = parseNote(composed).sections.find((s) => s.key === "schedule");
		const original = template.parsed.sections.find((s) => s.key === "schedule");
		// Spelled out rather than compared to `original` alone: two `undefined`s
		// are equal, so a section that vanished entirely would have passed.
		expect(schedule?.bodyLines).toEqual([""]);
		expect(original?.bodyLines).toEqual([""]);
		// A fallback that is *not* empty, for the same reason.
		expect(isEmptyBody(schedule?.bodyLines ?? ["content"])).toBe(true);
	});

	it("leaves the title's own body alone when the model writes under it", () => {
		// The model was not asked for the title, so a body under it is dropped
		// rather than written above the first `##`.
		const chatty = MODEL_REPLY.replace(
			"# 26.08.16\n",
			"# 26.08.16\nHere is your day, planned from your goals.\n",
		);
		const out = composeFromTemplate(template, parseDraftReply(chatty, template.headings).filled);
		expect(out).not.toContain("Here is your day");
		expect(out).toBe(composed);
	});

	it("ignores headings the template does not have", () => {
		const stray = MODEL_REPLY.replace("## Tomorrow", "## Invented\n\n- nonsense\n\n## Tomorrow");
		const out = composeFromTemplate(
			template,
			parseDraftReply(stray, template.headings).filled,
		);
		expect(out).not.toContain("nonsense");
		expect(headingOutline(out)).toEqual(headingOutline(template.text));
	});

	it("returns the bare template when the model said nothing", () => {
		expect(composeFromTemplate(template, [])).toBe(template.text);
	});

	it("is deterministic", () => {
		expect(composeFromTemplate(template, reply.filled)).toBe(composed);
	});

	it("fills the alternative template's sections, not this one's", () => {
		const alt = instantiateTemplate(ALT_TEMPLATE_TEXT, "26.08.16");
		const altReply = parseDraftReply(
			["## Rocks", "", "- [ ] One thing", "", "## Admin", "", "Expenses", ""].join("\n"),
			alt.headings,
		);
		const out = composeFromTemplate(alt, altReply.filled);
		expect(out).toContain("- [ ] One thing");
		expect(headingOutline(out)).toEqual(headingOutline(alt.text));
		expect(out.startsWith("---\nkind: mise\n---\n")).toBe(true);
	});
});

describe("frameBlankLines", () => {
	it("keeps the template's spacing around a body it replaces", () => {
		expect(frameBlankLines(["", "- [ ] ", ""])).toEqual({ before: [""], after: [""] });
		expect(frameBlankLines(["- [ ] ", ""])).toEqual({ before: [], after: [""] });
	});

	it("puts a blank line between a heading and the body it had no room for", () => {
		// `## Intention` with nothing under it says how much room the template
		// leaves before the next heading, not that prose belongs against the
		// heading. A hand-made note always has the gap.
		expect(frameBlankLines([""])).toEqual({ before: [""], after: [""] });
		expect(frameBlankLines(["", ""])).toEqual({ before: [""], after: ["", ""] });
		expect(frameBlankLines([])).toEqual({ before: [], after: [] });
	});
});
