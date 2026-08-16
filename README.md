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

`npm run typecheck`, `npm test`, and `npm run build` are what CI runs.
`npm run build` writes `main.js` to the repo root; it is not committed.

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
