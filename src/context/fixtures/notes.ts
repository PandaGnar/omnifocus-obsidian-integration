// Note *contents* for the fixture vault in `src/vault/fixtures/vaultTree.ts`,
// which only ever held paths. Short, but shaped like the real thing: headings,
// checklists, and the odd em dash so the non-ASCII branch of the estimator is
// exercised by ordinary input rather than only by a contrived test.
//
// Stored as an array of pairs rather than a Record so that nothing in the test
// suite is tempted to iterate an object's keys — the production code is under
// orders not to, and fixtures that model the bad habit teach it.

export const NOTE_CONTENTS: readonly (readonly [path: string, content: string])[] = [
	[
		"Long Term/Life Goals.md",
		[
			"# Life goals",
			"",
			"- Be present for the kids while they still want me around.",
			"- Do work that is legible to me in ten years.",
			"- Stay solvent enough that money is never the reason for a decision.",
		].join("\n"),
	],
	[
		"Long Term/Getting Unstuck Checklist.md",
		[
			"# Getting unstuck",
			"",
			"1. Name the next physical action.",
			"2. Ask whether it is actually blocked or merely unpleasant.",
			"3. Cut the scope in half — twice if necessary.",
		].join("\n"),
	],
	[
		"Long Term/Childcare.md",
		["# Childcare", "", "Pickup is 16:30. Wednesdays are the swap day."].join("\n"),
	],
	[
		"Financial Planning.md",
		["# Financial planning", "", "Runway target: twelve months of fixed costs."].join("\n"),
	],
	["Long Term.md", ["# Long term", "", "The index note. Links out, holds little."].join("\n")],
	[
		"The Work.md",
		["# The work", "", "What the job is for, as opposed to what it consists of."].join("\n"),
	],
	[
		"Long Term/26 Y+ Goals.md",
		["# 26 Y+", "", "- Ship the thing.", "- Keep the ability to leave."].join("\n"),
	],
	[
		"Long Term/26 Q3 Goals.md",
		["# 26 Q3", "", "- Finish the migration.", "- Two weeks entirely offline."].join("\n"),
	],
	[
		"Long Term/26 M07 Goals.md",
		["# 26 M07", "", "- Migration cutover.", "- Book the trip."].join("\n"),
	],
	[
		"Long Term/26 W33 Goals.md",
		["# 26 W33", "", "- [ ] Cutover rehearsal", "- [ ] Invoice", "- [x] Dentist"].join("\n"),
	],
	[
		"Long Term/26 W31 Goals.md",
		["# 26 W31", "", "- [ ] Draft the migration plan", "- [x] Renew the passport"].join("\n"),
	],
	["Mise/26.08.14.md", ["# 26.08.14", "", "## Done", "- Migration dry run"].join("\n")],
	["Mise/26.08.13.md", ["# 26.08.13", "", "## Done", "- Invoiced"].join("\n")],
	["Mise/26.08.12.md", ["# 26.08.12", "", "## Done", "- Nothing worth the ink"].join("\n")],
	["Mise/26.08.11.md", ["# 26.08.11", "", "## Done", "- Dentist"].join("\n")],
	["Mise/26.08.10.md", ["# 26.08.10", "", "## Done", "- Planned the week"].join("\n")],
	["Mise/26.08.09.md", ["# 26.08.09", "", "## Done", "- Rest"].join("\n")],
	["Mise/26.08.08.md", ["# 26.08.08", "", "## Done", "- Rest"].join("\n")],
	["Mise/26.08.06.md", ["# 26.08.06", "", "## Done", "- Long meeting"].join("\n")],
	["Mise/26.08.05.md", ["# 26.08.05", "", "## Done", "- Wrote the brief"].join("\n")],
	["Mise/26.08.04.md", ["# 26.08.04", "", "## Done", "- Read the brief"].join("\n")],
	["Mise/26.08.03.md", ["# 26.08.03", "", "## Done", "- Back from leave"].join("\n")],
	["Mise/26.08.01.md", ["# 26.08.01", "", "## Done", "- Leave"].join("\n")],

	// July, which is where the collision suffixes live. The suffixed copy says
	// something different from the original on purpose: if the wrong one wins,
	// or if which one wins depends on the order Obsidian listed the vault in,
	// the prompt changes and the test that permutes the path array notices.
	[
		"Mise/26.07/26.07.02.md",
		["# 26.07.02", "", "## Done", "- The note I actually wrote in"].join("\n"),
	],
	[
		"Mise/26.07/26.07.02 1.md",
		["# 26.07.02", "", "## Done", "- The accidental second copy"].join("\n"),
	],
	["Mise/26.07/26.07.01.md", ["# 26.07.01", "", "## Done", "- Quarter kickoff"].join("\n")],
	["Mise/26.06/26.06.01.md", ["# 26.06.01", "", "## Done", "- Nothing"].join("\n")],
	["Mise/26.06/26.05.28.md", ["# 26.05.28", "", "## Done", "- Misfiled, but real"].join("\n")],
	["Mise/26.03/26.03.01.md", ["# 26.03.01", "", "## Done", "- March"].join("\n")],
];

/** Reader over the fixture contents. Rejects for anything it does not have. */
export function fixtureReader(
	overrides: readonly (readonly [string, string])[] = [],
): (path: string) => Promise<string> {
	const all = [...NOTE_CONTENTS, ...overrides];
	return (path: string) => {
		// Last match wins, so an override can replace a fixture note.
		for (let i = all.length - 1; i >= 0; i -= 1) {
			const entry = all[i] as readonly [string, string];
			if (entry[0] === path) return Promise.resolve(entry[1]);
		}
		return Promise.reject(new Error(`fixture has no content for ${path}`));
	};
}
