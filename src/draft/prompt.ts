// What the model is asked for, and how its reply is read back.
//
// The instruction goes into the context pack's *question* slot, which is the
// last thing in the prompt. That is not an aesthetic choice: the pack's whole
// prefix — system prompt, standing docs, goal docs, recent dailies — is
// byte-identical to the one the chat view sends, so drafting a note reuses
// whatever KV cache the chat has already warmed and vice versa. Putting the
// template outline anywhere higher would fork the prefix into two lineages and
// cost a cold prefill every time the user switched between the two features.
//
// The instruction quotes the template's heading lines verbatim rather than
// describing them, so the reply can be matched back to the template by heading
// instead of by position — a model that skips a section then stays in step.
//
// Nothing in this file imports `obsidian`.

import type { ChatSignal } from "../chat/signals";
import type { FilledSection, TemplateHeading } from "./template";
import { parseNote, trimBlankEdges } from "./sections";

/**
 * The question slot for a draft.
 *
 * Deliberately free of the date: the pack already puts "Today is ..." in the
 * section immediately above this one, and repeating it here would be a second
 * daily-changing string to no benefit.
 *
 * Only the template's fillable headings are quoted. The note's title is a
 * heading the template parser found, but it names the day rather than asking a
 * question, and a model that dutifully writes a paragraph under it produces a
 * note unlike every hand-made one in the vault.
 */
export function buildDraftInstruction(allHeadings: readonly TemplateHeading[]): string {
	const headings = allHeadings.filter((heading) => heading.fillable);
	return [
		"Draft my daily note for the date above.",
		"",
		"Reply with exactly the following headings, in this order, copied character",
		"for character. Write the content for each section underneath its own",
		"heading and nowhere else. Do not add headings, do not remove headings, do",
		"not write anything before the first heading or after the last section, and",
		"do not wrap the reply in a code fence.",
		"",
		...headings.map((heading) => heading.headingLine),
		"",
		"Ground every line in the planning documents above: the week's goals decide",
		"what today is for, the recent daily notes say what is already in flight.",
		"Keep the user's own list style — if a section is a checklist in their",
		"notes, write a checklist. Be specific and brief; three good lines beat ten",
		"vague ones.",
		"",
		"Leave a section empty rather than filling it with something the documents",
		"do not support. An empty section is honest and the user can finish it; an",
		"invented commitment is not, and they may not notice it is invented.",
	].join("\n");
}

/** What the reply turned out to contain, measured against the template. */
export interface DraftReply {
	/** Sections the model filled, matched to template headings. */
	readonly filled: readonly FilledSection[];
	/** Template headings the model left empty or omitted, in template order. */
	readonly unfilledHeadings: readonly string[];
	/** Headings the model invented, which are dropped. */
	readonly strayHeadings: readonly string[];
	/** True when the model wrote prose before its first heading, also dropped. */
	readonly hadPreamble: boolean;
}

/**
 * Strip a code fence wrapping the entire reply.
 *
 * Models fence markdown roughly one time in five, and an unstripped fence turns
 * the whole reply into a single body with no headings in it — which reads
 * downstream as "the model filled nothing" and produces a note of pure
 * scaffolding. Only a fence that opens on the first line and closes on the last
 * is removed; a fenced snippet *inside* a section is content and stays.
 */
export function stripEnclosingFence(reply: string): string {
	const lines = reply.trim().split("\n");
	const first = lines[0] ?? "";
	if (!/^\s*(```|~~~)/.test(first)) return reply;
	const marker = first.trim().startsWith("~~~") ? "~~~" : "```";
	const last = lines[lines.length - 1] ?? "";
	if (lines.length < 2 || !last.trim().startsWith(marker)) return reply;
	return lines.slice(1, -1).join("\n");
}

/**
 * Read a reply back into per-heading bodies.
 *
 * Matching is by normalised heading rather than by order, and unknown headings
 * are dropped rather than appended. Dropping is the conservative direction: a
 * heading the template does not have is either a hallucination or a section the
 * user deleted on purpose, and adding it would make the note structurally
 * unlike the 800 that came before it — which is the one thing this feature is
 * for. It is reported rather than swallowed.
 *
 * A body under a heading the template has but did not ask for — the note's
 * title — is dropped quietly rather than reported: the model was not asked for
 * it, so it is neither a stray heading the user should hear about nor a section
 * that can be left unfilled.
 */
export function parseDraftReply(
	reply: string,
	headings: readonly TemplateHeading[],
): DraftReply {
	const parsed = parseNote(stripEnclosingFence(reply));
	const known = new Set(headings.map((heading) => heading.key));
	const fillable = new Set(
		headings.filter((heading) => heading.fillable).map((heading) => heading.key),
	);

	const filled: FilledSection[] = [];
	const strayHeadings: string[] = [];
	const seen = new Set<string>();

	for (const section of parsed.sections) {
		if (!known.has(section.key)) {
			strayHeadings.push(section.heading);
			continue;
		}
		if (!fillable.has(section.key)) continue;
		// A model that repeats a heading gets its first answer taken; the second
		// is usually the start of a repetition loop.
		if (seen.has(section.key)) continue;
		seen.add(section.key);
		const body = trimBlankEdges(section.bodyLines);
		if (body.length === 0) continue;
		filled.push({ key: section.key, bodyLines: body });
	}

	const filledKeys = new Set(filled.map((entry) => entry.key));
	return {
		filled,
		unfilledHeadings: headings
			.filter((heading) => heading.fillable && !filledKeys.has(heading.key))
			.map((heading) => heading.heading),
		strayHeadings,
		hadPreamble: parsed.preambleLines.some((line) => line.trim() !== ""),
	};
}

/**
 * What the user has to be told about the reply itself.
 *
 * The empty-reply case is a warning and the rest are information: a note whose
 * sections are all scaffolding is a failure dressed as a success, whereas a
 * couple of unfilled sections is the model doing as it was told when the
 * documents had nothing to say.
 */
export function draftReplySignals(reply: DraftReply, total: number): readonly ChatSignal[] {
	const signals: ChatSignal[] = [];

	if (reply.filled.length === 0) {
		signals.push({
			code: "draft-empty",
			level: "warning",
			text:
				"The model filled none of the template's sections. The draft below is the " +
				"bare template; there is nothing to accept.",
		});
	} else if (reply.unfilledHeadings.length > 0) {
		signals.push({
			code: "draft-unfilled",
			level: "info",
			text: `${reply.unfilledHeadings.length} of ${total} sections were left as the template wrote them: ${reply.unfilledHeadings.join(", ")}.`,
		});
	}

	if (reply.strayHeadings.length > 0) {
		signals.push({
			code: "draft-stray-headings",
			level: "info",
			text: `Ignored ${reply.strayHeadings.length} heading(s) the model invented, which the template does not have: ${reply.strayHeadings.join(", ")}.`,
		});
	}

	if (reply.hadPreamble) {
		signals.push({
			code: "draft-preamble",
			level: "info",
			text: "The model wrote text before its first heading. It was dropped, since it belongs to no section.",
		});
	}

	return signals;
}
