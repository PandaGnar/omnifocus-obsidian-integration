// Pure note resolution over an injected file list. Nothing here imports
// `obsidian`; the adapter is one line in the plugin:
//
//     createVaultIndex(this.app.vault.getMarkdownFiles().map((f) => f.path))
//
// The seam is a plain `readonly string[]` of vault-relative paths rather than
// an interface with methods. A method-bearing interface would have to be
// re-implemented by the Obsidian adapter *and* stubbed in every test, to buy
// laziness we do not need — the whole vault is 822 paths, and the index below
// is built once per command. `VaultIndex` is a derived structure, not a second
// injection point: callers hand over strings and get one back.

import {
	type CalendarDate,
	dailyNoteStem,
	dateOrdinal,
	expandShortYear,
	isoWeek,
	pad2,
	quarterOf,
	shortYear,
} from "./dates";
import {
	DAILY_NOTES_ROOT,
	type ExclusionOptions,
	depth,
	isExcludedPath,
	isMarkdown,
	segments,
	splitCollisionSuffix,
	stem,
} from "./paths";

export type GoalHorizon = "week" | "month" | "quarter" | "yearPlus";

/** Every horizon, ordered most stable first — the order PR 4's pack wants. */
export const GOAL_HORIZONS: readonly GoalHorizon[] = [
	"yearPlus",
	"quarter",
	"month",
	"week",
];

interface IndexedFile {
	readonly path: string;
	/** Obsidian collision suffix, e.g. 1 for `26.07.02 1.md`. */
	readonly suffix: number | null;
}

interface DailyNoteEntry extends IndexedFile {
	readonly date: CalendarDate;
	readonly ordinal: number;
	/** True when the note lives under `Mise/`, flat or in a `YY.MM/` bucket. */
	readonly inDailyRoot: boolean;
}

interface GoalDocEntry extends IndexedFile {
	/** Sortable period key; comparable only within one horizon. */
	readonly key: number;
	/** Filename stem without any collision suffix, e.g. `26 W33 Goals`. */
	readonly label: string;
}

export interface VaultIndex {
	/** The non-excluded markdown paths this index was built from, sorted. */
	readonly paths: readonly string[];
	readonly options: ExclusionOptions;
	readonly dailyNotes: readonly DailyNoteEntry[];
	readonly goalDocs: Readonly<Record<GoalHorizon, readonly GoalDocEntry[]>>;
}

export interface DailyNote {
	readonly date: CalendarDate;
	readonly path: string;
	/**
	 * Other files claiming the same date — Obsidian collision suffixes such as
	 * `26.07.02 1.md`, and any copy misfiled into a second `YY.MM/` bucket.
	 * Never merged into `path`; a caller that wants to warn can, one that does
	 * not can ignore the field.
	 */
	readonly duplicates: readonly string[];
}

export interface GoalDocResolution {
	readonly horizon: GoalHorizon;
	/** The doc we asked for, e.g. `26 W32 Goals` — may not exist. */
	readonly requestedLabel: string;
	/** The doc actually settled on, or `null` when the vault has none. */
	readonly path: string | null;
	/** Label of the settled doc, so the UI can name it without re-parsing. */
	readonly label: string | null;
	/** False when `path` is a fallback rather than the requested period. */
	readonly exact: boolean;
	/** Collision-suffixed siblings of the settled doc. */
	readonly duplicates: readonly string[];
}

// --- filename patterns -----------------------------------------------------
//
// Matched against the stem with any collision suffix already stripped, so the
// suffix does not have to appear in four separate patterns.
//
// Spacing is loose (`\s*`) on purpose: the live vault writes `26 Y+ Goals.md`
// while its own template writes `xxY+ Goals.md`, so the gap between the year
// and the horizon letter is not reliable. `vault-conventions.md` says as much.

const DAILY_PATTERN = /^(\d{2})\.(\d{2})\.(\d{2})$/;
const WEEK_PATTERN = /^(\d{2})\s*W(\d{1,2})\s*Goals$/i;
const MONTH_PATTERN = /^(\d{2})\s*M(\d{1,2})\s*Goals$/i;
const QUARTER_PATTERN = /^(\d{2})\s*Q([1-4])\s*Goals$/i;
const YEAR_PLUS_PATTERN = /^(\d{2})\s*Y\s*\+\s*Goals$/i;

