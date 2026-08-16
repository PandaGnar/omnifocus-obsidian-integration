# Obsidian × Ollama planning assistant — delivery plan

A local-only Obsidian plugin that reads the long-term planning docs, answers
questions about them, and drafts the daily Mise note.

Vault-specific filename rules live in [`vault-conventions.md`](./vault-conventions.md).
Read that first — several of the conventions are irregular.

## Principles

1. **Installable before it is clever.** PR 1 produces a plugin that loads in
   Obsidian and does almost nothing. Every later PR is verifiable by hand in the
   real vault.
2. **Pure core, thin shell.** Date maths, note resolution, and prompt assembly
   are pure functions over an injected file-list interface — unit-testable with
   zero Obsidian runtime. The Obsidian API surface stays a thin adapter.
3. **Never destructive.** The plugin proposes; the user commits. No write path
   overwrites an existing note.
4. **Bounded context by construction.** Speed problems are prevented by sending
   less, not by tuning flags. Flags are the second lever.

---

## PR 1 — Skeleton that installs

Goal: `main.js` builds, the plugin loads, one no-op command appears.

- TypeScript + esbuild, `manifest.json`, `versions.json`.
- `npm run dev` watch-builds straight into
  `<vault>/.obsidian/plugins/mise-assistant/` via a gitignored `.env` vault path.
- Vitest wired up with one trivial passing test.
- CI: typecheck + test + build on push.

**Done when:** plugin toggles on in Obsidian's Community Plugins pane, and
`Mise: ping` shows a notice. No Ollama involvement yet.

## PR 2 — Ollama client + settings

Goal: prove the round trip to the local model, in isolation from the vault.

- Typed client for `/api/tags`, `/api/chat` (streaming), `/api/show`.
- Settings tab: base URL, model dropdown populated from `/api/tags`, and a
  **Test connection** button reporting model + latency.
- Streaming with an `AbortController` so a slow generation can be cancelled.
- Request options plumbed through from settings — context length, keep-alive,
  and cache settings. Exact defaults are pending the runtime research below.

**Done when:** Test connection reports a real model, and `Mise: ask raw` streams
a reply into a notice. Unit tests mock `fetch`; one live smoke test runs only
when `OLLAMA_E2E=1`.

## PR 3 — Vault resolver (pure)

The highest-value test surface in the project, and it needs no Obsidian at all.

- `resolveDailyNote(date)` → path, honouring flat-vs-`YY.MM/` placement.
- `resolveMostRecentDailyNoteBefore(date)` → handles skipped days.
- `resolveGoalDoc(horizon, date)` → current W/M/Q/Y+ with fallback to the most
  recent existing doc, returning *which* doc it settled on.
- ISO week-year handling, template exclusion (`xx*`), archive exclusion.

**Done when:** a fixture tree mirroring the real vault (including the W32 gap,
the `26.03/26.02.21.md` misfiling, and the `26.07.02 1.md` duplicate) passes a
table-driven test suite. No UI yet.

## PR 4 — Context pack + budget

- Assemble a **context pack**: Life Goals → Y+ → Q → M → W → last *N* daily
  notes → today's partial note.
- Hard token budget with per-document caps and a deterministic drop order.
- A `Mise: show context pack` command renders exactly what would be sent, with a
  per-document token count.

**Done when:** the pack is inspectable in Obsidian and provably under budget for
the real vault. Ordering is stable across runs — this matters for prompt cache
reuse (see below).

## PR 5 — Ask questions

- Right-sidebar chat view, streaming tokens, cancel button.
- Every answer footer lists the notes that were in context, as clickable links.
- Conversation is ephemeral; a "save to note" action appends to the daily note.

**Done when:** "What did I say I'd focus on this quarter?" returns an answer
grounded in `26 Q3 Goals.md`, with that file listed as a source.

## PR 6 — Draft the daily note

The actual point of the project.

- `Mise: draft today` / `Mise: draft tomorrow`.
- Copies `Mise/xx.xx.xx Mise.md`, fills sections from the context pack.
- **Diff preview modal before writing.** Accept / edit / discard.
- Refuses to clobber: if the note exists, offers to open it or to fill only
  empty sections.
- Section-aware — the model fills the template's headings rather than
  free-writing a document, so the output stays structurally identical to the
  last 800 daily notes.

**Done when:** running it on a day with no note produces a note that is
structurally identical to a hand-made one, and running it twice is a no-op.

## PR 7 — Benchmark + tuning harness

- A script that times prefill and decode at 2k / 8k / 16k / 32k context against
  the configured model, printing tokens/sec for each.
- Results table committed to `docs/benchmarks.md` so tuning changes are
  evidence-based rather than folklore.

**Done when:** there are real numbers from the user's own machine backing the
defaults chosen in PR 2.

---

## Out of scope for now

OmniFocus sync (despite the repo name), embeddings/RAG, mobile, and any cloud
model. Each is a later plan, not a later PR in this one.

---

## Open: model choice and runtime tuning

Two questions are still being researched and will be appended to this document
before the PR leaves draft:

- **Which local model**, including whether "Gemma 4 E2B" is a real, currently
  available model or a misremembering of Gemma 3n's E2B/E4B variants.
- **Which Ollama knobs actually address the slow-with-long-context problem** —
  flash attention, KV cache quantisation, context length defaults, and whether
  prompt-cache reuse should dictate the ordering of the context pack in PR 4.

Until those land, PR 1 and PR 3 are unblocked: neither touches the model.
