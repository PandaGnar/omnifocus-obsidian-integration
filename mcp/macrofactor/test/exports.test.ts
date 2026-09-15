import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dateColumn, dayOf, listExports, parseCsv, readRows } from "../src/exports.js";

test("parseCsv handles quotes, BOM and CRLF", () => {
  const { headers, rows } = parseCsv('﻿Date,Food,Note\r\n2026-09-14,"Chicken, roasted","He said ""hi""\nthen left"\r\n');
  assert.deepEqual(headers, ["Date", "Food", "Note"]);
  assert.deepEqual(rows, [{ Date: "2026-09-14", Food: "Chicken, roasted", Note: 'He said "hi"\nthen left' }]);
});

test("dayOf reads ISO and US dates, rejects the rest", () => {
  assert.equal(dayOf("2026-09-14T08:30:00Z"), "2026-09-14");
  assert.equal(dayOf("9/14/2026"), "2026-09-14");
  assert.equal(dayOf("Chicken"), null);
  assert.equal(dayOf("80"), null);
});

test("dateColumn prefers a header named date, else a column that parses", () => {
  assert.equal(dateColumn(["Day", "Log Date"], []), "Log Date");
  assert.equal(dateColumn(["Food", "When"], [{ Food: "Eggs", When: "2026-09-14" }]), "When");
  assert.equal(dateColumn(["Food"], [{ Food: "Eggs" }]), null);
});

test("readRows filters by day and reports what it skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-"));
  await writeFile(join(dir, "weight.csv"), "Date,Weight\n2026-09-13,80\n2026-09-14,79.5\nunknown,1\n2026-09-15,79\n");
  await writeFile(join(dir, ".weight.csv.icloud"), "");
  const listed = await listExports(dir);
  assert.deepEqual(listed.items, [{ file: "weight.csv", headers: ["Date", "Weight"], rowCount: 4, dateColumn: "Date", from: "2026-09-13", to: "2026-09-15" }]);
  const read = await readRows(dir, { file: "weight.csv", from: "2026-09-14", limit: 1 });
  assert.deepEqual(read, { items: [{ Date: "2026-09-14", Weight: "79.5" }], hitLimit: true, dateColumn: "Date", skipped: 1 });
  await assert.rejects(readRows(dir, { file: "nope.csv", limit: 1 }), /Files in the folder: weight.csv/);
  await assert.rejects(listExports(join(dir, "missing")), /No folder at/);
});
