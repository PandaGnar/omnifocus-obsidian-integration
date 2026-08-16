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
// It also never *creates* a note — see `planTranscriptSave`. Note creation
// belongs to the daily-note drafter, and a transcript-only note handed to it is
// one it is not allowed to fix.
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

export type TranscriptSavePlan =
	/** The day has a note; append to this path. */
	| { readonly kind: "append"; readonly path: string }
	/** The day has no note. Nothing is written; the user is told what to run. */
	| { readonly kind: "no-note"; readonly message: string };

/**
 * What `save to note` is allowed to do for a day, given whatever the resolver
 * found for it.
 *
 * The interesting half is what it refuses. Creating the day's note here was
 * cheap and safe on its own terms — it used `newDailyNotePath` and appended
 * rather than overwriting — but a note created that way holds a title and a
 * transcript and no template sections at all, and that breaks the drafter that
 * owns note creation. Its two rules are "on a day with no note, produce a note
 * structurally identical to a hand-made one" and "if the note exists, offer to
 * open it or to fill only its empty sections". Over a transcript-only note the
 * first no longer applies and the second has nothing to fill: saving one
 * exchange in the morning would quietly cost the user their drafted note for
 * the whole day, by the drafter's own rules. The comment that used to sit here
 * claimed the opposite — that a later `draft today` would "offer to fill its
 * empty sections" — of a note that has none.
 *
 * So this path does one thing, appends to a note somebody else made, and says
 * so when it cannot. That is also the smaller feature: the diff-preview gate
 * stays the only way a template-shaped note is ever written.
 *
 * The path comes from the resolver rather than from the date, so a note in a
 * `YY.MM/` bucket or carrying an Obsidian collision suffix is appended to
 * rather than shadowed by a flat second copy.
 */
export function planTranscriptSave(
	existingPath: string | null,
	stem: string,
): TranscriptSavePlan {
	if (existingPath === null) {
		return {
			kind: "no-note",
			message:
				`No daily note for ${stem} yet, and this is not the command that makes one. ` +
				// The palette name, exactly: Obsidian prefixes the plugin's name, so
				// the command `src/main.ts` registers as `draft-today` / "Draft
				// today" is listed as "Mise Assistant: Draft today". Telling the user
				// to run something the palette cannot find is worse than saying
				// nothing, and nothing else in the tree spells it any other way.
				'Run "Mise Assistant: Draft today" first, then save again.',
		};
	}
	return { kind: "append", path: existingPath };
}
