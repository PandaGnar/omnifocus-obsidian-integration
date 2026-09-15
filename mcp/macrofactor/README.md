# MacroFactor MCP server

Gives an MCP client (Claude Code, Claude Desktop) read access to your MacroFactor data.

MacroFactor has no API, and the app is phone-only. The one community project that
reached its backend directly stopped working in May 2026 when MacroFactor locked it
down. What remains is the data MacroFactor lets out on its own: CSV exports, and the
numbers it writes to Apple Health. This server reads CSV files from a folder. Getting
files into that folder is the part you set up once, below.

The server knows nothing about MacroFactor's column names. It finds the date column,
filters by date, and hands rows to the client as they are. So it also reads any other
CSV you drop in the folder, and it won't break when MacroFactor renames a column.

It is read-only. Nothing can write into MacroFactor from outside.

## Requirements

macOS and Node 20+. No MacroFactor login: the server never talks to MacroFactor.

## Set up the folder

By default the server reads `~/Library/Mobile Documents/com~apple~CloudDocs/MacroFactor`,
which is a `MacroFactor` folder in iCloud Drive. Create it, or pass another folder as
the first argument when you register the server.

If you use iCloud Drive, right-click the folder in Finder and choose **Keep Downloaded**.
iCloud otherwise evicts files it thinks you don't need, and an evicted file is invisible
to the server.

### Route A: CSV export (everything, but manual)

In MacroFactor, tap **More**, then **Data Export**. Quick Export gives one file with
expenditure, weight, calories, macros and targets over a date range. Granular Export
lets you pick datasets, such as the food log. MacroFactor emails the files, as CSV,
within minutes to hours. Save them into the folder. Unzip first if they come zipped.

Data is only as fresh as your last export. Good for weekly reviews.

### Route B: Apple Health via a Shortcut (daily, but only the basics)

MacroFactor writes dietary energy, protein, carbohydrates, fat and weight to Apple Health
when syncing is on (More, Integrations). An iPhone Shortcut can copy those into the
folder every night. Written from Apple's documentation, not tested here:

1. In Shortcuts, add **Find Health Samples** for Dietary Energy, filtered to Start Date
   is in the last 2 days, grouped by Day. Repeat for Protein, Carbohydrates, Total Fat
   and Weight.
2. After each, add **Repeat with Each** over the samples and build a **Text** line:
   `metric,date,value`, using the sample's start date and value. Collect the lines.
3. Add **Append to Text File** into `MacroFactor/health.csv` in iCloud Drive. Put a
   header line `metric,date,value` in the file once, by hand.
4. Add a personal automation to run it daily, say at 23:55.

Later runs append again, so a day can appear more than once. The newest row is the
right one.

If other apps also write nutrition to Health, their samples are included too.

## Run it

```sh
npm install && npm run build
claude mcp add -s user macrofactor -- node "$PWD/dist/src/index.js"
```

Add a folder path after the script path to read somewhere other than iCloud Drive. For
Claude Desktop, add the same command to `claude_desktop_config.json`, as described in
`../omnifocus/README.md`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_exports` | Every CSV in the folder, with its headers, row count and the dates it covers |
| `read_rows` | Rows from one file, optionally between two dates, up to a limit |

Call `list_exports` first: that is where the column names come from.

`read_rows` returns `{ items, hitLimit, dateColumn, skipped }`. `hitLimit` is true when
the limit clipped the answer. `skipped` counts rows dropped because their date could not
be read; a non-zero value with a date range means the date column guess was wrong.

The date column is the first header containing "date", otherwise the first column whose
values look like dates. Dates are compared as calendar days in the Mac's time zone.

## Tests

```sh
npm test
```

Covers the CSV parser (quoted commas, doubled quotes, BOM, CRLF), date parsing, date
column detection and the file tools against a temporary folder.
