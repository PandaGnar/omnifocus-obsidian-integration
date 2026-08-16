// Which notes were actually in the prompt, derived from the pack rather than
// from the model's answer.
//
// This is the auditability feature, and the direction of the derivation is the
// whole point of it. A footer built from what the model *says* it used is a
// second generation to disbelieve; a footer built from `pack.sections` is a
// record of what was on the wire. If a document is listed here it was sent, and
// if it was sent it is listed here — `sources.test.ts` asserts both halves
// against the pack, so a section that stops appearing in the footer fails the
// suite rather than quietly making an answer unverifiable.
//
// Nothing here imports `obsidian`: the view turns these records into anchors,
// but deciding *what* the footer contains is pure.

import type { ContextPack, PackSection, SectionKind } from "../context/types";

export interface ChatSource {
	/** The pack section this came from, e.g. `goal:quarter`. */
	readonly id: string;
	/** Vault path, exactly as `openLinkText` wants it. */
	readonly path: string;
	/** Human label, e.g. `Quarter goals - 26 Q3 Goals`. */
	readonly title: string;
	readonly kind: SectionKind;
	/** True when the per-document cap cut this note short. */
	readonly truncated: boolean;
	/**
	 * The resolver's own admission that this is not the document that was asked
	 * for — "no `26 W32 Goals` note exists; `26 W31 Goals` is the most recent
	 * doc at this horizon". Null when the pack got the document it wanted.
	 *
	 * Taken verbatim from `PackSection.note`, which is the same string the pack
	 * puts in front of the model in its `gaps` section. That shared origin is
	 * the point: whatever the model was told about a substituted document is, by
	 * construction, what the footer tells the user. Re-deriving the sentence
	 * here, or parsing it back out of the rendered prompt, would let the two
	 * drift apart — and it cannot be parsed back out in any case, because the
	 * admission deliberately does not sit beside the document. Naming a period
	 * that does not exist is date-derived text, and date-derived text in the
	 * stable block costs a prefill of the whole cached prefix every time the
	 * calendar turns over.
	 */
	readonly note: string | null;
}

/**
 * Every note in the pack, in the order the model read them.
 *
 * De-duplicated by path, first occurrence winning, because a document listed
 * twice reads as two pieces of evidence when it is one. Wire order rather than
 * alphabetical: the footer then doubles as a picture of the prompt, longest
 * horizon at the top.
 */
export function deriveSources(pack: ContextPack): readonly ChatSource[] {
	const seen = new Set<string>();
	const sources: ChatSource[] = [];
	for (const section of pack.sections) {
		const path = section.path;
		if (path === null || path === "") continue;
		if (seen.has(path)) continue;
		seen.add(path);
		sources.push(toSource(section, path));
	}
	return sources;
}

function toSource(section: PackSection, path: string): ChatSource {
	return {
		id: section.id,
		path,
		title: section.title,
		kind: section.kind,
		truncated: section.truncated,
		note: section.note,
	};
}

/** `26 Q3 Goals` — the wikilink target and the visible label for a path. */
export function sourceLinkText(path: string): string {
	const withoutFolder = path.slice(path.lastIndexOf("/") + 1);
	return withoutFolder.endsWith(".md") ? withoutFolder.slice(0, -3) : withoutFolder;
}

/** What the footer says about one source beyond its name. */
export function sourceAnnotation(source: ChatSource): string | null {
	const parts: string[] = [];
	if (source.note !== null) parts.push(source.note);
	if (source.truncated) parts.push("truncated to fit the per-document cap");
	return parts.length === 0 ? null : parts.join("; ");
}

/**
 * The footer as markdown, for `save to note`. Wikilinks rather than the raw
 * path so the saved exchange is navigable from inside the daily note too.
 */
export function renderSourcesMarkdown(sources: readonly ChatSource[]): string {
	if (sources.length === 0) {
		return "Sources: none — no vault documents made it into this prompt.";
	}
	const lines = ["Sources:"];
	for (const source of sources) {
		const annotation = sourceAnnotation(source);
		const suffix = annotation === null ? "" : ` — ${annotation}`;
		lines.push(`- [[${stripExtension(source.path)}|${source.title}]]${suffix}`);
	}
	return lines.join("\n");
}

function stripExtension(path: string): string {
	return path.endsWith(".md") ? path.slice(0, -3) : path;
}
