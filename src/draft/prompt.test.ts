import { describe, expect, it } from "vitest";

import {
	buildDraftInstruction,
	draftReplySignals,
	parseDraftReply,
	stripEnclosingFence,
} from "./prompt";
import { instantiateTemplate } from "./template";
import { ALT_TEMPLATE_TEXT, MODEL_REPLY, TEMPLATE_TEXT } from "./fixtures/template";

const template = instantiateTemplate(TEMPLATE_TEXT, "26.08.16");

describe("buildDraftInstruction", () => {
	it("quotes the template's heading lines verbatim", () => {
		const instruction = buildDraftInstruction(template.headings);
		for (const heading of template.headings) {
			expect(instruction).toContain(`\n${heading.headingLine}\n`);
		}
	});

	it("carries the alternative template's headings when given them", () => {
		const alt = instantiateTemplate(ALT_TEMPLATE_TEXT, "26.08.16");
		const instruction = buildDraftInstruction(alt.headings);
		expect(instruction).toContain("#### Later");
		expect(instruction).not.toContain("## Intention");
	});

	it("contains no date, so it cannot be blamed for a cache miss on its own", () => {
		// The pack puts "Today is ..." in the section immediately above this one;
		// a second copy here would be a second daily-changing string for nothing.
		// (The heading list does carry the note's own stem, which the template
		// put there — hence the check is for a *long-form* date.)
		const instruction = buildDraftInstruction(template.headings);
		expect(instruction).not.toMatch(/\b(August|Sunday|2026-08-16)\b/);
	});

	it("is deterministic", () => {
		expect(buildDraftInstruction(template.headings)).toBe(
			buildDraftInstruction(template.headings),
		);
	});
});

describe("stripEnclosingFence", () => {
	it("removes a fence around the whole reply", () => {
		expect(stripEnclosingFence("```markdown\n## Today\n- a\n```")).toBe("## Today\n- a");
		expect(stripEnclosingFence("~~~\n## Today\n~~~")).toBe("## Today");
	});

	it("leaves a fenced snippet inside a section alone", () => {
		const reply = "## Today\n\n```sh\nmake\n```\n\n## Tomorrow\n";
		expect(stripEnclosingFence(reply)).toBe(reply);
	});

	it("leaves an unterminated fence alone", () => {
		expect(stripEnclosingFence("```\n## Today\n- a\n")).toBe("```\n## Today\n- a\n");
	});
});

describe("parseDraftReply", () => {
	const parsed = parseDraftReply(MODEL_REPLY, template.headings);

	it("matches the model's sections to the template's headings", () => {
		expect(parsed.filled.map((f) => f.key)).toEqual([
			"intention",
			"today",
			"waiting on",
			"notes",
			"threads",
			"tomorrow",
		]);
	});

	it("reports the sections the model chose to leave empty, in template order", () => {
		expect(parsed.unfilledHeadings).toEqual(["26.08.16", "Schedule"]);
	});

	it("trims the blank lines the model padded its bodies with", () => {
		const today = parsed.filled.find((f) => f.key === "today");
		expect(today?.bodyLines[0]).toBe("- [ ] Cutover rehearsal, start to finish");
		expect(today?.bodyLines[today.bodyLines.length - 1]).toBe("- [ ] Send the invoice");
	});

	it("matches a heading whose case or punctuation drifted", () => {
		const drifted = parseDraftReply("## today:\n\n- [ ] a\n", template.headings);
		expect(drifted.filled.map((f) => f.key)).toEqual(["today"]);
	});

	it("drops invented headings and names them", () => {
		const stray = parseDraftReply("## Today\n\n- a\n\n## Mood\n\n- fine\n", template.headings);
		expect(stray.filled.map((f) => f.key)).toEqual(["today"]);
		expect(stray.strayHeadings).toEqual(["Mood"]);
	});

	it("takes the first body when a heading repeats, not the loop that follows", () => {
		const looped = parseDraftReply(
			"## Today\n\n- first\n\n## Today\n\n- second\n",
			template.headings,
		);
		expect(looped.filled).toHaveLength(1);
		expect(looped.filled[0]?.bodyLines).toEqual(["- first"]);
	});

	it("notices prose written before the first heading", () => {
		expect(parseDraftReply("Sure! Here you go.\n\n## Today\n- a\n", template.headings).hadPreamble).toBe(
			true,
		);
		expect(parsed.hadPreamble).toBe(false);
	});

	it("fills nothing from a reply with no headings in it", () => {
		const none = parseDraftReply("I could not find anything to plan today.", template.headings);
		expect(none.filled).toEqual([]);
		expect(none.unfilledHeadings).toHaveLength(template.headings.length);
	});

	it("survives a reply the model fenced", () => {
		const fenced = parseDraftReply("```markdown\n## Today\n\n- [ ] a\n```", template.headings);
		expect(fenced.filled.map((f) => f.key)).toEqual(["today"]);
	});
});

describe("draftReplySignals", () => {
	it("warns loudly when nothing at all was filled", () => {
		const signals = draftReplySignals(
			parseDraftReply("nothing useful", template.headings),
			template.headings.length,
		);
		expect(signals.map((s) => [s.code, s.level])).toContainEqual(["draft-empty", "warning"]);
	});

	it("mentions the sections left as the template wrote them", () => {
		const signals = draftReplySignals(
			parseDraftReply(MODEL_REPLY, template.headings),
			template.headings.length,
		);
		const unfilled = signals.find((s) => s.code === "draft-unfilled");
		expect(unfilled?.text).toContain("Schedule");
		expect(unfilled?.level).toBe("info");
	});

	it("says nothing when every section came back filled", () => {
		const everything = template.headings
			.map((heading) => `${heading.headingLine}\n\n- something\n`)
			.join("\n");
		expect(
			draftReplySignals(
				parseDraftReply(everything, template.headings),
				template.headings.length,
			),
		).toEqual([]);
	});
});
