#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { listExports, readRows } from "./exports.js";

/** Where the CSV files live: the first argument, or a MacroFactor folder in iCloud Drive. */
const dir = process.argv[2] ?? join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/MacroFactor");

const server = new McpServer({ name: "macrofactor", version: "0.1.0" });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const reply = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

server.registerTool("list_exports", {
  description: "List the MacroFactor CSV files in the folder, with each file's column headers and the dates it covers. Call this first to learn what data exists and what the columns are called.",
  inputSchema: {},
}, async () => reply(await listExports(dir)));

server.registerTool("read_rows", {
  description: "Read rows from one exported file, optionally within a date range. Rows are returned as they are in the file, so use the headers from list_exports to read them. `skipped` counts rows dropped because their date could not be read.",
  inputSchema: {
    file: z.string().min(1).describe("A file name from list_exports."),
    from: day.optional().describe("First day to include."),
    to: day.optional().describe("Last day to include."),
    limit: z.number().int().positive().default(200),
  },
}, async (args) => reply(await readRows(dir, args)));

server.connect(new StdioServerTransport()).catch((err) => {
  console.error(err);
  process.exit(1);
});
