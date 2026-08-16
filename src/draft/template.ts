// The daily-note template, read at runtime and never copied into the source.
//
// This module exists to hold one rule: the shape of a drafted note comes from
// `Mise/xx.xx.xx Mise.md` as it is on disk, today, and from nowhere else. A
// hardcoded list of headings would be correct exactly until the user edits
// their own template, after which every note the plugin writes would be subtly
// unlike the ~800 they wrote by hand — and nothing would say so. So the outline
// is parsed, the headings are quoted back to the model verbatim, and the
// composed note reuses the template's own heading lines rather than
// regenerating them.
//
// Nothing in this file imports `obsidian`.

import { TEMPLATE_DATE_PLACEHOLDER } from "../vault/paths";
import {
	type ParsedNote,
	isEmptyBody,
	parseNote,
	renderNote,
	trimBlankEdges,
} from "./sections";

/** A heading of the template, in template order. */
export interface TemplateHeading {
	readonly level: number;
	readonly heading: string;
	readonly key: string;
	/** The heading line as the template writes it, hashes included. */
	readonly headingLine: string;
	/** True when the template ships this section with scaffolding only. */
	readonly placeholder: boolean;
	/**
	 * True when the model is asked to write a body under this heading.
	 *
	 * False for the note's title line — see `TITLE_LEVEL`. The heading is still
	 * part of the template and `composeFromTemplate` still renders it; it is only
	 * kept out of the ask and out of the "left as the template wrote it" count.
	 */
	readonly fillable: boolean;
}

export interface DailyTemplate {
	/** The template with its date placeholder resolved. */
	readonly text: string;
	readonly parsed: ParsedNote;
	/** Every heading, in template order, title included. */
	readonly headings: readonly TemplateHeading[];
	/** The subset the model is asked to write under. */
	readonly fillable: readonly TemplateHeading[];
}

/** Raised when the template is missing or has no headings to fill. */
export class TemplateUnusableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateUnusableError";
	}
}

/**
 * The heading level a daily note's title sits at.
 *
 * A `#` heading in a note whose other headings are deeper is the note's name,
 * not a section: no hand-made note in the vault has prose between the title and
 * the first `##`, so asking the model to write some produces a note that is
 * visibly not template-shaped — and one `headingOutline` cannot see, because it
 * compares headings and not bodies. It would also be reported as unfilled on
 * every clean run, naming the date as a section the model failed to write.
 *
 * The rule is about level rather than about the title's text, so it survives a
 * user who renames their title; it is derived from the template rather than
 * hardcoded, so a template that uses `#` for its real sections keeps them all.
 */
const TITLE_LEVEL = 1;

/**
 * Resolve the template for one day.
 *
 * `xx.xx.xx` is replaced everywhere it appears, not only in the title: the
 * placeholder is the vault's own convention for "the date of this note", and a
 * template that repeats it in a heading means it there too.
 */
export function instantiateTemplate(templateText: string, stem: string): DailyTemplate {
	const text = templateText.split(TEMPLATE_DATE_PLACEHOLDER).join(stem);
	const parsed = parseNote(text);
	if (parsed.sections.length === 0) {
		throw new TemplateUnusableError(
			"The daily-note template has no headings, so there is nothing to fill. " +
				"Add the usual sections to it, or draft the note by hand.",
		);
	}
	// A template written entirely at level 1 has no deeper section for its title
	// to sit above, so every one of its headings is a section.
	const titled = parsed.sections.some((section) => section.level > TITLE_LEVEL);
	const headings = parsed.sections.map((section) => ({
		level: section.level,
		heading: section.heading,
		key: section.key,
		headingLine: section.headingLine,
		placeholder: isEmptyBody(section.bodyLines),
		fillable: !titled || section.level > TITLE_LEVEL,
	}));
	return {
		text,
		parsed,
		headings,
		fillable: headings.filter((heading) => heading.fillable),
	};
}

/**
 * Build a note from the template, taking each section's body from `filled`
 * when it has one and leaving the template's own scaffolding when it does not.
 *
 * The heading lines, their order, their levels and the preamble all come from
 * the template unchanged, which is what makes a drafted note structurally
 * indistinguishable from a hand-made one. Only bodies are ever substituted.
 */
export function composeFromTemplate(
	template: DailyTemplate,
	filled: readonly FilledSection[],
): string {
	const sections = template.parsed.sections.map((section) => {
		const match = filled.find((entry) => entry.key === section.key);
		if (match === undefined || match.bodyLines.length === 0) return section;
		// The template decides the spacing around a body; the model only decides
		// what the body says.
		const spacing = frameBlankLines(section.bodyLines);
		return {
			...section,
			bodyLines: [...spacing.before, ...match.bodyLines, ...spacing.after],
		};
	});
	return renderNote({ preambleLines: template.parsed.preambleLines, sections });
}

/** One section's replacement body, already trimmed of blank edges. */
export interface FilledSection {
	readonly key: string;
	readonly bodyLines: readonly string[];
}

/**
 * The blank lines the template puts either side of a section body, so a filled
 * section sits in the note exactly where the empty one did.
 *
 * A wholly blank body — `## Intention` with nothing under it — says how much
 * room the template leaves before the next heading, but not whether a body sits
 * against the heading or a line below it. Those blanks are therefore kept
 * verbatim as the gap *after* the body, and one blank line is added before it,
 * which is how every filled section in a hand-made note is written:
 *
 *     ## Intention
 *                        <- the added line
 *     Get the rehearsal done and stop thinking about it.
 *                        <- the template's own blank
 *     ## Today
 *
 * Without that leading blank a drafted note butts its prose against the heading
 * and is not byte-identical to the hand-made note it is imitating, which the
 * heading-only outline comparison cannot see. A section whose scaffolding is a
 * bullet (`## Today` over `- [ ] `) says the body starts on the next line, and
 * that is honoured instead — the template decides, not this function.
 */
export function frameBlankLines(bodyLines: readonly string[]): {
	readonly before: readonly string[];
	readonly after: readonly string[];
} {
	const kept = trimBlankEdges(bodyLines);
	if (kept.length === 0) {
		return bodyLines.length === 0 ? { before: [], after: [] } : { before: [""], after: bodyLines };
	}
	let lead = 0;
	while ((bodyLines[lead] as string).trim() === "") lead += 1;
	let trail = 0;
	while ((bodyLines[bodyLines.length - 1 - trail] as string).trim() === "") trail += 1;
	return {
		before: bodyLines.slice(0, lead),
		after: bodyLines.slice(bodyLines.length - trail),
	};
}
