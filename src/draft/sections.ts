// Markdown notes as a list of headed sections, and the one judgement that the
// whole "never clobber" rule rests on: whether a section is empty.
//
// Two properties are load-bearing and are asserted in `sections.test.ts`:
//
//   1. **Round trip is exact.** `renderNote(parseNote(x)) === x` for every
//      string, byte for byte, including trailing newlines and Windows line
//      endings. Everything downstream compares the merged note against the note
//      on disk to decide whether a write is needed, so a parser that
//      "normalises" whitespace would report a diff on a note nothing touched —
//      and the second run of `draft today` would stop being a no-op. Lines are
//      therefore kept verbatim and only ever moved, never rewritten.
//
//   2. **Emptiness is about content, not about characters.** A template section
//      that reads `- [ ] ` is empty: it is scaffolding, and filling it is the
//      point of the feature. A section that reads `- [ ] Cutover rehearsal` is
//      the user's, and nothing here may touch it. So a line counts as content
//      only once its list bullet, checkbox, blockquote marker and horizontal
//      rules have been stripped and something is left.
//
// Nothing in this file imports `obsidian`.

/** A heading and the lines beneath it, up to the next heading of any level. */
export interface NoteSection {
	/** 1 for `#`, 6 for `######`. */
	readonly level: number;
	/** Heading text as written, e.g. `Today`. */
	readonly heading: string;
	/** Normalised heading, for matching one note's sections against another's. */
	readonly key: string;
	/** The heading line verbatim, so rendering can put it back unchanged. */
	readonly headingLine: string;
	/** Everything below the heading, verbatim, one entry per line. */
	readonly bodyLines: readonly string[];
}

export interface ParsedNote {
	/** Lines before the first heading: frontmatter, a title, a stray sentence. */
	readonly preambleLines: readonly string[];
	readonly sections: readonly NoteSection[];
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Normalised heading text, used to decide that the template's `## Today` and
 * the model's `## today:` are the same section.
 *
 * Deliberately forgiving about the things a model varies (case, trailing
 * colons, surrounding emphasis, doubled spaces) and deliberately strict about
 * the things a user varies on purpose: `## Today` and `## Tomorrow` never
 * collide, because nothing here removes whole words.
 */
export function headingKey(heading: string): string {
	return heading
		.trim()
		.replace(/^[*_]+|[*_]+$/g, "")
		.replace(/[:.\s]+$/, "")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

/**
 * Split a note into its headed sections.
 *
 * Fenced code blocks are tracked so that a `# comment` inside one is not read
 * as a heading. Daily notes hold shell snippets often enough for that to
 * matter, and a phantom heading would invent a section the merge could then
 * "fill".
 */
export function parseNote(text: string): ParsedNote {
	const lines = text.split("\n");
	const preambleLines: string[] = [];
	const sections: NoteSection[] = [];

	let current: { level: number; heading: string; headingLine: string; body: string[] } | null =
		null;
	let fence: string | null = null;

	const flush = (): void => {
		if (current === null) return;
		sections.push({
			level: current.level,
			heading: current.heading,
			key: headingKey(current.heading),
			headingLine: current.headingLine,
			bodyLines: current.body,
		});
		current = null;
	};

	for (const line of lines) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch !== null) {
			const marker = fenceMatch[1] as string;
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
		}

		const heading = fence === null ? HEADING.exec(line) : null;
		if (heading !== null) {
			flush();
			current = {
				level: (heading[1] as string).length,
				// `\r` on a CRLF file, and any `###` closing sequence, are display
				// noise rather than part of the name.
				heading: (heading[2] as string).replace(/\s*#*\s*$/, ""),
				headingLine: line,
				body: [],
			};
			continue;
		}

		if (current === null) preambleLines.push(line);
		else current.body.push(line);
	}
	flush();

	return { preambleLines, sections };
}

/** Exactly the text `parseNote` was given. Asserted byte-for-byte in tests. */
export function renderNote(note: ParsedNote): string {
	const lines: string[] = [...note.preambleLines];
	for (const section of note.sections) {
		lines.push(section.headingLine, ...section.bodyLines);
	}
	return lines.join("\n");
}

const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * What a line says once its markdown scaffolding is removed. `- [ ] ` and `> `
 * and `1. ` are structure the template supplies; anything left over is the
 * user's.
 */
export function lineContent(line: string): string {
	if (HORIZONTAL_RULE.test(line)) return "";
	let rest = line.trim();
	if (rest === "") return "";
	// Blockquote markers can nest, and a list can sit inside one.
	rest = rest.replace(/^(?:>\s*)+/, "");
	rest = rest.replace(/^(?:[-*+]|\d+[.)])\s*/, "");
	rest = rest.replace(/^\[[^\]]?\]\s*/, "");
	return rest.trim();
}

/** True when a section body is scaffolding and nothing else. */
export function isEmptyBody(bodyLines: readonly string[]): boolean {
	return bodyLines.every((line) => lineContent(line) === "");
}

/**
 * Section keys in document order, for the "did the structure survive" checks.
 * A hand-made note and a drafted one must produce the same list.
 */
export function headingOutline(text: string): readonly string[] {
	return parseNote(text).sections.map((section) => `${"#".repeat(section.level)} ${section.key}`);
}

/** First section with this key, or null. First wins, so a repeated heading is stable. */
export function findSection(note: ParsedNote, key: string): NoteSection | null {
	return note.sections.find((section) => section.key === key) ?? null;
}

/**
 * Body lines with leading and trailing blank lines removed.
 *
 * Used when moving a body from one note into another, so that the spacing of
 * the destination is set by the destination rather than by however many blank
 * lines the model happened to emit.
 */
export function trimBlankEdges(lines: readonly string[]): readonly string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] as string).trim() === "") start += 1;
	while (end > start && (lines[end - 1] as string).trim() === "") end -= 1;
	return lines.slice(start, end);
}
