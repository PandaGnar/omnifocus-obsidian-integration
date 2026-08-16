// Calendar maths for vault filenames. No `obsidian` import, no `Date` in the
// public types.
//
// Why `CalendarDate` instead of `Date`: a `Date` is an instant, and turning an
// instant into "which day is this" needs a timezone. Reading it as UTC shifts
// the daily note by one day for anyone west of Greenwich after 00:00 UTC;
// reading it as local makes the function untestable without freezing TZ. A
// bare year/month/day triple has neither problem, so the ambiguity is resolved
// once, at the edge, by `toCalendarDate`.

/** Year, 1-based month, 1-based day. */
export interface CalendarDate {
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

/** ISO-8601 week identity. `weekYear` is *not* always the calendar year. */
export interface IsoWeek {
	readonly weekYear: number;
	readonly week: number;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/**
 * The vault writes two-digit years. Everything in it is 21st century, so `25`
 * is 2025 and there is no rollover problem worth solving before 2100.
 */
const CENTURY = 2000;

/** Reads a `Date`'s *local* calendar day — what the user means by "today". */
export function toCalendarDate(date: Date): CalendarDate {
	return {
		year: date.getFullYear(),
		month: date.getMonth() + 1,
		day: date.getDate(),
	};
}

/** Sortable integer for a date: 2026-08-16 becomes 20260816. */
export function dateOrdinal(date: CalendarDate): number {
	return date.year * 10_000 + date.month * 100 + date.day;
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
	return dateOrdinal(a) - dateOrdinal(b);
}

/** Zero-pads to two digits. */
export function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

/** Two-digit year as the vault writes it: 2026 becomes `26`. */
export function shortYear(year: number): string {
	return pad2(((year % 100) + 100) % 100);
}

/** Expands a two-digit filename year back to a full one. */
export function expandShortYear(shortYearValue: number): number {
	return CENTURY + shortYearValue;
}

/**
 * UTC midnight for a calendar date. UTC specifically: all arithmetic below is
 * day counting, and a DST transition inside a local-time span would make a
 * "seven day" difference 7 days ± 1 hour, which rounds wrong.
 */
function utcMillis(date: CalendarDate): number {
	return Date.UTC(date.year, date.month - 1, date.day);
}

/**
 * ISO-8601 week of the year, per the Thursday rule: the week containing a
 * Thursday belongs to that Thursday's year.
 *
 * This is the rule that makes `26 W53 Goals.md` the right doc for Fri
 * 2027-01-01, and `26 W01 Goals.md` the right doc for Mon 2025-12-29. Deriving
 * the year from `date.year` instead is the classic silent bug.
 */
export function isoWeek(date: CalendarDate): IsoWeek {
	const thursday = new Date(utcMillis(date));
	// Monday = 0 … Sunday = 6.
	const dayIndex = (thursday.getUTCDay() + 6) % 7;
	thursday.setUTCDate(thursday.getUTCDate() - dayIndex + 3);

	const weekYear = thursday.getUTCFullYear();

	// 4 January is always in ISO week 1, so the Thursday of its week is week
	// 1's Thursday — the anchor everything else is measured from.
	const anchor = new Date(Date.UTC(weekYear, 0, 4));
	const anchorDayIndex = (anchor.getUTCDay() + 6) % 7;
	anchor.setUTCDate(anchor.getUTCDate() - anchorDayIndex + 3);

	const week =
		1 + Math.round((thursday.getTime() - anchor.getTime()) / MS_PER_WEEK);
	return { weekYear, week };
}

/**
 * `date` shifted by whole days, month and year rollover included.
 *
 * Counted in UTC for the same reason `utcMillis` exists: adding 86 400 000 ms
 * to a local-time instant lands on the same calendar day twice a year, on the
 * DST transitions. A `CalendarDate` has no time of day to lose, so doing the
 * arithmetic at UTC midnight is exact.
 */
export function addDays(date: CalendarDate, days: number): CalendarDate {
	const shifted = new Date(utcMillis(date) + days * MS_PER_DAY);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
	};
}

/** Calendar quarter, 1–4. */
export function quarterOf(date: CalendarDate): number {
	return Math.floor((date.month - 1) / 3) + 1;
}

/** `26.08.16` — the daily note stem. */
export function dailyNoteStem(date: CalendarDate): string {
	return `${shortYear(date.year)}.${pad2(date.month)}.${pad2(date.day)}`;
}
