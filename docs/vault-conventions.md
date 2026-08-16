# Vault conventions

Facts the plugin has to encode, derived from the live vault layout. The point of
writing these down is that several of them are *irregular* — code that assumes
the tidy version will silently do the wrong thing.

## Daily notes ("Mise")

| Thing | Value |
| --- | --- |
| Template | `Mise/xx.xx.xx Mise.md` |
| Filename | `YY.MM.DD.md` (e.g. `26.08.14.md`) |
| Current notes | flat in `Mise/` |
| Older notes | rolled into `Mise/YY.MM/` folders |
| Deep archive | `Long Term/Archive/YYYY/YY.MM/` |

Gotchas:

- **Month folders are buckets, not date ranges.** `Mise/26.03/` holds
  `26.02.21.md` … `26.02.28.md`; `Mise/26.06/` holds `26.05.28.md`. Rollover is
  manual and the boundary drifts. Resolve a date by *searching* for the basename
  `YY.MM.DD.md`, never by constructing `Mise/YY.MM/YY.MM.DD.md`.
- **Days are skipped.** No `26.08.02`, `26.08.07`, `26.08.15`. "Yesterday's note"
  means *the most recent existing note before date D*, not `D - 1 day`.
- **Duplicate suffixes exist**: `26.07.02 1.md`, `25.01.29 1.md`,
  `25.05.10 1.md`. These are Obsidian's collision suffix. The plugin must check
  for an existing note and open it rather than create a second one.
- The template also has a retired version, `Long Term/Archive/xx.xx.xx Mise Old 24.01.08.md`.
  Ignore it; only the current `Mise/xx.xx.xx Mise.md` is authoritative.

## Long-term planning docs

Live docs sit in `Long Term/`, archived ones in `Long Term/Archive/YYYY/`.

| Horizon | Filename pattern | Template |
| --- | --- | --- |
| Week | `YY Wnn Goals.md` (`26 W33 Goals.md`) | `xx Wxx Goals.md` |
| Month | `YY Mnn Goals.md` (`26 M07 Goals.md`) | `xx Mxx Goals.md` |
| Quarter | `YY Qn Goals.md` (`26 Q3 Goals.md`) | `xx Qx Goals.md` |
| Multi-year | `YY Y+ Goals.md` (`26 Y+ Goals.md`) | `xxY+ Goals.md` |

Gotchas:

- **Week numbers have gaps.** 2026 has W29, W30, W31, W33 — no W32. Same for
  months: `26 M07` exists, `26 M08` does not. Resolution must fall back to the
  most recent *existing* doc at that horizon, and the UI should say which one it
  actually used.
- Week number is ISO-8601 (`26 W33` covers Mon 2026-08-10 → Sun 2026-08-16), so
  the year in the filename can disagree with the calendar year in early January.
  Use ISO week-year, not calendar year.
- Templates are stored beside real notes and share the `xx`/`Wxx` shape. Exclude
  any path whose basename starts with `xx` from context gathering, or the model
  gets fed empty scaffolding.
- Note the spacing inconsistency: `26 Y+ Goals.md` (spaced) vs the template
  `xxY+ Goals.md` (unspaced). Match loosely.

## Stable background context

Rarely-changing docs worth including as standing context:
`Long Term/Life Goals.md`, `Long Term/Getting Unstuck Checklist.md`,
`Long Term/Childcare.md`, `Financial Planning.md`, `Long Term.md`, `The Work.md`.

## Not context

Exclude from any retrieval or stuffing: `zAssets/`, `Pasted image *.png`,
`Untitled*.md`, `Welcome.md`, `Notes/Archive/`, and everything under
`*/Archive/` unless the user explicitly asks for history.

## Scale

822 files / 44 directories. Whole-vault stuffing is not on the table; see the
context budget in `plan.md`.