// --- labels ----------------------------------------------------------------

/** `26 W33 Goals` for the ISO week containing `date`. */
export function goalDocLabel(horizon: GoalHorizon, date: CalendarDate): string {
	switch (horizon) {
		case "week": {
			const { weekYear, week } = isoWeek(date);
			return `${shortYear(weekYear)} W${pad2(week)} Goals`;
		}
		case "month":
			return `${shortYear(date.year)} M${pad2(date.month)} Goals`;
		case "quarter":
			return `${shortYear(date.year)} Q${quarterOf(date)} Goals`;
		case "yearPlus":
			return `${shortYear(date.year)} Y+ Goals`;
	}
}

/** Sortable period key for `date` at `horizon`, matching `GoalDocEntry.key`. */
function goalDocKey(horizon: GoalHorizon, date: CalendarDate): number {
	switch (horizon) {
		case "week": {
			const { weekYear, week } = isoWeek(date);
			return weekYear * 100 + week;
		}
		case "month":
			return date.year * 100 + date.month;
		case "quarter":
			return date.year * 10 + quarterOf(date);
		case "yearPlus":
			return date.year;
	}
}

/**
 * Where a *new* daily note goes. Rollover into `YY.MM/` buckets is manual, so
 * new notes always land flat in `Mise/`; only reads have to cope with buckets.
 */
export function newDailyNotePath(date: CalendarDate): string {
	return `${DAILY_NOTES_ROOT}/${dailyNoteStem(date)}.md`;
}

// --- preference ordering ---------------------------------------------------
//
// When several files claim the same period, exactly one has to win, and the
// choice has to be stable across runs (PR 4's prompt cache depends on byte
// identical output). Ordering, most significant first:
//
//   1. Under `Mise/` beats stray copies elsewhere in the vault. Living in the
//      daily-notes tree is the strongest evidence a file *is* the daily note.
//   2. No collision suffix beats a suffix, and a lower suffix beats a higher
//      one. `26.07.02.md` is the note the user has been writing in;
//      `26.07.02 1.md` is what Obsidian created when something tried to make a
//      second one. The original wins, the accident is reported as a duplicate.
//   3. Shallower path beats deeper — flat `Mise/26.08.16.md` over a bucket.
//   4. Lexicographic path, purely so ties are deterministic.
//
// **Step 4 is load-bearing outside this file.** Because paths are unique, it
// makes both comparators below *total* orders: no two entries ever compare
// equal, so `Array.prototype.sort` never falls back on the order the caller
// handed the paths over in — and Obsidian's `getMarkdownFiles()` order is not
// promised to be stable between launches.
//
// `src/context/pack.ts` inherits its whole determinism guarantee from that. It
// re-sorts nothing; it reads `dailyNotes` and `goalDocs[horizon]` in the order
// produced here, and a byte-identical prompt prefix is what lets Ollama reuse
// the KV cache across requests. Weaken step 4 and the prompt starts changing
// between launches for no reason the user can see, on vaults that contain a
// collision. If you touch either comparator, run `src/context/pack.test.ts`'s
// byte identity suite — it permutes the input array over a fixture that has
// real collisions (`26.07.02 1.md`, `25.01.29 1.md`) precisely for this.

