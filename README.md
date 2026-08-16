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

`OBSIDIAN_VAULT_PATH` may be absolute or start with `~`, which expands to your
home directory.

Enable **Mise Assistant** under Settings → Community plugins, then run
`Mise Assistant: Ping` from the command palette to confirm it loaded.

`npm run typecheck`, `npm test`, and `npm run build` are what CI runs.
`npm run build` writes `main.js` to the repo root; it is not committed.
