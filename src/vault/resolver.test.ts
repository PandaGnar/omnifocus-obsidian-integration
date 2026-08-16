import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanForObsidianDependencies } from "../testing/purity";

import type { CalendarDate } from "./dates";
import { VAULT_TREE } from "./fixtures/vaultTree";
import {
	type GoalHorizon,
	createVaultIndex,
	goalDocLabel,
	newDailyNotePath,
	resolveDailyNote,
	resolveGoalDoc,
	resolveMostRecentDailyNoteBefore,
} from "./resolver";

const vault = createVaultIndex(VAULT_TREE);
const withHistory = createVaultIndex(VAULT_TREE, { includeArchives: true });

function d(year: number, month: number, day: number): CalendarDate {
	return { year, month, day };
}

describe("createVaultIndex", () => {
	it("drops templates, archives and attachments up front", () => {
		expect(vault.paths).not.toContain("Mise/xx.xx.xx Mise.md");
		expect(vault.paths).not.toContain("Long Term/xxY+ Goals.md");
		expect(vault.paths).not.toContain("Long Term/Archive/2025/25 W52 Goals.md");
		expect(vault.paths).not.toContain("zAssets/diagram.md");
		expect(vault.paths).not.toContain("Welcome.md");
		expect(vault.paths).not.toContain(
			"zAssets/Pasted image 20260101120000.png",
		);
	});

	it("keeps the real notes", () => {
		expect(vault.paths).toContain("Mise/26.08.16.md");
		expect(vault.paths).toContain("Long Term/26 Y+ Goals.md");
		expect(vault.paths).toContain("Long Term/Life Goals.md");
	});

	it("is order-independent — Obsidian's file order must not leak", () => {
		const shuffled = createVaultIndex([...VAULT_TREE].reverse());
		expect(shuffled.paths).toEqual(vault.paths);
		expect(shuffled.dailyNotes).toEqual(vault.dailyNotes);
		expect(shuffled.goalDocs).toEqual(vault.goalDocs);
	});

	it("classifies the misfiled notes as daily notes anyway", () => {
		const paths = vault.dailyNotes.map((e) => e.path);
		expect(paths).toContain("Mise/26.03/26.02.21.md");
		expect(paths).toContain("Mise/26.06/26.05.28.md");
	});
});

