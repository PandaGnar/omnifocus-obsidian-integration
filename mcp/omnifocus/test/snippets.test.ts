import assert from "node:assert/strict";
import test from "node:test";
import { buildSource } from "../src/bridge.js";
import { scripts } from "../src/omni.js";
import { makeWorld } from "./world.js";

/**
 * Runs a snippet against the stand-in database. This exercises the snippet's
 * own logic, not the real Omni Automation API.
 *
 * @param script One of the entries in `scripts`.
 * @param args Values the snippet reads as `args`.
 * @param globals The OmniFocus globals the snippet reaches for.
 */
function run(script: string, args: unknown, globals: Record<string, unknown>) {
  const names = Object.keys(globals);
  const out = new Function(...names, `return ${buildSource(script, args)}`)(
    ...names.map((n) => globals[n]),
  );
  return JSON.parse(out);
}

test("every snippet runs, not just parses", () => {
  const { globals } = makeWorld();
  const calls: [string, Record<string, unknown>][] = [
    ["listTasks", { limit: 50 }],
    ["listProjects", { limit: 50 }],
    ["listTags", { limit: 50 }],
    ["addTask", { name: "New" }],
    ["addProject", { name: "New project" }],
    ["updateTask", { id: "T2", flagged: true }],
  ];
  for (const [name, args] of calls) {
    assert.doesNotThrow(() => run(scripts[name as keyof typeof scripts], args, globals), name);
  }
});

test("a project's root task is not offered as a task", () => {
  const { globals } = makeWorld();
  const { items } = run(scripts.listTasks, { limit: 50 }, globals);
  assert.deepEqual(items.map((t: { id: string }) => t.id), ["T1", "T2"]);
});

test("a project's id is refused by update_task", () => {
  const { globals, tasks } = makeWorld();
  assert.throws(
    () => run(scripts.updateTask, { id: "P2", flagged: true }, globals),
    /belongs to the project 'Ship v2'/,
  );
  assert.equal(tasks.rootTask.flagged, false);
});

test("a result that exactly fills the limit is not reported as clipped", () => {
  const { globals } = makeWorld();
  assert.equal(run(scripts.listTasks, { limit: 2 }, globals).hitLimit, false);
  assert.equal(run(scripts.listTasks, { limit: 1 }, globals).hitLimit, true);
});

test("a tag that can't be resolved leaves the task alone", () => {
  const { globals, tasks } = makeWorld();
  tasks.realTask.note = "REF-4471, do not lose this";
  assert.throws(
    () => run(scripts.updateTask, { id: "T2", note: "short", tags: ["Nested/Missing"] }, globals),
    /No tag named/,
  );
  assert.equal(tasks.realTask.note, "REF-4471, do not lose this");
});

test("a failed add_task leaves behind neither task nor tag", () => {
  const { globals, created } = makeWorld();
  assert.throws(
    () => run(scripts.addTask, { name: "Call the bank", tags: ["Nested/Missing"] }, globals),
    /No tag named/,
  );
  assert.deepEqual(created.tags, []);
});

test("tags are matched and reported by path", () => {
  const { globals, tasks } = makeWorld();
  tasks.realTask.tags = [globals.flattenedTags[0]];
  assert.equal(run(scripts.listTasks, { tag: "Home/Work", limit: 50 }, globals).items.length, 1);
  assert.equal(run(scripts.listTasks, { tag: "Work", limit: 50 }, globals).items.length, 1);
  assert.deepEqual(
    run(scripts.listTasks, { id: "T2" }, globals).items[0].tags,
    ["Home/Work"],
  );
});

test("list_tags answers", () => {
  const { globals } = makeWorld();
  const { items } = run(scripts.listTags, { limit: 50 }, globals);
  assert.deepEqual(items.map((g: { path: string }) => g.path), ["Home/Work", "Errand"]);
});
