// What, if anything, gets written — decided before a single byte reaches the
// vault, and decided here rather than in the modal so that it can be tested.
//
// Three rules, in the order they bind:
//
//   1. **Never a second note for a date.** The vault already contains
//      `26.07.02 1.md`, `25.01.29 1.md` and `25.05.10 1.md`, which are
//      Obsidian's collision suffixes and are the fossil record of exactly this
//      mistake being made by hand. If `resolveDailyNote` finds a note for the
//      day, that note is the note; the draft is merged into it or nothing
//      happens. `newDailyNotePath` is consulted only when there is none.
//
//   2. **Never overwrite content.** A section the user has written in is
//      returned byte for byte. Only sections whose bodies are template
//      scaffolding — `- [ ] ` and friends, see `isEmptyBody` — are filled, and
//      only from the draft's corresponding section.
//
//   3. **Running it twice is a no-op.** Rule 2 gets most of the way there: on
//      the second run every section the first run filled is non-empty and is
//      therefore untouchable. The rest comes from comparing the merged text
//      against the text on disk and reporting `noop` when they are equal, which
//      also covers the sections the model left empty both times. `plan.test.ts`
//      drives the whole loop twice against a fixed model and asserts the second
//      run writes nothing.
//
// Nothing in this file imports `obsidian`.

import type { ChatSignal } from "../chat/signals";
import type { CalendarDate } from "../vault/dates";
import { type DailyNote, newDailyNotePath } from "../vault/resolver";
import { type DiffLine, diffLines } from "./diff";
import {
	type NoteSection,
	type ParsedNote,
	findSection,
	isEmptyBody,
	parseNote,
	renderNote,
	trimBlankEdges,
} from "./sections";
import { frameBlankLines } from "./template";

export type DraftAction =
	/** The day has no note. The draft is written as a new file. */
	| "create"
	/** The day has a note. Empty sections are filled; nothing else moves. */
	| "fill"
	/** The note already says what the draft says. Nothing is written. */
	| "noop";

export interface DraftWritePlan {
	readonly action: DraftAction;
	/** The file that would be written. Never a new path when one already exists. */
	readonly path: string;
	/** The note as it is now; `""` when it does not exist yet. */
	readonly before: string;
	/** The note as it would be. Equal to `before` when the action is `noop`. */
	readonly after: string;
	/** Headings whose empty bodies the draft filled. */
	readonly filledHeadings: readonly string[];
	/** Headings the note already had content under, left untouched. */
	readonly preservedHeadings: readonly string[];
	/** Template headings the note did not have, appended at the end. */
	readonly appendedHeadings: readonly string[];
	/** Other files claiming this date, from `DailyNote.duplicates`. */
	readonly duplicates: readonly string[];
}

export interface DraftPlanRequest {
	readonly date: CalendarDate;
	/** The resolver's answer for this date, and the text of the note it found. */
	readonly existing: { readonly note: DailyNote; readonly text: string } | null;
	/** The note the draft would like to write, composed from the template. */
	readonly draft: string;
}

/**
 * Decide the write.
 *
 * `existing` carries the resolver's `DailyNote` rather than a bare path so that
 * its `duplicates` reach the plan: a day with a collision suffix is a day where
 * the user has two notes and the plugin is about to edit one of them, and that
 * is worth saying before the write rather than after it.
 */
export function planDailyDraft(request: DraftPlanRequest): DraftWritePlan {
	if (request.existing === null) {
		return {
			action: "create",
			path: newDailyNotePath(request.date),
			before: "",
			after: request.draft,
			filledHeadings: parseNote(request.draft)
				.sections.filter((section) => !isEmptyBody(section.bodyLines))
				.map((section) => section.heading),
			preservedHeadings: [],
			appendedHeadings: [],
			duplicates: [],
		};
	}

	const { note, text } = request.existing;
	const merge = fillEmptySections(text, request.draft);
	return {
		// String equality rather than "did we change any section": a merge that
		// re-renders to the same bytes is not a write, whatever it did on the way.
		action: merge.text === text ? "noop" : "fill",
		path: note.path,
		before: text,
		after: merge.text,
		filledHeadings: merge.filled,
		preservedHeadings: merge.preserved,
		appendedHeadings: merge.appended,
		duplicates: note.duplicates,
	};
}

export interface MergeOutcome {
	readonly text: string;
	readonly filled: readonly string[];
	readonly preserved: readonly string[];
	readonly appended: readonly string[];
}