describe("resolveDailyNote", () => {
	const cases: ReadonlyArray<
		[label: string, date: CalendarDate, expected: string | null]
	> = [
		["a flat note in Mise/", d(2026, 8, 16), "Mise/26.08.16.md"],
		["a note in its own YY.MM/ bucket", d(2026, 7, 31), "Mise/26.07/26.07.31.md"],
		// Month folders are buckets, not date ranges. Constructing
		// `Mise/26.02/26.02.21.md` would find nothing.
		["a February note filed under 26.03/", d(2026, 2, 21), "Mise/26.03/26.02.21.md"],
		["a May note filed under 26.06/", d(2026, 5, 28), "Mise/26.06/26.05.28.md"],
		// Skipped days: no note was ever written.
		["a skipped day (26.08.02)", d(2026, 8, 2), null],
		["a skipped day (26.08.07)", d(2026, 8, 7), null],
		["a skipped day (26.08.15)", d(2026, 8, 15), null],
		["a date the vault has never seen", d(2024, 3, 3), null],
		// Archived history is invisible by default.
		["an archived note", d(2025, 12, 31), null],
	];

	for (const [label, date, expected] of cases) {
		it(`resolves ${label}`, () => {
			expect(resolveDailyNote(vault, date)?.path ?? null).toBe(expected);
		});
	}

	it("prefers the original over Obsidian's collision suffix", () => {
		const note = resolveDailyNote(vault, d(2026, 7, 2));
		expect(note?.path).toBe("Mise/26.07/26.07.02.md");
		expect(note?.duplicates).toEqual(["Mise/26.07/26.07.02 1.md"]);
	});

	it("prefers a note under Mise/ over a stray copy elsewhere", () => {
		// Rule 1 of the preference order, and the one PR 6's "open the existing
		// note" path will sit on. The fixture pair is deliberately built so that
		// every *lower* rule points the other way: the stray carries no
		// collision suffix and sits one folder shallower, so if membership of
		// the daily-notes tree stops outranking those, the stray wins.
		const note = resolveDailyNote(vault, d(2026, 4, 10));
		expect(note?.path).toBe("Mise/26.04/26.04.10 1.md");
		expect(note?.duplicates).toEqual(["Notes/26.04.10.md"]);
	});

	it("still finds a date-shaped note that only exists outside Mise/", () => {
		// Losing to a note under `Mise/` is not the same as being invisible.
		const stray = createVaultIndex(["Notes/26.04.10.md"]);
		expect(resolveDailyNote(stray, d(2026, 4, 10))?.path).toBe(
			"Notes/26.04.10.md",
		);
	});

	it("breaks a remaining tie on depth, not on path order", () => {
		// Same date, same daily-notes tree, neither suffixed: only depth
		// separates them, and the flat note is the one being written in. The
		// folder name is chosen so that the deeper path sorts *first*
		// lexicographically — otherwise the final path tie-break would decide
		// this case by accident and depth would never be exercised.
		const tied = createVaultIndex([
			"Mise/2026/26.09.03.md",
			"Mise/26.09.03.md",
		]);
		expect("Mise/2026/26.09.03.md" < "Mise/26.09.03.md").toBe(true);
		const note = resolveDailyNote(tied, d(2026, 9, 3));
		expect(note?.path).toBe("Mise/26.09.03.md");
		expect(note?.duplicates).toEqual(["Mise/2026/26.09.03.md"]);
	});

	const nonDates: readonly string[] = [
		"Mise/26.13.40.md", // month 13, day 40
		"Mise/26.02.40.md", // day out of range on its own
		"Mise/26.00.09.md", // month zero
		"Mise/26.09.00.md", // day zero
	];

	for (const path of nonDates) {
		it(`does not read ${path} as a date`, () => {
			// Three dot-separated pairs are a *shape*, not a calendar date. A
			// file that merely has dots in its name must not join the daily
			// notes, where it would become an answer to some nearby query.
			const index = createVaultIndex([path]);
			expect(index.paths).toEqual([path]);
			expect(index.dailyNotes).toEqual([]);
		});
	}

	it("does the same when the suffixed copy is listed first", () => {
		// `25.01.29 1.md` appears before `25.01.29.md` in the fixture, mirroring
		// an arbitrary Obsidian file order.
		const note = resolveDailyNote(vault, d(2025, 1, 29));
		expect(note?.path).toBe("Mise/25.01/25.01.29.md");
		expect(note?.duplicates).toEqual(["Mise/25.01/25.01.29 1.md"]);
	});

	it("never returns both halves of a duplicate pair as the answer", () => {
		for (const date of [d(2026, 7, 2), d(2025, 1, 29), d(2025, 5, 10)]) {
			const note = resolveDailyNote(vault, date);
			expect(note).not.toBeNull();
			expect(note?.duplicates).not.toContain(note?.path);
		}
	});

	it("reports no duplicates for an uncontested note", () => {
		expect(resolveDailyNote(vault, d(2026, 8, 16))?.duplicates).toEqual([]);
	});

	it("finds archived notes only when history is requested", () => {
		expect(resolveDailyNote(withHistory, d(2025, 12, 31))?.path).toBe(
			"Long Term/Archive/2025/25.12/25.12.31.md",
		);
	});

	it("ignores the trash even though the filename is a valid date", () => {
		expect(resolveDailyNote(withHistory, d(2026, 8, 15))).toBeNull();
	});
});