function compareSuffixThenPath(a: IndexedFile, b: IndexedFile): number {
	// `null` (no suffix) sorts ahead of every real suffix.
	const as = a.suffix ?? -1;
	const bs = b.suffix ?? -1;
	if (as !== bs) return as - bs;
	const ad = depth(a.path);
	const bd = depth(b.path);
	if (ad !== bd) return ad - bd;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function compareDailyPreference(a: DailyNoteEntry, b: DailyNoteEntry): number {
	if (a.inDailyRoot !== b.inDailyRoot) return a.inDailyRoot ? -1 : 1;
	return compareSuffixThenPath(a, b);
}

// --- index construction ----------------------------------------------------

function parseDailyNote(path: string): DailyNoteEntry | null {
	const { base, suffix } = splitCollisionSuffix(stem(path));
	const match = DAILY_PATTERN.exec(base);
	if (match === null) return null;

	const date: CalendarDate = {
		year: expandShortYear(Number(match[1])),
		month: Number(match[2]),
		day: Number(match[3]),
	};
	// `26.13.40.md` is not a date, it is a file that happens to have dots.
	if (date.month < 1 || date.month > 12) return null;
	if (date.day < 1 || date.day > 31) return null;

	return {
		path,
		suffix,
		date,
		ordinal: dateOrdinal(date),
		inDailyRoot: segments(path)[0] === DAILY_NOTES_ROOT,
	};
}

function parseGoalDoc(
	path: string,
): { horizon: GoalHorizon; entry: GoalDocEntry } | null {
	const { base, suffix } = splitCollisionSuffix(stem(path));

	const week = WEEK_PATTERN.exec(base);
	if (week !== null) {
		const weekYear = expandShortYear(Number(week[1]));
		const weekNumber = Number(week[2]);
		if (weekNumber < 1 || weekNumber > 53) return null;
		return {
			horizon: "week",
			entry: {
				path,
				suffix,
				key: weekYear * 100 + weekNumber,
				label: `${shortYear(weekYear)} W${pad2(weekNumber)} Goals`,
			},
		};
	}

	const month = MONTH_PATTERN.exec(base);
	if (month !== null) {
		const year = expandShortYear(Number(month[1]));
		const monthNumber = Number(month[2]);
		if (monthNumber < 1 || monthNumber > 12) return null;
		return {
			horizon: "month",
			entry: {
				path,
				suffix,
				key: year * 100 + monthNumber,
				label: `${shortYear(year)} M${pad2(monthNumber)} Goals`,
			},
		};
	}

	const quarter = QUARTER_PATTERN.exec(base);
	if (quarter !== null) {
		const year = expandShortYear(Number(quarter[1]));
		const quarterNumber = Number(quarter[2]);
		return {
			horizon: "quarter",
			entry: {
				path,
				suffix,
				key: year * 10 + quarterNumber,
				label: `${shortYear(year)} Q${quarterNumber} Goals`,
			},
		};
	}

	const yearPlus = YEAR_PLUS_PATTERN.exec(base);
	if (yearPlus !== null) {
		const year = expandShortYear(Number(yearPlus[1]));
		return {
			horizon: "yearPlus",
			entry: {
				path,
				suffix,
				key: year,
				label: `${shortYear(year)} Y+ Goals`,
			},
		};
	}

	return null;
}

/**
 * Builds the lookup structures once from a list of vault-relative paths.
 *
 * Excluded paths (templates, archives, attachments, Obsidian scaffolding) are
 * dropped here rather than at each call site, so no resolver can forget.
 */
export function createVaultIndex(
	paths: readonly string[],
	options: ExclusionOptions = {},
): VaultIndex {
	const kept = paths
		.filter((p) => isMarkdown(p) && !isExcludedPath(p, options))
		.slice()
		// Sorting up front means every derived list is deterministic regardless
		// of the order Obsidian handed us the files in.
		.sort();

	const dailyNotes: DailyNoteEntry[] = [];
	const goalDocs: Record<GoalHorizon, GoalDocEntry[]> = {
		week: [],
		month: [],
		quarter: [],
		yearPlus: [],
	};

	for (const path of kept) {
		const daily = parseDailyNote(path);
		if (daily !== null) {
			dailyNotes.push(daily);
			continue;
		}
		const goal = parseGoalDoc(path);
		if (goal !== null) goalDocs[goal.horizon].push(goal.entry);
	}

	dailyNotes.sort(
		(a, b) => a.ordinal - b.ordinal || compareDailyPreference(a, b),
	);
	for (const horizon of GOAL_HORIZONS) {
		goalDocs[horizon].sort(
			(a, b) => a.key - b.key || compareSuffixThenPath(a, b),
		);
	}

	return { paths: kept, options, dailyNotes, goalDocs };
}

// --- resolution ------------------------------------------------------------

function toDailyNote(group: readonly DailyNoteEntry[]): DailyNote | null {
	if (group.length === 0) return null;
	// `dailyNotes` is already sorted by preference within a date.
	const winner = group[0] as DailyNoteEntry;
	return {
		date: winner.date,
		path: winner.path,
		duplicates: group.slice(1).map((e) => e.path),
	};
}

/**
 * The daily note for `date`, or `null` if it was never written.
 *
 * Found by *searching for the basename* `YY.MM.DD.md`, never by constructing
 * `Mise/YY.MM/YY.MM.DD.md`: month folders are buckets filled by a manual
 * rollover, so `Mise/26.03/` holds `26.02.21.md` and `Mise/26.06/` holds
 * `26.05.28.md`. Constructing the path would miss both.
 */
export function resolveDailyNote(
	index: VaultIndex,
	date: CalendarDate,
): DailyNote | null {
	const ordinal = dateOrdinal(date);
	return toDailyNote(index.dailyNotes.filter((e) => e.ordinal === ordinal));
}

/**
 * The most recent daily note *strictly before* `date`.
 *
 * Not `date - 1 day`: 26.08.02, 26.08.07 and 26.08.15 do not exist, so
 * "yesterday's note" has to mean the latest note that actually exists.
 */
export function resolveMostRecentDailyNoteBefore(
	index: VaultIndex,
	date: CalendarDate,
): DailyNote | null {
	const ordinal = dateOrdinal(date);
	let best: number | null = null;
	for (const entry of index.dailyNotes) {
		if (entry.ordinal >= ordinal) break; // sorted ascending
		best = entry.ordinal;
	}
	if (best === null) return null;
	return toDailyNote(index.dailyNotes.filter((e) => e.ordinal === best));
}

/**
 * The goal doc covering `date` at `horizon`, falling back to the most recent
 * existing doc *at or before* that period.
 *
 * Falling back forwards would be wrong: 2026 has W29–W31 and W33 but no W32,
 * and asking about the week of 5 August should surface what was actually
 * planned before it (`26 W31`), not next week's doc. When nothing at or before
 * the period exists, `path` is `null` — better an honest "no doc" than a
 * document from the wrong side of the question.
 *
 * `exact` and `label` exist so the UI can say *which* doc it used, which
 * `vault-conventions.md` asks for explicitly.
 *
 * Known limitation: a `null` path does not distinguish "this vault has no docs
 * at this horizon at all" from "docs exist, but every one of them is later than
 * the requested period" — asking for `26 Q1 Goals` in a vault whose earliest
 * quarter doc is `26 Q2` looks identical to asking in a vault with no quarter
 * docs whatsoever. Both are honestly "nothing to show you for that period", so
 * neither the return type nor the fallback rule needs to change on their
 * account. Whether the difference is worth surfacing — *"no 26 Q1 Goals; the
 * earliest is 26 Q2"* rather than a bare "none" — is a question about what the
 * consuming UI wants to say, and a caller that decides it wants to say it can
 * read `index.goalDocs[horizon]` directly rather than have a field added here
 * speculatively.
 */
export function resolveGoalDoc(
	index: VaultIndex,
	horizon: GoalHorizon,
	date: CalendarDate,
): GoalDocResolution {
	const requestedLabel = goalDocLabel(horizon, date);
	const requestedKey = goalDocKey(horizon, date);
	const candidates = index.goalDocs[horizon];

	let bestKey: number | null = null;
	for (const entry of candidates) {
		if (entry.key > requestedKey) break; // sorted ascending
		bestKey = entry.key;
	}

	if (bestKey === null) {
		return {
			horizon,
			requestedLabel,
			path: null,
			label: null,
			exact: false,
			duplicates: [],
		};
	}

	const group = candidates.filter((e) => e.key === bestKey);
	const winner = group[0] as GoalDocEntry;
	return {
		horizon,
		requestedLabel,
		path: winner.path,
		label: winner.label,
		exact: bestKey === requestedKey,
		duplicates: group.slice(1).map((e) => e.path),
	};
}