/**
 * Fill the empty sections of `existing` from `draft`, and nothing else.
 *
 * Sections the draft has and the note does not are appended at the end rather
 * than dropped. That is not clobbering — nothing existing moves — and without
 * it a note created by the chat view's "save to daily note" (a title and a
 * transcript, no template headings at all) could never be drafted into, because
 * it has no empty sections to fill. They are reported separately from the
 * filled ones so the diff preview can say which is which.
 */
export function fillEmptySections(existing: string, draft: string): MergeOutcome {
	const note = parseNote(existing);
	const proposed = parseNote(draft);

	const filled: string[] = [];
	const preserved: string[] = [];
	const usedKeys = new Set<string>();

	const sections: NoteSection[] = note.sections.map((section) => {
		usedKeys.add(section.key);
		const source = findSection(proposed, section.key);
		if (!isEmptyBody(section.bodyLines)) {
			preserved.push(section.heading);
			return section;
		}
		if (source === null) return section;
		const body = trimBlankEdges(source.bodyLines);
		if (body.length === 0) return section;
		const spacing = frameBlankLines(section.bodyLines);
		filled.push(section.heading);
		return { ...section, bodyLines: [...spacing.before, ...body, ...spacing.after] };
	});

	const kept: ParsedNote = { preambleLines: note.preambleLines, sections };
	const missing = proposed.sections.filter((section) => !usedKeys.has(section.key));
	const filledText = renderNote(kept);

	// Re-rendering the two halves separately would butt the appended headings
	// against whatever the note ended with, so the seam is normalised to one
	// blank line. That is the only place this function touches bytes it did not
	// add, and it only ever touches trailing blank lines.
	const text =
		missing.length === 0
			? filledText
			: `${filledText.replace(/\n+$/, "")}\n\n${renderNote({
					preambleLines: [],
					sections: missing,
				})}`;

	return {
		text,
		filled,
		preserved,
		appended: missing.map((section) => section.heading),
	};
}

/** The diff the preview shows, and the same comparison the write path makes. */
export function planDiff(plan: DraftWritePlan): readonly DiffLine[] {
	return diffLines(plan.before, plan.after);
}

/**
 * What the user is told about the write before they confirm it.
 *
 * The duplicate warning is the only one at `warning` level. The rest describe
 * an outcome the user asked for; a second file claiming the same date means the
 * note being edited may not be the one they have open, which they have to know
 * before they press the button rather than after.
 */
export function planSignals(plan: DraftWritePlan): readonly ChatSignal[] {
	const signals: ChatSignal[] = [];

	for (const duplicate of plan.duplicates) {
		signals.push({
			code: "draft-duplicate-note",
			level: "warning",
			text: `This date has more than one note. Writing to ${plan.path} and leaving ${duplicate} alone.`,
		});
	}

	if (plan.action === "noop") {
		signals.push({
			code: "draft-noop",
			level: "info",
			text: `${plan.path} already contains this draft. Nothing to write.`,
		});
		return signals;
	}

	if (plan.action === "create") {
		signals.push({
			code: "draft-create",
			level: "info",
			text: `${plan.path} does not exist yet; the draft would create it.`,
		});
		return signals;
	}

	signals.push({
		code: "draft-fill",
		level: "info",
		text:
			`${plan.path} already exists. Only its empty sections would be filled` +
			(plan.preservedHeadings.length === 0
				? "."
				: `; ${plan.preservedHeadings.length} section(s) you have already written in are left exactly as they are: ${plan.preservedHeadings.join(", ")}.`),
	});

	if (plan.appendedHeadings.length > 0) {
		signals.push({
			code: "draft-appended",
			level: "info",
			text: `The note is missing ${plan.appendedHeadings.length} of the template's sections, which would be appended at the end: ${plan.appendedHeadings.join(", ")}.`,
		});
	}

	return signals;
}

/**
 * Re-check at the moment of writing.
 *
 * The preview is built from the note as it was when the command ran, and the
 * user may have typed into it while reading the diff — Obsidian is a text
 * editor and the note is very likely open. Writing `after` then would silently
 * discard whatever they typed, which is the one outcome this whole feature is
 * built to avoid. So the write is refused and the user re-runs the command.
 */
export function confirmWrite(
	plan: DraftWritePlan,
	currentText: string | null,
	edited: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
	const current = currentText ?? "";
	if (current !== plan.before) {
		return {
			ok: false,
			reason:
				`${plan.path} changed while the preview was open, so the draft was not ` +
				"written. Run the command again to draft against the current note.",
		};
	}
	if (edited === plan.before) {
		return { ok: false, reason: `Nothing to write: ${plan.path} already says this.` };
	}
	return { ok: true, text: edited };
}