describe("resolveMostRecentDailyNoteBefore", () => {
	const cases: ReadonlyArray<
		[label: string, date: CalendarDate, expected: string | null]
	> = [
		// 26.08.15 was skipped, so "yesterday" from the 16th is the 14th.
		["skips one missing day", d(2026, 8, 16), "Mise/26.08.14.md"],
		["skips a missing 26.08.07", d(2026, 8, 8), "Mise/26.08.06.md"],
		["skips a missing 26.08.02", d(2026, 8, 3), "Mise/26.08.01.md"],
		// Strictly before: a note on the date itself is not "before" it.
		["is strict about the boundary", d(2026, 8, 14), "Mise/26.08.13.md"],
		// Crosses from flat Mise/ into a YY.MM/ bucket.
		["crosses out of the flat folder", d(2026, 8, 1), "Mise/26.07/26.07.31.md"],
		// Crosses a misfiled boundary: 26.06.01's predecessor is 26.05.28,
		// which lives in `Mise/26.06/`.
		["crosses a misfiled bucket", d(2026, 6, 1), "Mise/26.06/26.05.28.md"],
		[
			"walks back months when it has to",
			d(2026, 6, 30),
			"Mise/26.06/26.06.01.md",
		],
		["walks back from the far side of a gap", d(2026, 3, 2), "Mise/26.03/26.03.01.md"],
		["returns null before the first note", d(2024, 1, 1), null],
	];

	for (const [label, date, expected] of cases) {
		it(label, () => {
			expect(
				resolveMostRecentDailyNoteBefore(vault, date)?.path ?? null,
			).toBe(expected);
		});
	}

	it("reports the duplicate alongside the note it picked", () => {
		const note = resolveMostRecentDailyNoteBefore(vault, d(2026, 7, 3));
		expect(note?.path).toBe("Mise/26.07/26.07.02.md");
		expect(note?.duplicates).toEqual(["Mise/26.07/26.07.02 1.md"]);
	});

	it("does not walk into the archive by default", () => {
		// `Long Term/Archive/2025/25.12/25.12.31.md` is the nearest note before
		// 2026-01-01, but it is history: by default the walk steps straight
		// over it to the newest live note, seven months earlier.
		expect(resolveMostRecentDailyNoteBefore(vault, d(2026, 1, 1))?.path).toBe(
			"Mise/25.05/25.05.10.md",
		);
		expect(
			resolveMostRecentDailyNoteBefore(withHistory, d(2026, 1, 1))?.path,
		).toBe("Long Term/Archive/2025/25.12/25.12.31.md");
	});

	it("never returns a template", () => {
		// `Mise/xx.xx.xx Mise.md` is the only other file in the flat folder; a
		// resolver that listed the directory instead of parsing dates could
		// return it here.
		for (let day = 1; day <= 31; day += 1) {
			const note = resolveMostRecentDailyNoteBefore(vault, d(2026, 8, day));
			expect(note?.path ?? "").not.toContain("xx");
		}
	});
});

describe("goalDocLabel", () => {
	const cases: ReadonlyArray<
		[horizon: GoalHorizon, date: CalendarDate, label: string]
	> = [
		["week", d(2026, 8, 16), "26 W33 Goals"],
		["week", d(2026, 8, 5), "26 W32 Goals"],
		// ISO week-year, not calendar year — both directions.
		["week", d(2027, 1, 1), "26 W53 Goals"],
		["week", d(2025, 12, 29), "26 W01 Goals"],
		["month", d(2026, 8, 16), "26 M08 Goals"],
		["month", d(2026, 7, 1), "26 M07 Goals"],
		["quarter", d(2026, 8, 16), "26 Q3 Goals"],
		["quarter", d(2026, 3, 31), "26 Q1 Goals"],
		["quarter", d(2026, 4, 1), "26 Q2 Goals"],
		["yearPlus", d(2026, 8, 16), "26 Y+ Goals"],
	];

	for (const [horizon, date, label] of cases) {
		it(`${horizon} on ${date.year}-${date.month}-${date.day} is ${label}`, () => {
			expect(goalDocLabel(horizon, date)).toBe(label);
		});
	}
});

