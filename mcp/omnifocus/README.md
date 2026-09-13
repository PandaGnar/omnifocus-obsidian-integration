# OmniFocus MCP server

Gives an MCP client (Claude Code, Claude Desktop) read and write access to OmniFocus:
find tasks, capture new ones, edit and complete them.

## Requirements

macOS, Node 20+, and **OmniFocus Pro** with the app running. Omni Automation is a Pro
feature. The first call raises a macOS permission prompt — allow your MCP client to
control OmniFocus.

## Run it

Build first — the server runs from `dist/`, not from the TypeScript:

```sh
npm install && npm run build
```

Then register it with a client. For Claude Code:

```sh
claude mcp add -s user omnifocus -- node "$PWD/dist/src/index.js"
```

`-s user` makes it available in every project rather than just this one, which is
usually what you want for a personal task manager. The path must be absolute: the
server is launched by command, from wherever the client happens to be.

For Claude Desktop, add this to
`~/Library/Application Support/Claude/claude_desktop_config.json` and restart the app,
which only reads that file at launch:

```json
{ "mcpServers": { "omnifocus": { "command": "node", "args": ["/absolute/path/to/dist/src/index.js"] } } }
```

Check it connected with `/mcp` in Claude Code — six tools should appear under
`omnifocus`. Then ask for something read-only, like what's in your inbox: the first real
call raises the macOS automation prompt, and nothing works until you allow it.

### When it doesn't work

Test the OmniFocus side on its own, without the server in the way:

```sh
osascript -l JavaScript -e "Application('OmniFocus').evaluateJavascript('flattenedProjects.length.toString()')"
```

A number means OmniFocus is reachable and the problem is in how the client launches the
server — usually a wrong path or a missing `npm run build`. An error means the app is
closed, automation is blocked, or the copy of OmniFocus isn't Pro; the message says
which.

To poke at the tools directly, without a client:

```sh
npx @modelcontextprotocol/inspector node dist/src/index.js
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

The three list tools return `{ items, hitLimit }`. `hitLimit` is true when the limit was
reached, so a clipped answer can't be mistaken for a complete one.

`update_task` takes a `taskName` alongside the id. It shows you which task is about to
change in the confirmation prompt, and the call is rejected if it doesn't match the task
the id points at.

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
never executed — that needs a Mac running OmniFocus, so changes there are checked by
hand with the inspector above.
