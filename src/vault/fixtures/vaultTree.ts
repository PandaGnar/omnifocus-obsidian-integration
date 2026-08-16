// A miniature of the real vault, kept deliberately irregular. Every oddity
// below is copied from `docs/vault-conventions.md` and exists to make a
// specific class of naive implementation fail:
//
//   - `Mise/26.03/26.02.21.md`      month folders are buckets, not date ranges
//   - `Mise/26.06/26.05.28.md`      ditto, across a different boundary
//   - no 26.08.02 / .07 / .15       days are skipped
//   - `26.07.02 1.md` and friends   Obsidian collision suffixes
//   - W29 W30 W31 _ W33             a missing week, and no `26 M08`
//   - `26 W53 Goals.md`             ISO week-year 2026 runs into Jan 2027
//   - `26 Y+ Goals.md` vs `xxY+`    spaced live doc, unspaced template
//   - `Long Term/Archive/2025/…`    history that must not be resolved to
//
// The order of this array is intentionally *not* sorted: Obsidian hands files
// over in its own order, and the index has to be stable regardless.

export const VAULT_TREE: readonly string[] = [
	// --- daily notes, flat in Mise/ ---------------------------------------
	"Mise/26.08.16.md",
	"Mise/26.08.14.md", // 26.08.15 is missing
	"Mise/26.08.13.md",
	"Mise/26.08.12.md",
	"Mise/26.08.11.md",
	"Mise/26.08.10.md",
	"Mise/26.08.09.md",
	"Mise/26.08.08.md", // 26.08.07 is missing
	"Mise/26.08.06.md",
	"Mise/26.08.05.md",
	"Mise/26.08.04.md",
	"Mise/26.08.03.md", // 26.08.02 is missing
	"Mise/26.08.01.md",
	"Mise/xx.xx.xx Mise.md", // template, must never be resolved to

	// --- daily notes rolled into YY.MM/ buckets ---------------------------
	"Mise/26.07/26.07.31.md",
	"Mise/26.07/26.07.02.md",
	"Mise/26.07/26.07.02 1.md", // collision suffix; the plain file must win
	"Mise/26.07/26.07.01.md",
	"Mise/26.06/26.06.01.md",
	"Mise/26.06/26.05.28.md", // May note filed under 26.06/
	"Mise/26.03/26.03.01.md",
	"Mise/26.03/26.02.28.md", // February notes filed under 26.03/
	"Mise/26.03/26.02.21.md",
	"Mise/25.05/25.05.10.md",
	"Mise/25.05/25.05.10 1.md",
	"Mise/25.01/25.01.29 1.md", // suffixed copy listed *before* the original
	"Mise/25.01/25.01.29.md",

	// --- long-term planning docs ------------------------------------------
	"Long Term/26 W53 Goals.md", // ISO week 53 of week-year 2026
	"Long Term/26 W33 Goals.md",
	"Long Term/26 W31 Goals.md", // no 26 W32
	"Long Term/26 W30 Goals.md",
	"Long Term/26 W29 Goals.md",
	"Long Term/26 M07 Goals.md", // no 26 M08
	"Long Term/26 M06 Goals.md",
	"Long Term/25 M12 Goals.md", // fallback target across a year boundary
	"Long Term/26 Q3 Goals.md",
	"Long Term/26 Q2 Goals.md",
	"Long Term/26 Y+ Goals.md", // spaced, unlike its template
	"Long Term/25 Y+ Goals.md",

	// --- templates, stored beside the real notes --------------------------
	"Long Term/xx Wxx Goals.md",
	"Long Term/xx Mxx Goals.md",
	"Long Term/xx Qx Goals.md",
	"Long Term/xxY+ Goals.md", // unspaced
	"Long Term/xx.xx.xx Needs Assessment.md",

	// --- archives, excluded unless a caller asks for history --------------
	"Long Term/Archive/2025/25.12/25.12.31.md",
	"Long Term/Archive/2025/25 W52 Goals.md",
	"Long Term/Archive/2025/25 Q4 Goals.md",
	"Long Term/Archive/xx.xx.xx Mise Old 24.01.08.md",
	"Notes/Archive/Some old note.md",

	// --- standing context and ordinary notes -------------------------------
	"Long Term/Life Goals.md",
	"Long Term/Getting Unstuck Checklist.md",
	"Long Term/Childcare.md",
	"Financial Planning.md",
	"Long Term.md",
	"The Work.md",

	// --- never context ------------------------------------------------------
	"zAssets/Pasted image 20260101120000.png",
	"zAssets/diagram.md",
	"Pasted image 20260814093000.png",
	"Untitled.md",
	"Untitled 1.md",
	"Welcome.md",
	".obsidian/plugins/mise-assistant/main.js",
	".trash/26.08.15.md", // deleted; must not resurrect a skipped day
];
