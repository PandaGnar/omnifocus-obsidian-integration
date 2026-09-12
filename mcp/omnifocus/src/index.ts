#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as of from "./omni.js";

const server = new McpServer({ name: "omnifocus", version: "0.1.0" });

const dateHelp =
  'ISO 8601, e.g. "2026-09-14" or "2026-09-14T17:00". A bare date means end of day for due dates, start of day for defer dates.';

/** Fields shared by add_task and update_task. */
const taskFields = {
  note: z.string().optional(),
  tags: z.array(z.string()).optional().describe("Replaces the task's tags. Tags that don't exist are created."),
  due: z.string().nullable().optional().describe(dateHelp),
  defer: z.string().nullable().optional().describe(dateHelp),
  flagged: z.boolean().optional(),
  estimatedMinutes: z.number().int().positive().optional(),
};

/** Tool arguments arrive with date strings; snippets want epoch millis. */
function prepare(args: Record<string, unknown>) {
  return {
    ...args,
    due: of.toEpoch(args.due as string | null | undefined, "due"),
    defer: of.toEpoch(args.defer as string | null | undefined, "defer"),
    dueBefore: of.toEpoch(args.dueBefore as string | undefined, "due"),
  };
}

const reply = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

server.registerTool("list_tasks", {
  description: "Find tasks in the inbox and in projects. Notes are truncated to 500 characters.",
  inputSchema: {
    project: z.string().optional().describe("Only tasks in this project, by exact name."),
    tag: z.string().optional(),
    flagged: z.boolean().optional(),
    available: z.boolean().optional().describe("Only tasks you could work on now (not blocked or deferred)."),
    dueBefore: z.string().optional().describe(dateHelp),
    search: z.string().optional().describe("Case-insensitive match on name and note."),
    includeCompleted: z.boolean().optional(),
    limit: z.number().int().positive().default(50),
  },
}, async (args) => reply(await of.listTasks(prepare(args))));

server.registerTool("add_task", {
  description: "Create a task. Without a project it lands in the inbox.",
  inputSchema: {
    name: z.string(),
    project: z.string().optional().describe("Exact project name. Must already exist."),
    ...taskFields,
  },
}, async (args) => reply(await of.addTask(prepare(args))));

server.registerTool("update_task", {
  description: "Change a task by id: edit fields, move it to another project, complete it, or drop it. Tasks are never deleted; dropping is reversible in OmniFocus.",
  inputSchema: {
    id: z.string().describe("Task id from list_tasks or add_task."),
    name: z.string().optional(),
    project: z.string().optional().describe("Moves the task to this project."),
    completed: z.boolean().optional(),
    dropped: z.boolean().optional().describe("True drops the task."),
    ...taskFields,
  },
}, async (args) => reply(await of.updateTask(prepare(args))));

server.registerTool("list_projects", {
  description: "List projects with their folder and status.",
  inputSchema: {
    search: z.string().optional().describe("Case-insensitive match on name."),
    status: z.enum(["Active", "OnHold", "Done", "Dropped"]).optional(),
    limit: z.number().int().positive().default(100),
  },
}, async (args) => reply(await of.listProjects(prepare(args))));

server.registerTool("add_project", {
  description: "Create a project, optionally inside an existing folder.",
  inputSchema: {
    name: z.string(),
    folder: z.string().optional().describe("Exact folder name. Must already exist."),
    note: z.string().optional(),
    due: z.string().nullable().optional().describe(dateHelp),
  },
}, async (args) => reply(await of.addProject(prepare(args))));

server.registerTool("list_tags", {
  description: "List every tag, with its parent tag if it has one.",
  inputSchema: {},
}, async () => reply(await of.listTags()));

await server.connect(new StdioServerTransport());
