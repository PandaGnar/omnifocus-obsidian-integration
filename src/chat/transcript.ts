// Turning one exchange into markdown, and splicing it into a daily note.
//
// The conversation is ephemeral; this is the one path by which any of it
// survives, so it carries the sources with it. An answer saved without the
// notes it was built from is exactly the unverifiable artefact the footer
// exists to prevent — worse in the note than in the sidebar, because the note
// outlives the session that could have explained it.
//
// `appendExchange` is the only write path, and it appends. It never rewrites a
// line it did not add, never reorders, and never touches anything above its own
// heading: "the plugin proposes, the user commits" applies to a log entry as
// much as to a drafted note.
//
// Pure: strings in, strings out, no `obsidian` import and no file system. The
// view reads the note, calls this, and writes the result back.

import type { ChatExchange } from "./session";
import { renderSignalsMarkdown } from "./signals";
import { renderSourcesMarkdown } from "./sources";

/** The heading the plugin owns in a daily note. Everything else is the user's. */
export const TRANSCRIPT_HEADING = "## Assistant log";

export interface RenderExchangeOptions {
	/**
	 * Included verbatim, never generated here. The date belongs to the note the
	 * entry lands in, and a clock read inside this function would make the
	 * output untestable for the sake of a value the caller already has.
	 */
	readonly stamp?: string;
}

/**
 * One exchange as markdown: the question, the answer, what was in context, and
 * anything the user was warned about at the time.
 *
 * The warnings are saved rather than dropped on purpose. "This answer was built
 * on `26 W31 Goals` because `26 W32 Goals` does not exist" is a fact about the
 * answer, and it stops being recoverable the moment the sidebar is closed.
 */
export function renderExchangeMarkdown(
	exchange: ChatExchange,
	options: RenderExchangeOptions = {},
): string {
	const title = options.stamp === undefined ? "" : ` (${options.stamp})`;
	const blocks: string[] = [`### ${firstLine(exchange.question)}${title}`];

	if (exchange.status !== "done") {
		blocks.push(`*${statusNote(exchange)}*`);
	}

	const answer = exchange.answer.trim();
	blocks.push(answer === "" ? "*No answer was received.*" : answer);
	blocks.push(renderSourcesMarkdown(exchange.sources));

	const signals = renderSignalsMarkdown(exchange.signals);
	if (signals !== "") blocks.push(signals);

	return blocks.join("\n\n");
}

function statusNote(exchange: ChatExchange): string {
	switch (exchange.status) {
		case "cancelled":
			return "Cancelled part-way through; the answer below is incomplete.";
		case "error":
			return `The request failed: ${exchange.error ?? "unknown error"}.`;
		default:
			return "Saved while the answer was still being generated.";
	}
}

function firstLine(question: string): string {
	const line = question.trim().split("\n")[0] ?? "";
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * Splice an entry into a note's text.
 *
 * Append-only, and the heading is added at most once so a day's worth of
 * questions collects under one section rather than sprouting a heading each
 * time. Existing content is returned byte-for-byte with only its trailing
 * whitespace normalised — this runs against notes the user has been writing in
 * all day.
 */
export function appendExchange(existing: string, entry: string): string {
	const body = existing.replace(/\s+$/, "");
	const parts: string[] = [];
	if (body !== "") parts.push(body);
	if (!hasTranscriptHeading(body)) parts.push(TRANSCRIPT_HEADING);
	parts.push(entry.trim());
	return `${parts.join("\n\n")}\n`;
}

/** Does the note already have the plugin's heading, at any level of nesting? */
export function hasTranscriptHeading(text: string): boolean {
	for (const line of text.split("\n")) {
		if (line.trim() === TRANSCRIPT_HEADING) return true;
	}
	return false;
}

/**
 * Body for a daily note that does not exist yet.
 *
 * Saving a conversation should not require having written the day's note first,
 * but neither should it pre-empt PR 6, which fills the real template. So a note
 * created here is the transcript and a title, and nothing that pretends to be
 * the template — a later `draft today` finds an existing note and offers to
 * fill its empty sections rather than finding a plausible-looking fake.
 */
export function newNoteWithExchange(stem: string, entry: string): string {
	return appendExchange(`# ${stem}`, entry);
}
