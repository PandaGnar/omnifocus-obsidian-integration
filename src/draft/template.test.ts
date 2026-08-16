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

	it("puts the model's content under the model's headings", () => {
		const sections = parseNote(composed).sections;
		const today = sections.find((s) => s.key === "today");
		expect(today?.bodyLines.join("\n")).toContain("- [ ] Send the invoice");
		expect(today?.bodyLines.join("\n")).not.toContain("Passport");
	});

	it("leaves a section the model declined to fill as the template wrote it", () => {
		const schedule = parseNote(composed).sections.find((s) => s.key === "schedule");
		const original = template.parsed.sections.find((s) => s.key === "schedule");
		expect(schedule?.bodyLines).toEqual(original?.bodyLines);
		expect(isEmptyBody(schedule?.bodyLines ?? [])).toBe(true);
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

	it("treats an all-blank body as one blank line after", () => {
		expect(frameBlankLines([""])).toEqual({ before: [], after: [""] });
		expect(frameBlankLines([])).toEqual({ before: [], after: [] });
	});
});
