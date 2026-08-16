# omnifocus-obsidian-integration

Personal automation around an Obsidian vault — planning docs, daily "Mise" notes,
and a local-LLM assistant that runs against [Ollama](https://ollama.com).

Nothing here talks to a cloud model. Vault contents stay on the machine.

## Layout

| Path | What it is |
| --- | --- |
| `docs/` | Design docs and delivery plans |
| `src/` | The Obsidian plugin (`mise-assistant`) |

See `docs/` for the current plan.

## Development

```
npm install
cp .env.example .env      # then set OBSIDIAN_VAULT_PATH to your vault root
npm run dev               # watch-builds into <vault>/.obsidian/plugins/mise-assistant/
```

Enable **Mise Assistant** under Settings → Community plugins, then run
`Mise Assistant: Ping` from the command palette to confirm it loaded.

There is **no CI on this repository yet**. `npm ci`, `npm run typecheck`,
`npm test`, and `npm run build` are what you are expected to run locally before
pushing — nothing enforces them for you, so a red branch stays red until someone
runs them by hand. `npm run build` writes `main.js` to the repo root; it is not
committed.

Unit tests never touch the network. The live smoke test against a real server is
opt-in:

```
OLLAMA_E2E=1 npm test
OLLAMA_E2E=1 OLLAMA_E2E_MODEL=gemma4:e2b npm test
```

## Ollama setup

```
ollama pull gemma4:e4b     # default; use gemma4:e2b on a 16 GB machine
ollama serve
```

Then open **Settings → Mise Assistant**, check the base URL
(`http://127.0.0.1:11434`), pick the model from the dropdown, and press
**Test connection**. `Mise Assistant: Ask raw prompt` sends a prompt with no
vault context and streams the reply back — that is the round trip, by hand.

The plugin sends `num_ctx`, `num_predict` and `keep_alive` on every request
rather than relying on server defaults; the settings tab explains why for each.

## Asking questions about your notes

Click the speech-bubble in the ribbon, or run
`Mise Assistant: Ask a question about my notes`, to open the chat in the right
sidebar. Ask *"What did I say I'd focus on this quarter?"* and the answer is
built from your Life Goals, your current Y+/quarter/month/week goal docs and
your last five daily notes — never from the whole vault.

Three things about that panel are the point of it:

- **Every answer lists the notes it was built from**, under the answer, as links
  that open the note in the main pane. If a file is not in that list it was not
  in the prompt.
- **Gaps are stated, not papered over.** 2026 has no `26 W32 Goals`, so a
  question asked in week 32 is answered from `26 W31 Goals` — and says so, next
  to the answer and on the link itself. The same goes for a note the token
  budget dropped or truncated.
- **The conversation is not saved anywhere.** It lives in the panel and is gone
  when Obsidian restarts. **Save to daily note** appends one exchange — question,
  answer, sources and warnings — under an `## Assistant log` heading in today's
  note, creating that note only if the day has none. Nothing else is ever
  rewritten.

**Cancel** aborts the generation. It genuinely stops a streamed reply; if
streaming was unavailable and the request fell back to a buffered one, the reply
is discarded but the server keeps working on it until it finishes — see below.

You will also see a one-off note when a follow-up could not reuse Ollama's
prompt cache. Follow-ups are normally near-instant because the plugin sends the
same bytes at the top of every request; a very long question can push a document
out of the budget and cost you that, and the panel says so rather than leaving
you with an unexplained forty-second pause.

`Mise Assistant: Show context pack` prints exactly what would be sent, with a
token count per document, if you want to check before trusting an answer.

### Streaming and CORS

Obsidian's renderer origin is `app://obsidian.md`. Obsidian's `requestUrl()` is
not subject to CORS, but it cannot stream, so token-by-token output uses `fetch`
instead. If Ollama rejects that origin, the plugin automatically retries the
same request without streaming through `requestUrl` and tells you it did — the
answer still arrives, just all at once. To get streaming back, allow the origin
on the server:

```
OLLAMA_ORIGINS=app://obsidian.md ollama serve
```

The buffered path is also the reason Cancel is weaker than it looks there:
`requestUrl` takes no abort signal, so a buffered generation cannot be stopped
once it has been issued. The plugin refuses to *start* one after you cancel, and
throws away a reply that arrives after you did — but the server keeps generating
until it finishes or `keep_alive` expires. Streamed replies stop immediately.

### Troubleshooting

- **Do not set `OLLAMA_FLASH_ATTENTION=1`.** Since October 2025 it is a
  three-state override and *unset* means auto-enable wherever the backend
  supports it; forcing `1` turns it on where it is known broken. `0` exists as
  an escape hatch if long prompts hang during prefill.
- **Re-pull if formatting looks wrong.** Google refreshed the Gemma 4 chat
  template on 2026-07-15 with the weights unchanged, fixing tool-calling bugs.
- **`Prompt was truncated`** in a notice means the prompt exceeded `num_ctx` and
  Ollama silently discarded the oldest tokens. Lower the amount you send or
  raise `num_ctx`; the server will not tell you this itself.
