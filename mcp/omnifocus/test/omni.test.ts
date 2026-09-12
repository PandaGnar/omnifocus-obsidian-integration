import assert from "node:assert/strict";
import test from "node:test";
import { buildSource, explain, runOmniJS } from "../src/bridge.js";
import { scripts, toEpoch } from "../src/omni.js";

/** Runs a built snippet in Node, standing in for OmniFocus's JavaScript. */
const evaluate = (body: string, args: unknown) => new Function(`return ${buildSource(body, args)}`)();

test("absent dates stay absent, null clears them", () => {
  assert.equal(toEpoch(undefined, "due"), undefined);
  assert.equal(toEpoch(null, "due"), null);
});

test("a bare date is end of day when due, start of day when deferred", () => {
  assert.equal(new Date(toEpoch("2026-09-14", "due")!).getHours(), 23);
  assert.equal(new Date(toEpoch("2026-09-14", "defer")!).getHours(), 0);
});

test("a time of day is kept as given", () => {
  assert.equal(new Date(toEpoch("2026-09-14T17:30", "due")!).getHours(), 17);
});

test("an unparseable date is reported, not silently dropped", () => {
  assert.throws(() => toEpoch("next tuesday", "due"), /Not a date/);
});

test("arguments reach the snippet intact, quotes and newlines included", () => {
  const args = { name: 'Email "Bob" \\ O\'Neill', note: "line one\nline two", tags: ["home"] };
  assert.deepEqual(JSON.parse(evaluate("return JSON.stringify(args);", args)), args);
});

test("every OmniFocus snippet is valid JavaScript", () => {
  for (const [name, body] of Object.entries(scripts)) {
    // Parses the snippet without running it; OmniFocus globals are absent here.
    assert.doesNotThrow(() => new Function(`return ${buildSource(body, {})}`), name);
  }
});

test("a task named like an error doesn't produce the wrong diagnosis", () => {
  const err = { stderr: "execution error: Error: No project named server not running" };
  assert.match(explain(err), /No project named/);
});

test("a real Apple error code is translated", () => {
  assert.match(explain({ stderr: "execution error: Not authorized (-1743)" }), /System Settings/);
});

test("an oversized call is refused before it reaches osascript", async () => {
  await assert.rejects(runOmniJS("return '1';", { note: "x".repeat(300_000) }), /Too much text/);
});
