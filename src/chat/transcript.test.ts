import { describe, expect, it } from "vitest";

import type { ChatExchange } from "./session";
import type { ChatSource } from "./sources";
import {
	TRANSCRIPT_HEADING,
	appendExchange,
	hasTranscriptHeading,
	newNoteWithExchange,
	renderExchangeMarkdown,
} from "./transcript";

const quarter: ChatSource = {
	id: "goal:quarter",
	path: "Long Term/26 Q3 Goals.md",
	title: "Quarter goals - 26 Q3 Goals",
	kind: "goal",
	truncated: false,
	note: null,
};

const week: ChatSource = {
	id: "goal:week",
	path: "Long Term/26 W31 Goals.md",
	title: "Week goals - 26 W31 Goals",
	kind: "goal",
	truncated: false,
	note: "no `26 W32 Goals` note exists, so this is the most recent doc at this horizon",
};

function exchange(overrides: Partial<ChatExchange> = {}): ChatExchange {
	return {
		id: 1,
		question: "What did I say I'd focus on this quarter?",
		answer: "Finishing the migration, and two weeks entirely offline.",
		status: "done",
		sources: [quarter],
		signals: [],
		error: null,
		...overrides,
	};
}

describe("renderExchangeMarkdown", () => {
	it("keeps the question, the answer and the sources together", () => {
		const markdown = renderExchangeMarkdown(exchange());
		expect(markdown).toContain("### What did I say I'd focus on this quarter?");
		expect(markdown).toContain("Finishing the migration");
		expect(markdown).toContain("[[Long Term/26 Q3 Goals|Quarter goals - 26 Q3 Goals]]");
	});

	it("saves the sources even when there were none, rather than looking grounded", () => {
		expect(renderExchangeMarkdown(exchange({ sources: [] }))).toContain("Sources: none");
	});

	it("carries the fallback explanation into the note", () => {
		// The sidebar is where this was explained and the sidebar is going away.
		// Without it the saved answer claims to be about this week.
		const markdown = renderExchangeMarkdown(exchange({ sources: [week] }));
		expect(markdown).toContain("26 W32 Goals");
	});

	it("carries the warnings the user saw at the time", () => {
		const markdown = renderExchangeMarkdown(
			exchange({
				signals: [
					{ code: "prompt-truncated", level: "warning", text: "Prompt was truncated." },
				],
			}),
		);
		expect(markdown).toContain("**Prompt was truncated.**");
	});

	it("marks a cancelled answer as incomplete", () => {
		const markdown = renderExchangeMarkdown(
			exchange({ status: "cancelled", answer: "Finishing the mig" }),
		);
		expect(markdown).toContain("Cancelled part-way through");
	});

	it("records a failure with its message", () => {
		const markdown = renderExchangeMarkdown(
			exchange({ status: "error", answer: "", error: "connection refused" }),
		);
		expect(markdown).toContain("connection refused");
		expect(markdown).toContain("No answer was received");
	});

	it("takes the stamp from the caller rather than reading a clock", () => {
		// A clock inside the renderer would make the output untestable for the
		// sake of a value the view already has.
		expect(renderExchangeMarkdown(exchange(), { stamp: "14:07" })).toContain("(14:07)");
		expect(renderExchangeMarkdown(exchange())).not.toContain("(");
	});

	it("keeps a multi-line question to one heading line", () => {
		const markdown = renderExchangeMarkdown(
			exchange({ question: "first line\nsecond line\nthird" }),
		);
		expect(markdown.split("\n")[0]).toBe("### first line");
		expect(markdown).not.toContain("### first line\nsecond");
	});
});

describe("appendExchange", () => {
	it("adds the heading once and appends under it thereafter", () => {
		const first = appendExchange("# 26.08.16\n\n## Done\n- Shipped it\n", "### q\n\na");
		expect(first).toContain(TRANSCRIPT_HEADING);
		const second = appendExchange(first, "### q2\n\nb");
		expect(second.split(TRANSCRIPT_HEADING)).toHaveLength(2);
		expect(second.indexOf("### q")).toBeLessThan(second.indexOf("### q2"));
	});

	it("never touches what was already in the note", () => {
		const existing = "# 26.08.16\n\n## Done\n- Shipped it\n- Called the dentist\n";
		const after = appendExchange(existing, "### q\n\na");
		expect(after.startsWith(existing.trimEnd())).toBe(true);
	});

	it("copes with an empty note", () => {
		const after = appendExchange("", "### q\n\na");
		expect(after.startsWith(TRANSCRIPT_HEADING)).toBe(true);
		expect(after.endsWith("\n")).toBe(true);
	});

	it("normalises trailing whitespace rather than piling up blank lines", () => {
		const after = appendExchange("# note\n\n\n\n", "### q\n\na");
		expect(after).not.toContain("\n\n\n");
	});
});

describe("hasTranscriptHeading", () => {
	it("matches the heading and not a line that merely mentions it", () => {
		expect(hasTranscriptHeading("## Assistant log")).toBe(true);
		expect(hasTranscriptHeading("see the ## Assistant log below")).toBe(false);
		expect(hasTranscriptHeading("## Assistant logs")).toBe(false);
	});
});

describe("newNoteWithExchange", () => {
	it("titles the note and nothing more, leaving the template to PR 6", () => {
		const body = newNoteWithExchange("26.08.16", "### q\n\na");
		expect(body.startsWith("# 26.08.16\n\n")).toBe(true);
		expect(body).toContain(TRANSCRIPT_HEADING);
		expect(body).not.toContain("## Done");
	});
});
