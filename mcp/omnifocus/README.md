# OmniFocus MCP server

Gives an MCP client (Claude Code, Claude Desktop) read and write access to OmniFocus:
find tasks, capture new ones, edit and complete them.

## Requirements

macOS, Node 20+, and **OmniFocus Pro** with the app running. Omni Automation is a Pro
feature. The first call raises a macOS permission prompt — allow your MCP client to
control OmniFocus.

## Install

```sh
npm install && npm run build
claude mcp add omnifocus -- node "$PWD/dist/src/index.js"
```

For Claude Desktop, add to `claude_desktop_config.json` instead:

```json
{ "mcpServers": { "omnifocus": { "command": "node", "args": ["/absolute/path/to/dist/src/index.js"] } } }
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_tasks` | Filter by project, tag, flag, due date, availability, or text; or fetch one task by id |
| `add_task` | Create a task; no project means the inbox |
| `update_task` | Edit fields, move between projects, complete, or drop |
| `list_projects` | Projects with folder and status |
| `add_project` | Create a project, optionally in a folder |
| `list_tags` | Every tag, with its parent |

Notes longer than 500 characters come back cut and marked `noteTruncated`. Writing
a note replaces it, so read the whole one first — `list_tasks { id, fullNote: true }`.

There is no delete tool. `update_task { dropped: true }` is the reversible equivalent;
un-dropping is done in OmniFocus itself.

Dates are ISO 8601. A bare `2026-09-14` means end of that day for a due date and the
start of it for a defer date.

## How it works

Each call runs one Omni Automation (omnijs) snippet inside OmniFocus:

```
node --> osascript -l JavaScript --> Application('OmniFocus').evaluateJavascript(snippet) --> JSON
```

Arguments are embedded in the snippet as a JSON literal, so nothing needs shell quoting.
`src/omni.ts` holds the snippets, `src/bridge.ts` runs them, `src/index.ts` maps them to
tools.

The alternatives were the `omnifocus://` URL scheme (can't return data), the AppleScript
dictionary (clunkier, equally Pro-only), and reading OmniFocus's SQLite cache (fast, but
undocumented and read-only).

Costs of this approach: one process per call (~0.3s), so `list_tasks` defaults to 50
results and truncates notes to 500 characters. Nothing is cached — every answer is the
live database.

## Tests

```sh
npm test
```

Covers date handling, argument escaping, and that every snippet parses. The snippets are
not executed — that needs a Mac running OmniFocus, so test changes there by hand:

```sh
npx @modelcontextprotocol/inspector node dist/src/index.js
```
