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
- Request options plumbed through from settings — see *Runtime tuning* below for
  the defaults and, more importantly, for the three decisions that are not
  configurable: `requestUrl` over `fetch`, `/api/chat` over `/v1`, and an
  explicit `num_ctx` on every request.
- **Truncation detector**: compare the response's `prompt_eval_count` against the
  token count we believe we sent. If it comes back pinned at `num_ctx`, the
  prompt was silently truncated — surface that in the UI rather than letting it
  pass. This is cheap and no surveyed plugin does it.

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

- Assemble a **context pack**, ordered strictly most-stable → least-stable:
  system prompt → Life Goals → Y+ → Q → M → W → last *N* daily notes →
  conversation → today's date → the question.
- Hard token budget with per-document caps and a deterministic drop order.
- A `Mise: show context pack` command renders exactly what would be sent, with a
  per-document token count.

**Done when:** the pack is inspectable in Obsidian and provably under budget for
the real vault, and byte-identical across two runs with the same inputs.

That last property is not tidiness — it is the performance feature. See
*Prompt-cache ordering* below.

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

---

## Model choice

**Gemma 4 E2B is real** — released 2026-04-02, Apache 2.0, and it is the current
generation's successor to Gemma 3n's E2B. It is not a misremembering of 3n.

| | `gemma4:e2b` | `gemma4:e4b` | `gemma4:12b` |
| --- | --- | --- | --- |
| Effective params | 2.3B (~5.1B with embeddings) | ~4B | 12B dense |
| Ollama download | 7.2 GB | 9.6 GB | larger |
| Context | 128K | 128K | 128K |
| Use when | ≤16 GB RAM | **default** | ≥32 GB unified / 24 GB VRAM |

**Default to `gemma4:e4b`**, fall back to `e2b` on a 16 GB machine. E2B answers
the question as asked — it will work — but this workload is instruction-following
plus structured markdown generation, which is exactly where an extra 2B of
effective parameters shows up. E4B is the better trade if the machine allows.

