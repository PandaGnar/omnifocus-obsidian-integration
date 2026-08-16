// Path predicates for the vault. Deliberately free of any `obsidian` import:
// everything here operates on vault-relative POSIX paths (`Long Term/26 W33
// Goals.md`), which is exactly what `TFile.path` already is.

/** Folder holding the daily "Mise" notes, flat or in `YY.MM/` buckets. */
export const DAILY_NOTES_ROOT = "Mise";

/**
 * Directory name that marks a subtree as history. It appears at several depths
 * — `Notes/Archive/`, `Long Term/Archive/2025/25.12/` — so it is matched as a
 * path segment rather than a prefix.
 */
const ARCHIVE_SEGMENT = "archive";

/** Directories that never hold notes worth resolving or feeding to a model. */
const EXCLUDED_SEGMENTS = new Set(["zassets"]);

export interface ExclusionOptions {
	/**
	 * Include `*​/Archive/` subtrees. Off by default; callers that genuinely
	 * want history (a "what did I write last year" flow) opt in explicitly.
	 */
	readonly includeArchives?: boolean;
}

/** Path segments, with any leading/trailing slashes and `./` noise dropped. */
export function segments(path: string): string[] {
	return path.split("/").filter((s) => s.length > 0 && s !== ".");
}

/** Final path segment, including the extension. */
export function basename(path: string): string {
	const parts = segments(path);
	return parts.length === 0 ? "" : (parts[parts.length - 1] as string);
}

/** Final path segment with a single trailing extension removed. */
export function stem(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? name : name.slice(0, dot);
}

/** Number of folders above the file. `a.md` is 0, `Mise/a.md` is 1. */
export function depth(path: string): number {
	return Math.max(segments(path).length - 1, 0);
}

export function isMarkdown(path: string): boolean {
	return basename(path).toLowerCase().endsWith(".md");
}

/**
 * Templates share the shape of real notes (`xx Wxx Goals.md` next to
 * `26 W33 Goals.md`), so they are identified by the `xx` basename prefix rather
 * than by folder. That is the rule `vault-conventions.md` states, and it also
 * catches the unspaced `xxY+ Goals.md`, which no "loose" filename regex would.
 *
 * The cost is that a real note literally beginning "xx" would be skipped. No
 * such note exists in the vault, and a false negative here is cheap (one doc
 * missing from context) where a false positive is not (empty scaffolding fed to
 * the model as if it were the user's plan).
 */
export function isTemplatePath(path: string): boolean {
	return stem(path).toLowerCase().startsWith("xx");
}

/** True when any folder in the path is an `Archive` directory. */
export function isArchivedPath(path: string): boolean {
	const parts = segments(path);
	// The last segment is the filename; a file called `Archive.md` is a note.
	return parts
		.slice(0, -1)
		.some((s) => s.toLowerCase() === ARCHIVE_SEGMENT);
}

/**
 * Junk that must never be resolved to or stuffed into a prompt: attachments,
 * Obsidian's own scaffolding, and — by default — archived history.
 */
export function isExcludedPath(
	path: string,
	options: ExclusionOptions = {},
): boolean {
	const parts = segments(path);
	if (parts.length === 0) return true;

	// `.obsidian/`, `.trash/` and friends are plugin/app state, never notes.
	if (parts.some((s) => s.startsWith("."))) return true;
	if (parts.slice(0, -1).some((s) => EXCLUDED_SEGMENTS.has(s.toLowerCase()))) {
		return true;
	}
	if (!options.includeArchives && isArchivedPath(path)) return true;
	if (isTemplatePath(path)) return true;

	const name = basename(path);
	const lower = name.toLowerCase();
	if (lower.startsWith("pasted image ")) return true;
	if (lower.startsWith("untitled")) return true;
	if (lower === "welcome.md") return true;

	return false;
}

/**
 * Obsidian's collision suffix: saving a second `26.07.02.md` produces
 * `26.07.02 1.md`. Returns the suffix number and the base stem it collided
 * with, or `null` when the stem carries no suffix.
 */
export function splitCollisionSuffix(fileStem: string): {
	base: string;
	suffix: number | null;
} {
	const match = /^(.*\S)\s+(\d+)$/.exec(fileStem);
	if (match === null) return { base: fileStem, suffix: null };
	return { base: match[1] as string, suffix: Number(match[2]) };
}