describe("resolveGoalDoc", () => {
	const cases: ReadonlyArray<{
		readonly label: string;
		readonly horizon: GoalHorizon;
		readonly date: CalendarDate;
		readonly requestedLabel: string;
		readonly path: string | null;
		readonly settled: string | null;
		readonly exact: boolean;
	}> = [
		{
			label: "the current week, which exists",
			horizon: "week",
			date: d(2026, 8, 16),
			requestedLabel: "26 W33 Goals",
			path: "Long Term/26 W33 Goals.md",
			settled: "26 W33 Goals",
			exact: true,
		},
		{
			// 2026 has W29, W30, W31, W33 — no W32.
			label: "the missing W32",
			horizon: "week",
			date: d(2026, 8, 5),
			requestedLabel: "26 W32 Goals",
			path: "Long Term/26 W31 Goals.md",
			settled: "26 W31 Goals",
			exact: false,
		},
		{
			// Falling back *forwards* to W33 would answer a question about the
			// first week of August with the plan written for the second.
			label: "a much older week, without jumping forwards",
			horizon: "week",
			date: d(2026, 7, 20),
			requestedLabel: "26 W30 Goals",
			path: "Long Term/26 W30 Goals.md",
			settled: "26 W30 Goals",
			exact: true,
		},
		{
			label: "ISO week 53 of week-year 2026, dated 1 January 2027",
			horizon: "week",
			date: d(2027, 1, 1),
			requestedLabel: "26 W53 Goals",
			path: "Long Term/26 W53 Goals.md",
			settled: "26 W53 Goals",
			exact: true,
		},
		{
			// The first Monday of ISO 2027 — nothing exists yet, so it falls
			// back across the week-year boundary to W53 of 2026.
			label: "the first week of ISO 2027",
			horizon: "week",
			date: d(2027, 1, 4),
			requestedLabel: "27 W01 Goals",
			path: "Long Term/26 W53 Goals.md",
			settled: "26 W53 Goals",
			exact: false,
		},
		{
			// Calendar 2025, ISO week-year 2026. Nothing at or before it once
			// the archive is excluded.
			label: "a week whose week-year runs ahead of the calendar year",
			horizon: "week",
			date: d(2025, 12, 29),
			requestedLabel: "26 W01 Goals",
			path: null,
			settled: null,
			exact: false,
		},
		{
			// `26 M08` does not exist.
			label: "the missing month",
			horizon: "month",
			date: d(2026, 8, 16),
			requestedLabel: "26 M08 Goals",
			path: "Long Term/26 M07 Goals.md",
			settled: "26 M07 Goals",
			exact: false,
		},
		{
			label: "a month that exists",
			horizon: "month",
			date: d(2026, 7, 15),
			requestedLabel: "26 M07 Goals",
			path: "Long Term/26 M07 Goals.md",
			settled: "26 M07 Goals",
			exact: true,
		},
		{
			// The gap between 25 M12 and 26 M06 is five months wide.
			label: "a month gap that spans a year boundary",
			horizon: "month",
			date: d(2026, 5, 15),
			requestedLabel: "26 M05 Goals",
			path: "Long Term/25 M12 Goals.md",
			settled: "25 M12 Goals",
			exact: false,
		},
		{
			label: "the current quarter",
			horizon: "quarter",
			date: d(2026, 8, 16),
			requestedLabel: "26 Q3 Goals",
			path: "Long Term/26 Q3 Goals.md",
			settled: "26 Q3 Goals",
			exact: true,
		},
		{
			label: "a quarter with nothing at or before it",
			horizon: "quarter",
			date: d(2026, 1, 15),
			requestedLabel: "26 Q1 Goals",
			path: null,
			settled: null,
			exact: false,
		},
		{
			// The live doc is spaced (`26 Y+ Goals.md`); its template is not
			// (`xxY+ Goals.md`). Matching has to be loose enough for one and
			// still reject the other.
			label: "the spaced Y+ doc",
			horizon: "yearPlus",
			date: d(2026, 8, 16),
			requestedLabel: "26 Y+ Goals",
			path: "Long Term/26 Y+ Goals.md",
			settled: "26 Y+ Goals",
			exact: true,
		},
		{
			label: "a future year, falling back to the newest Y+ doc",
			horizon: "yearPlus",
			date: d(2027, 6, 1),
			requestedLabel: "27 Y+ Goals",
			path: "Long Term/26 Y+ Goals.md",
			settled: "26 Y+ Goals",
			exact: false,
		},
	];

	for (const c of cases) {
		it(`resolves ${c.label}`, () => {
			const result = resolveGoalDoc(vault, c.horizon, c.date);
			expect(result.requestedLabel).toBe(c.requestedLabel);
			expect(result.path).toBe(c.path);
			expect(result.label).toBe(c.settled);
			expect(result.exact).toBe(c.exact);
			expect(result.horizon).toBe(c.horizon);
		});
	}

	it("never settles on a template", () => {
		const horizons: readonly GoalHorizon[] = [
			"week",
			"month",
			"quarter",
			"yearPlus",
		];
		for (const horizon of horizons) {
			for (let month = 1; month <= 12; month += 1) {
				const result = resolveGoalDoc(vault, horizon, d(2026, month, 15));
				expect(result.path ?? "").not.toContain("xx");
			}
		}
	});

	it("never settles on an archived doc unless history was requested", () => {
		expect(resolveGoalDoc(vault, "quarter", d(2026, 1, 15)).path).toBeNull();
		const historical = resolveGoalDoc(withHistory, "quarter", d(2026, 1, 15));
		expect(historical.path).toBe("Long Term/Archive/2025/25 Q4 Goals.md");
		expect(historical.label).toBe("25 Q4 Goals");
		expect(historical.exact).toBe(false);
	});

	it("prefers the original goal doc over Obsidian's collision suffix", () => {
		// Same rule as for daily notes, on the other kind of file: `26 W31
		// Goals 1.md` is what Obsidian wrote when something tried to create a
		// second W31 doc. The original is the one being planned in, and the
		// accident is reported rather than discarded.
		const result = resolveGoalDoc(vault, "week", d(2026, 7, 27));
		expect(result.path).toBe("Long Term/26 W31 Goals.md");
		expect(result.label).toBe("26 W31 Goals");
		expect(result.exact).toBe(true);
		expect(result.duplicates).toEqual(["Long Term/26 W31 Goals 1.md"]);
	});

	it("carries the duplicate through a fallback too", () => {
		// W32 does not exist, so this lands on W31 — the suffixed sibling has to
		// travel with it, not be lost because the answer was a fallback.
		const result = resolveGoalDoc(vault, "week", d(2026, 8, 5));
		expect(result.exact).toBe(false);
		expect(result.duplicates).toEqual(["Long Term/26 W31 Goals 1.md"]);
	});

	const nonPeriods: ReadonlyArray<[label: string, path: string]> = [
		["a week number past 53", "Long Term/26 W99 Goals.md"],
		["week zero", "Long Term/26 W00 Goals.md"],
		["a month past 12", "Long Term/26 M13 Goals.md"],
		["month zero", "Long Term/26 M00 Goals.md"],
	];

	for (const [label, path] of nonPeriods) {
		it(`rejects ${label}`, () => {
			// The filename patterns are loose about spacing and digit count, so
			// the range checks are the only thing keeping a doc that names no
			// real period out of the fallback chain — where it would sort past
			// every genuine doc and be handed back as "the most recent".
			const index = createVaultIndex([path]);
			expect(index.paths).toEqual([path]);
			expect(index.goalDocs.week).toEqual([]);
			expect(index.goalDocs.month).toEqual([]);
		});
	}

	it("reports the fallback distinctly from an exact hit", () => {
		const exact = resolveGoalDoc(vault, "week", d(2026, 8, 16));
		const fallback = resolveGoalDoc(vault, "week", d(2026, 8, 5));
		expect(exact.exact).toBe(true);
		expect(fallback.exact).toBe(false);
		// The caller needs both names to say "no 26 W32 Goals — using 26 W31".
		expect(fallback.requestedLabel).not.toBe(fallback.label);
	});
});

