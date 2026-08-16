// The daily-note template as the vault holds it, a note a human wrote from it,
// and a reply of the shape the model gives back.
//
// The template is a fixture rather than a constant in the source, which is the
// point: the plugin parses whatever is at `Mise/xx.xx.xx Mise.md` at run time.
// `ALT_TEMPLATE_TEXT` exists to prove that — it has different headings, a
// different order and a different nesting depth, and the tests assert the
// output follows it. If anyone ever inlines a copy of the headings below into
// the source, that pair of tests is what fails.
//
// Details copied from the real thing on purpose: a level-1 title carrying the
// date placeholder, sections whose scaffolding is an empty checkbox, one that
// is a bare bullet, one with a nested `###` beneath it, and one that is a
// heading with nothing under it at all.

/** `Mise/xx.xx.xx Mise.md`. */
export const TEMPLATE_TEXT = [
	"# xx.xx.xx",
	"",
	"## Intention",
	"",
	"## Today",
	"- [ ] ",
	"",
	"## Schedule",
	"",
	"## Waiting on",
	"- ",
	"",
	"## Notes",
	"",
	"### Threads",
	"",
	"## Tomorrow",
	"- [ ] ",
	"",
].join("\n");

/** A second template shape, to catch any hardcoding of the first one. */
export const ALT_TEMPLATE_TEXT = [
	"---",
	"kind: mise",
	"---",
	"",
	"## Rocks",
	"- [ ] ",
	"",
	"## Admin",
	"",
	"#### Later",
	"",
].join("\n");

/**
 * What the model sends back: the headings copied and most of them filled.
 *
 * `## Schedule` is left empty because the fixture vault says nothing about the
 * day's meetings and the instruction tells it to leave a section empty rather
 * than invent one. The date title is echoed with nothing under it, which is
 * what a model does with a heading it was not asked to write under — it is not
 * in the instruction's list, and a body under it would be dropped.
 */
export const MODEL_REPLY = [
	"# 26.08.16",
	"",
	"## Intention",
	"",
	"Finish the migration rehearsal without letting the invoice slip again.",
	"",
	"## Today",
	"",
	"- [ ] Cutover rehearsal, start to finish",
	"- [ ] Send the invoice",
	"",
	"## Schedule",
	"",
	"## Waiting on",
	"",
	"- Passport renewal confirmation",
	"",
	"## Notes",
	"",
	"Two weeks offline is a 26 Q3 commitment; book it before the cutover eats it.",
	"",
	"### Threads",
	"",
	"- Migration plan (26 W31)",
	"",
	"## Tomorrow",
	"",
	"- [ ] Confirm the trip dates",
	"",
].join("\n");

/**
 * A daily note written by hand from the same template on the same day.
 *
 * The fidelity test asserts a drafted note has exactly this outline, and — fed
 * these bodies as if the model had written them — is exactly these bytes, blank
 * lines included. Spacing is part of "structurally identical to a hand-made
 * one" and an outline comparison cannot see it.
 */
export const HANDMADE_NOTE = [
	"# 26.08.16",
	"",
	"## Intention",
	"",
	"Get the rehearsal done and stop thinking about it.",
	"",
	"## Today",
	"- [x] Cutover rehearsal",
	"- [ ] Invoice",
	"",
	"## Schedule",
	"",
	"09:30 standup",
	"",
	"## Waiting on",
	"- Passport",
	"",
	"## Notes",
	"",
	"Slept badly.",
	"",
	"### Threads",
	"",
	"- Migration plan",
	"",
	"## Tomorrow",
	"- [ ] Book the trip",
	"",
].join("\n");

/**
 * A note the day already has, half written. `## Intention` and `## Today` are
 * the user's and must survive untouched; everything else is still scaffolding.
 */
export const HALF_WRITTEN_NOTE = [
	"# 26.08.16",
	"",
	"## Intention",
	"",
	"Do not touch this line.",
	"",
	"## Today",
	"- [x] Already did the school run",
	"",
	"## Schedule",
	"",
	"## Waiting on",
	"- ",
	"",
	"## Notes",
	"",
	"### Threads",
	"",
	"## Tomorrow",
	"- [ ] ",
	"",
].join("\n");
