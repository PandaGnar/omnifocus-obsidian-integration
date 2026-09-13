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

/**
 * Runs a snippet against stand-in OmniFocus globals. This exercises the
 * snippet's own ordering and branching, not the real Omni Automation API.
 *
 * @param script One of the entries in `scripts`.
 * @param args Values the snippet reads as `args`.
 * @param world The globals the snippet reaches for.
 */
function runWithFakes(script: string, args: unknown, world: Record<string, unknown>) {
  const names = Object.keys(world);
  const body = `return ${buildSource(script, args)}`;
  return new Function(...names, body)(...names.map((n) => world[n]));
}

test("a task is left untouched when the project it should move to is missing", () => {
  const task = {
    id: { primaryKey: "t1" },
    name: "before",
    note: "",
    tags: [],
    dueDate: null,
    deferDate: null,
    flagged: false,
    taskStatus: "available",
    containingProject: null,
  };
  const world = {
    Task: { byIdentifier: (id: string) => (id === "t1" ? task : null), Status: {} },
    flattenedProjects: [],
    flattenedTags: [],
    moveTasks: () => {
      throw new Error("should never be reached");
    },
  };

  assert.throws(
    () => runWithFakes(scripts.updateTask, { id: "t1", name: "after", project: "Nope" }, world),
    /No project named Nope/,
  );
  assert.equal(task.name, "before");
});

test("a task whose name doesn't match taskName is left untouched", () => {
  const task = {
    id: { primaryKey: "t1" },
    name: "Renew passport",
    note: "",
    tags: [],
    dueDate: null,
    deferDate: null,
    flagged: false,
    taskStatus: "available",
    containingProject: null,
  };
  const world = {
    Task: { byIdentifier: () => task, Status: {} },
    flattenedProjects: [],
    flattenedTags: [],
    moveTasks: () => {},
  };

  assert.throws(
    () => runWithFakes(scripts.updateTask, { id: "t1", taskName: "Book flights", flagged: true }, world),
    /is named 'Renew passport', not 'Book flights'/,
  );
  assert.equal(task.flagged, false);
});

test("a list that stopped at the limit says so", () => {
  const task = (n: string) => ({
    id: { primaryKey: n },
    name: n,
    note: "",
    tags: [],
    dueDate: null,
    deferDate: null,
    flagged: false,
    taskStatus: "available",
    containingProject: null,
  });
  const world = {
    Task: { Status: {} },
    inbox: [],
    flattenedTasks: [task("a"), task("b"), task("c")],
  };

  const cut = JSON.parse(runWithFakes(scripts.listTasks, { limit: 2 }, world));
  assert.equal(cut.items.length, 2);
  assert.equal(cut.hitLimit, true);

  const whole = JSON.parse(runWithFakes(scripts.listTasks, { limit: 50 }, world));
  assert.equal(whole.items.length, 3);
  assert.equal(whole.hitLimit, false);
});

test("two projects with one name are refused, and a path picks one", () => {
  const project = (name: string, folder: string) => ({
    name,
    parentFolder: { name: folder, parent: null },
    flattenedTasks: [],
  });
  const home = project("Errands", "Home");
  const work = project("Errands", "Work");
  const task = {
    id: { primaryKey: "t1" },
    name: "Post a letter",
    note: "",
    tags: [],
    dueDate: null,
    deferDate: null,
    flagged: false,
    taskStatus: "available",
    containingProject: null,
  };
  const moved: unknown[] = [];
  const world = {
    Task: { byIdentifier: () => task, Status: {} },
    flattenedProjects: [home, work],
    flattenedTags: [],
    moveTasks: (_tasks: unknown[], to: unknown) => moved.push(to),
  };

  assert.throws(
    () => runWithFakes(scripts.updateTask, { id: "t1", project: "Errands" }, world),
    /More than one project named 'Errands': Home\/Errands, Work\/Errands/,
  );
  assert.equal(moved.length, 0);

  runWithFakes(scripts.updateTask, { id: "t1", project: "Work/Errands" }, world);
  assert.deepEqual(moved, [work]);
});
