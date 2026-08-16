import { describe, expect, it } from "vitest";

import {
	type CalendarDate,
	compareCalendarDates,
	dailyNoteStem,
	dateOrdinal,
	expandShortYear,
	isoWeek,
	quarterOf,
	shortYear,
	toCalendarDate,
} from "./dates";

function d(year: number, month: number, day: number): CalendarDate {
	return { year, month, day };
}

describe("isoWeek", () => {
	// The Thursday rule, exercised where it actually bites. Each expectation
	// below was derived from the ISO definition (the week containing 4 January
	// is week 1; a week belongs to the year of its Thursday), not from the
	// implementation.
	const cases: ReadonlyArray<
		[label: string, date: CalendarDate, weekYear: number, week: number]
	> = [
		["the vault's worked example, Mon 2026-08-10", d(2026, 8, 10), 2026, 33],
		["the same week's Sunday, 2026-08-16", d(2026, 8, 16), 2026, 33],
		["the day before it, Sun 2026-08-09", d(2026, 8, 9), 2026, 32],
		["the day after it, Mon 2026-08-17", d(2026, 8, 17), 2026, 34],

		// Calendar year 2025, ISO week-year 2026 — the filename says 26.
		["Mon 2025-12-29 starts ISO 2026-W01", d(2025, 12, 29), 2026, 1],
		["Wed 2025-12-31 is still 2026-W01", d(2025, 12, 31), 2026, 1],
		["Thu 2026-01-01 is 2026-W01", d(2026, 1, 1), 2026, 1],
		["Sun 2026-01-04 ends 2026-W01", d(2026, 1, 4), 2026, 1],
		["Mon 2026-01-05 starts 2026-W02", d(2026, 1, 5), 2026, 2],

		// Calendar year 2027, ISO week-year 2026 — the filename says 26.
		["Mon 2026-12-28 starts ISO 2026-W53", d(2026, 12, 28), 2026, 53],
		["Fri 2027-01-01 is still 2026-W53", d(2027, 1, 1), 2026, 53],
		["Sun 2027-01-03 ends 2026-W53", d(2027, 1, 3), 2026, 53],
		["Mon 2027-01-04 starts 2027-W01", d(2027, 1, 4), 2027, 1],

		// A year whose 1 January falls late in a week belongs to the previous
		// week-year for its first few days.
		["Sat 2022-01-01 is 2021-W52", d(2022, 1, 1), 2021, 52],
		["Mon 2022-01-03 is 2022-W01", d(2022, 1, 3), 2022, 1],

		// Leap year, and a year that genuinely has 53 ISO weeks.
		["Wed 2020-12-30 is 2020-W53", d(2020, 12, 30), 2020, 53],
		["Fri 2021-01-01 is still 2020-W53", d(2021, 1, 1), 2020, 53],
		["Mon 2020-02-24 is 2020-W09", d(2020, 2, 24), 2020, 9],
	];

	for (const [label, date, weekYear, week] of cases) {
		it(label, () => {
			expect(isoWeek(date)).toEqual({ weekYear, week });
		});
	}

	it("never disagrees with itself across a whole year", () => {
		// Walk 2026 day by day: the week number must be non-decreasing within a
		// week-year, and every Monday must start a new week.
		let previous = isoWeek(d(2025, 12, 31));
		for (let day = 1; day <= 365; day += 1) {
			const cursor = new Date(Date.UTC(2026, 0, day));
			const date = d(
				cursor.getUTCFullYear(),
				cursor.getUTCMonth() + 1,
				cursor.getUTCDate(),
			);
			const current = isoWeek(date);
			const isMonday = cursor.getUTCDay() === 1;
			if (isMonday) {
				expect(
					current.week !== previous.week ||
						current.weekYear !== previous.weekYear,
				).toBe(true);
			} else {
				expect(current).toEqual(previous);
			}
			expect(current.week).toBeGreaterThanOrEqual(1);
			expect(current.week).toBeLessThanOrEqual(53);
			previous = current;
		}
	});
});

describe("quarterOf", () => {
	it.each([
		[1, 1],
		[3, 1],
		[4, 2],
		[6, 2],
		[7, 3],
		[8, 3],
		[9, 3],
		[10, 4],
		[12, 4],
	])("month %i is Q%i", (month, quarter) => {
		expect(quarterOf(d(2026, month, 15))).toBe(quarter);
	});
});

describe("short years", () => {
	it("writes the vault's two-digit form", () => {
		expect(shortYear(2026)).toBe("26");
		expect(shortYear(2005)).toBe("05");
	});

	it("round-trips", () => {
		expect(expandShortYear(Number(shortYear(2026)))).toBe(2026);
		expect(expandShortYear(25)).toBe(2025);
	});
});

describe("dailyNoteStem", () => {
	it("zero-pads both halves", () => {
		expect(dailyNoteStem(d(2026, 8, 1))).toBe("26.08.01");
		expect(dailyNoteStem(d(2026, 12, 31))).toBe("26.12.31");
	});
});

describe("ordering", () => {
	it("sorts by ordinal", () => {
		expect(dateOrdinal(d(2026, 8, 16))).toBe(20260816);
		expect(compareCalendarDates(d(2026, 8, 16), d(2026, 8, 17))).toBeLessThan(
			0,
		);
		expect(compareCalendarDates(d(2026, 8, 16), d(2026, 8, 16))).toBe(0);
		expect(
			compareCalendarDates(d(2026, 9, 1), d(2026, 8, 31)),
		).toBeGreaterThan(0);
	});
});

describe("toCalendarDate", () => {
	it("reads the local calendar day, not the UTC one", () => {
		// Constructed with local components, so this holds in any timezone —
		// which is the whole reason the resolver does not take a `Date`.
		const local = new Date(2026, 7, 16, 23, 30);
		expect(toCalendarDate(local)).toEqual(d(2026, 8, 16));
	});
});
