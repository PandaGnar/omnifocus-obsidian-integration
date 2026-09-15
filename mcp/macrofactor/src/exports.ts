import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type Row = Record<string, string>;

/**
 * Parses CSV text. Handles quoted fields (commas and newlines inside quotes),
 * doubled quotes, CRLF line endings and a leading BOM, since exports made for
 * Excel tend to have all of these.
 */
export function parseCsv(text: string): { headers: string[]; rows: Row[] } {
  const lines: string[][] = [];
  let field = "";
  let line: string[] = [];
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { line.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      line.push(field); field = ""; lines.push(line); line = [];
    } else field += ch;
  }
  if (field !== "" || line.length) { line.push(field); lines.push(line); }
  const [headers = [], ...body] = lines.filter((l) => l.some((v) => v !== ""));
  const rows = body.map((l) => Object.fromEntries(headers.map((h, i) => [h, l[i] ?? ""])));
  return { headers, rows };
}

/** Turns a date string into "YYYY-MM-DD", or null if it isn't one. */
export function dayOf(value: string): string | null {
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (iso) return iso[1];
  // Plain numbers like "80" would parse as a year, so only try values that look like dates.
  if (!/[\/A-Za-z]/.test(value)) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Picks the date column: a header containing "date", else the first column with parseable values. */
export function dateColumn(headers: string[], rows: Row[]): string | null {
  const named = headers.find((h) => /date/i.test(h));
  if (named) return named;
  return headers.find((h) => rows.some((r) => dayOf(r[h]) !== null)) ?? null;
}

/** Reads one CSV file from the folder. */
async function load(dir: string, file: string) {
  let text: string;
  try {
    text = await readFile(join(dir, file), "utf8");
  } catch {
    const files = await listFiles(dir);
    throw new Error(`No file named ${file}. Files in the folder: ${files.join(", ") || "none"}.`);
  }
  const { headers, rows } = parseCsv(text);
  return { headers, rows, dateColumn: dateColumn(headers, rows) };
}

/** Names of the CSV files in the folder. Dot-files are skipped: iCloud's undownloaded placeholders look like that. */
export async function listFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new Error(`No folder at ${dir}. Create it and save MacroFactor's exported CSV files there, or start the server with another folder as its first argument.`);
  }
  return names.filter((n) => /\.csv$/i.test(n) && !n.startsWith(".")).sort();
}

/** Each file with its headers, row count and the span of dates it covers. */
export async function listExports(dir: string) {
  const items = [];
  for (const file of await listFiles(dir)) {
    const { headers, rows, dateColumn: col } = await load(dir, file);
    const days = col ? rows.map((r) => dayOf(r[col])).filter((d): d is string => d !== null).sort() : [];
    items.push({ file, headers, rowCount: rows.length, dateColumn: col, from: days[0] ?? null, to: days.at(-1) ?? null });
  }
  return { items };
}

/** Rows from one file, optionally kept to a date range. */
export async function readRows(dir: string, args: { file: string; from?: string; to?: string; limit: number }) {
  const { rows, dateColumn: col } = await load(dir, args.file);
  let skipped = 0;
  const kept = rows.filter((r) => {
    if (!args.from && !args.to) return true;
    const day = col ? dayOf(r[col]) : null;
    if (day === null) { skipped++; return false; }
    return (!args.from || day >= args.from) && (!args.to || day <= args.to);
  });
  return { items: kept.slice(0, args.limit), hitLimit: kept.length > args.limit, dateColumn: col, skipped };
}