describe("newDailyNotePath", () => {
	it("puts new notes flat in Mise/, not in a YY.MM/ bucket", () => {
		// Rollover into buckets is a manual, drifting operation; writing into
		// one would guess at a boundary that only the user moves.
		expect(newDailyNotePath(d(2026, 8, 15))).toBe("Mise/26.08.15.md");
		expect(newDailyNotePath(d(2026, 12, 1))).toBe("Mise/26.12.01.md");
	});

	it("agrees with what resolveDailyNote looks for", () => {
		const date = d(2026, 8, 16);
		expect(resolveDailyNote(vault, date)?.path).toBe(newDailyNotePath(date));
	});
});

describe("no obsidian dependency", () => {
	it("pulls nothing out of the plugin API, anywhere under src/vault/", () => {
		// The pure core is only pure while nobody reaches for the Obsidian API
		// "just this once". Cheap to assert, expensive to discover later.
		//
		// The forms this has to survive — a subdirectory, a multi-line import, a
		// re-export, a dynamic import, `require` — and the proof that it does,
		// are in `src/testing/purity.ts` and its suite. They live there because
		// all three of these guards had their own copy of the pattern and the
		// copies drifted apart, which is exactly how the weakest of them ended
		// up passing a real impure module.
		const scan = scanForObsidianDependencies(dirname(fileURLToPath(import.meta.url)));
		// Guard the guard: a walk that finds nothing would pass vacuously.
		expect(scan.files.length).toBeGreaterThan(4);
		expect(scan.dependencies).toEqual([]);
	});

	it("resolves against a bare string[] with no runtime at all", () => {
		const tiny = createVaultIndex(["Mise/26.08.16.md"]);
		expect(resolveDailyNote(tiny, d(2026, 8, 16))?.path).toBe(
			"Mise/26.08.16.md",
		);
		expect(resolveDailyNote(tiny, d(2026, 8, 15))).toBeNull();
	});

	it("survives an empty vault", () => {
		const empty = createVaultIndex([]);
		expect(resolveDailyNote(empty, d(2026, 8, 16))).toBeNull();
		expect(resolveMostRecentDailyNoteBefore(empty, d(2026, 8, 16))).toBeNull();
		expect(resolveGoalDoc(empty, "week", d(2026, 8, 16))).toEqual({
			horizon: "week",
			requestedLabel: "26 W33 Goals",
			path: null,
			label: null,
			exact: false,
			duplicates: [],
		});
	});
});