Avoid `gemma4:26b` and `gemma4:31b` here: the 31B dense has an open
structured-JSON repetition-loop bug ([#15502]), which is precisely the
"fill in the template" workload of PR 6.

The 7.2 GB weight for a "2B" model is not a mistake — Per-Layer Embeddings plus
the vision and audio towers dominate the file size.

### The important caveat

The 128K context is a **memory-safety ceiling, not a working set**. Multi-needle
retrieval evaluations find every long-context model degrades as input grows, and
"lost in the middle" is still real in 2026. A 2.3B-effective model given 40K
tokens will not reliably use the middle of it. This is the actual argument for
the bounded context pack in PR 4 — the budget is there for answer quality, and
the speed win is a bonus.

## Runtime tuning

The user's "Ollama gets slow with a lot of context" is a **prefill** problem, not
a decode problem. Decode on E2B/E4B is fine. Time-to-first-token on a cold 40K
prompt is what hurts. So the fix is, in priority order: send less (PR 4), order
it so it caches (below), and only then tune flags.

### Flash attention — do not set it

`OLLAMA_FLASH_ATTENTION` stopped being an opt-in boolean in October 2025. It is
now a three-state override, and **unset means auto-enable wherever the backend
and architecture support it**. Forcing `1` turns it on even where it is known
broken. So: leave it unset, and expose `0` only as a documented escape hatch.

Two reasons that escape hatch has to exist:

- Flash attention has an **architecture allowlist**; `gemma4` was not in the
  initial list and was added later ([#13337], PR #15296).
- Gemma 4 plus flash attention plus long prompts produced **indefinite prefill
  hangs** on the 26B/31B models ([#15350], [#15368], fixed by PR #15378). Root
  cause was the hybrid attention mixing head dimensions across sliding-window and
  global layers. Whether E2B/E4B were ever affected is *unverified* — the issues
  only tested the large variants — but our prompts are long, so the setting
  belongs in the troubleshooting docs.

Gemma 4 uses interleaved local sliding-window (512 tokens) and global attention,
4:1 on E2B. In principle that makes the KV cache far cheaper than a linear
`num_ctx` scaling would suggest. **Whether Ollama actually implements the
sliding-window cache trim for `gemma4` is unverified** — PR 7's benchmark should
measure memory at 8K vs 32K and find out rather than assume.

### KV cache quantisation — measure before enabling

`OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves KV memory. But it **requires flash
attention**, and when FA is auto-disabled underneath it, older builds panicked
and newer ones fall back to f16 silently — which quietly invalidates whatever
memory budget you sized against ([#15043], [#13337]). Leave it at `f16` until
the PR 7 benchmark shows we need the memory.

### Settings

| Setting | Value | Why |
| --- | --- | --- |
| `num_ctx` (per request) | `32768` | **Send explicitly on every request.** See below. |
| `num_predict` | `2048` | Default is `-1`, i.e. unbounded. |
| `keep_alive` | `-1` or `30m` | Default 5 min. **Model unload destroys the prompt cache.** For a plugin idle between turns this is the difference between a sub-second and a 40-second follow-up. |
| `OLLAMA_NUM_PARALLEL` | `1` | Memory scales as parallel × context. |
| `repeat_penalty` | default | Do not raise it to fight repetition loops; it did nothing for [#15502]. |

**Never trust the default context length.** Four official Ollama sources
currently disagree about what it is — `envconfig` says `0`/auto-by-VRAM,
`context-length.mdx` gives VRAM tiers, the FAQ says 4096, and `modelfile.mdx`
still says 2048. Treat Ollama's docs as lagging and always send `num_ctx`.

**The failure this prevents is silent.** When a prompt exceeds `num_ctx`, the
runtime keeps the newest tokens and drops the oldest with no error and no
warning — decapitating exactly the stable goal docs we put at the top. Hence the
`prompt_eval_count` check in PR 2.

### Two client decisions that are not settings

- **Use Obsidian's `requestUrl()`, not `fetch()`.** Obsidian's origin is
  `app://obsidian.md` and Ollama will CORS-reject it. `requestUrl` bypasses CORS
  entirely, so users never have to set `OLLAMA_ORIGINS` or run `launchctl setenv`.
- **Use `/api/chat`, not `/v1/chat/completions`.** The OpenAI-compat shim has a
  Gemma 4 streaming bug where content lands in `reasoning` with `content` blank
  ([#15368]). The native endpoint is unaffected.

Also worth putting in the README: Google refreshed the Gemma 4 chat template on
2026-07-15 (weights unchanged) fixing tool-calling bugs, so users on an old pull
should re-pull.

### Prompt-cache ordering

Ollama reuses the KV cache across requests by **longest common prefix**. If a
follow-up question shares a prefix with the previous request and the model is
still loaded, only the new tail is prefilled. This is the single
highest-leverage design decision in the plugin, and it is why PR 4's ordering is
a hard requirement rather than a preference.

What invalidates the cache, all of which PR 4 must avoid:

- **Any byte change in the prefix.** Critically: **no dates or "today is…" near
  the top of the prompt.** Put the current date immediately before the question.
- **Non-deterministic serialisation.** Sort the file list; never iterate a `Map`
  or a raw directory listing whose order can shift.
- **Model unload** — hence `keep_alive`.
- **CPU-only backends**, where prefix cache reuse is reportedly broken outright
  ([#14780], appears still open). If `ollama ps` shows no GPU, none of this
  helps and the plugin should keep prompts small and say so.

## Out of scope for now

OmniFocus sync (despite the repo name), mobile, and any cloud model.

**Embeddings/RAG stays out of scope too, but the seam is designed in.** For daily
planning and goal Q&A, the documents that matter are a small, *enumerable* set —
current W/M/Q/Y+ goals, Life Goals, recent dailies — roughly 6–9K tokens. That is
retrieval by naming the file, and it beats semantic search on precision. RAG only
becomes necessary for open-ended questions across all 822 files.

So PR 4 reserves a slot for retrieved chunks **after** the stable block and
before the question — inserting them mid-prefix would invalidate the cache
downstream. When we do build it, the notes from the survey: `qwen3-embedding:0.6b`
(32K embedding context, ~639 MB) over `nomic-embed-text`; chunk by heading
hierarchy rather than fixed windows, prepending the file path and heading
breadcrumb to each chunk; and consider a BM25 leg for day-one retrieval before
any index exists.

## Prior art

"Chat with my vault" is solved several times over — Smart Connections
(block-level structure-aware chunking, in-process ONNX embeddings, no API key),
Obsidian Copilot (chat sidebar, documented local-Ollama setup), Smart Composer,
Local GPT, RAG Chat (BM25, no model, no network). Worth borrowing: Smart
Connections' chunking strategy and its in-vault `.smart-env/` storage pattern.

The gap this project actually fills is **goal-grounded generation** — drafting a
structured daily plan from long-term goal docs — rather than retrieval-chat. That
is a different prompt shape, and it is the one that benefits most from the
stable-prefix caching above.

[#13337]: https://github.com/ollama/ollama/issues/13337
[#14780]: https://github.com/ollama/ollama/issues/14780
[#15043]: https://github.com/ollama/ollama/issues/15043
[#15350]: https://github.com/ollama/ollama/issues/15350
[#15368]: https://github.com/ollama/ollama/issues/15368
[#15502]: https://github.com/ollama/ollama/issues/15502
