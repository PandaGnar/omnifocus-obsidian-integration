import { runOmniJS } from "./bridge.js";

/** Tool arguments on their way to a snippet, which reads them as `args`. */
export type Fields = Record<string, unknown>;

/** Helpers shared by every snippet. These run inside OmniFocus, not in Node. */
const prelude = `
const iso = d => d ? d.toISOString() : null;
/** Keeps the change report readable when a note is enormous. */
const brief = v => typeof v === "string" && v.length > 500 ? v.slice(0, 500) : v;
const statusName = s => ["Available","Blocked","Completed","DueSoon","Dropped","Next","Overdue"]
  .find(k => Task.Status[k] === s) || "unknown";
const shape = t => {
  const note = t.note || "";
  const cut = !args.fullNote && note.length > 500;
  return {
    id: t.id.primaryKey,
    name: t.name,
  project: t.containingProject ? projectPath(t.containingProject) : null,
    tags: t.tags.map(tagPath),
    due: iso(t.dueDate),
    effectiveDue: iso(t.effectiveDueDate),
    defer: iso(t.deferDate),
    flagged: t.flagged,
    status: statusName(t.taskStatus),
    estimatedMinutes: t.estimatedMinutes,
    note: cut ? note.slice(0, 500) : note,
    noteTruncated: cut,
  };
};
const folderPath = f => f.parent ? folderPath(f.parent) + "/" + f.name : f.name;
const projectPath = p => p.parentFolder ? folderPath(p.parentFolder) + "/" + p.name : p.name;
const tagPath = g => g.parent ? tagPath(g.parent) + "/" + g.name : g.name;
/**
 * Names repeat in OmniFocus: two projects can both be called Errands. Match on
 * the full path first, fall back to the plain name, and refuse to guess when
 * that still leaves more than one.
 */
const lookUp = (all, pathOf, kind, name) => {
  const wanted = name.toLowerCase();
  const byPath = all.filter(o => pathOf(o).toLowerCase() === wanted);
  const found = byPath.length ? byPath : all.filter(o => o.name.toLowerCase() === wanted);
  if (found.length > 1) {
    throw new Error(
      "More than one " + kind + " named '" + name + "': " + found.map(pathOf).join(", ") +
      ". Name the one you mean in full.");
  }
  return found[0] || null;
};
/** True for the hidden task that stands in for a project. */
const isProjectRoot = t => !!t.containingProject &&
  t.containingProject.id.primaryKey === t.id.primaryKey;
const projectNamed = name => {
  const p = lookUp(flattenedProjects, projectPath, "project", name);
  if (!p) throw new Error("No project named " + name);
  return p;
};
/** Resolves tag names, creating any that are new. Can throw; call it first. */
const resolveTags = names => names.map(n => {
  const existing = lookUp(flattenedTags, tagPath, "tag", n);
  if (existing) return existing;
  if (n.includes("/")) throw new Error("No tag named " + n);
  return new Tag(n);
});
const apply = (t, f, tags) => {
  if (f.note !== undefined) t.note = f.note;
  if (f.flagged !== undefined) t.flagged = f.flagged;
  if (f.due !== undefined) t.dueDate = f.due === null ? null : new Date(f.due);
  if (f.defer !== undefined) t.deferDate = f.defer === null ? null : new Date(f.defer);
  if (f.estimatedMinutes !== undefined) t.estimatedMinutes = f.estimatedMinutes;
  if (tags) {
    t.clearTags();
    t.addTags(tags);
  }
};
`;

/** The Omni Automation snippets, one per tool. Each returns a JSON string. */
export const scripts = {
  listTasks: prelude + `
if (args.id) {
  const found = Task.byIdentifier(args.id);
  return JSON.stringify({ items: found ? [shape(found)] : [], hitLimit: false });
}
const pool = args.project ? projectNamed(args.project).flattenedTasks : flattenedTasks;
const text = args.search ? args.search.toLowerCase() : null;
const tag = args.tag ? args.tag.toLowerCase() : null;
const out = [], seen = new Set();
let hitLimit = false;
for (const t of pool) {
  if (isProjectRoot(t)) continue;
  const s = t.taskStatus;
  const finished = s === Task.Status.Completed || s === Task.Status.Dropped;
  if (finished && !args.includeCompleted) continue;
  if (args.available && (finished || s === Task.Status.Blocked)) continue;
  if (args.flagged && !t.flagged) continue;
  if (tag && !t.tags.some(g => g.name.toLowerCase() === tag || tagPath(g).toLowerCase() === tag)) continue;
  if (args.dueBefore && !(t.effectiveDueDate && t.effectiveDueDate.getTime() <= args.dueBefore)) continue;
  if (text && !(t.name + " " + (t.note || "")).toLowerCase().includes(text)) continue;
  if (seen.has(t.id.primaryKey)) continue;
  seen.add(t.id.primaryKey);
  if (out.length === args.limit) { hitLimit = true; break; }
  out.push(shape(t));
}
return JSON.stringify({ items: out, hitLimit });
`,

  addTask: prelude + `
const destination = args.project ? projectNamed(args.project) : inbox.ending;
const tags = args.tags === undefined ? null : resolveTags(args.tags);
const task = new Task(args.name, destination);
apply(task, args, tags);
return JSON.stringify(shape(task));
`,

  updateTask: prelude + `
const task = Task.byIdentifier(args.id);
if (!task) throw new Error("No task with id " + args.id);
if (isProjectRoot(task)) {
  throw new Error(
    "That id belongs to the project '" + task.name + "', not a task. Changing it here " +
    "would change the whole project.");
}
// Resolve first, write second. There is no rollback here, so a name that
// doesn't exist has to fail before anything has changed.
if (args.taskName !== undefined && task.name !== args.taskName) {
  throw new Error(
    "Task " + args.id + " is named '" + task.name + "', not '" + args.taskName +
    "'. Look it up again before changing it.");
}
const destination = args.project !== undefined ? projectNamed(args.project) : null;
const tags = args.tags === undefined ? null : resolveTags(args.tags);
const before = shape(task);
if (args.name !== undefined) task.name = args.name;
apply(task, args, tags);
if (destination) moveTasks([task], destination);
if (args.completed === true) task.markComplete();
if (args.completed === false) task.markIncomplete();
if (args.dropped === true) task.drop(false);
const after = shape(task);
// Say what actually moved, so the caller isn't left comparing two blobs.
const changed = Object.keys(after)
  .filter(k => k !== "id" && k !== "noteTruncated")
  .filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
  .map(k => ({ field: k, from: brief(before[k]), to: brief(after[k]) }));
return JSON.stringify({ task: after, changed });
`,

  listProjects: prelude + `
const name = s => ["Active","Done","Dropped","OnHold"].find(k => Project.Status[k] === s) || "unknown";
const text = args.search ? args.search.toLowerCase() : null;
const out = [];
let hitLimit = false;
for (const p of flattenedProjects) {
  const status = name(p.status);
  if (args.status && status.toLowerCase() !== args.status.toLowerCase()) continue;
  if (text && !p.name.toLowerCase().includes(text)) continue;
  if (out.length === args.limit) { hitLimit = true; break; }
  out.push({
    id: p.id.primaryKey,
    name: p.name,
    status,
    path: projectPath(p),
    folder: p.parentFolder ? p.parentFolder.name : null,
    due: iso(p.dueDate),
  });
}
return JSON.stringify({ items: out, hitLimit });
`,

  addProject: prelude + `
let folder = null;
if (args.folder) {
  folder = lookUp(flattenedFolders, folderPath, "folder", args.folder);
  if (!folder) throw new Error("No folder named " + args.folder);
}
const project = new Project(args.name, folder);
if (args.note !== undefined) project.note = args.note;
if (args.due !== undefined && args.due !== null) project.dueDate = new Date(args.due);
return JSON.stringify({
  id: project.id.primaryKey,
  name: project.name,
  path: projectPath(project),
  folder: project.parentFolder ? folderPath(project.parentFolder) : null,
  due: iso(project.dueDate),
});
`,

  listTags: prelude + `
const items = flattenedTags.slice(0, args.limit).map(g => ({
  id: g.id.primaryKey,
  name: g.name,
  path: tagPath(g),
  parent: g.parent ? g.parent.name : null,
}));
return JSON.stringify({ items, hitLimit: flattenedTags.length > args.limit });
`,
};

/**
 * Finds tasks, or one task by id.
 *
 * @param args Filters: `id`, `project`, `tag`, `flagged`, `available`, `dueBefore`,
 *   `search`, `includeCompleted`, `fullNote`, `limit`.
 */
export const listTasks = (args: Fields) => runOmniJS(scripts.listTasks, args);

/**
 * Creates a task in a project, or in the inbox when no project is named.
 *
 * @param args `name`, plus any of `project`, `note`, `tags`, `due`, `defer`,
 *   `flagged`, `estimatedMinutes`.
 */
export const addTask = (args: Fields) => runOmniJS(scripts.addTask, args);

/**
 * Edits, moves, completes, or drops the task with the given id.
 *
 * @param args `id`, plus the fields to change. `taskName` is checked against
 *   the task's current name. `project` moves the task.
 */
export const updateTask = (args: Fields) => runOmniJS(scripts.updateTask, args);

/**
 * Lists projects with their folder and status.
 *
 * @param args `search`, `status`, `limit`.
 */
export const listProjects = (args: Fields) => runOmniJS(scripts.listProjects, args);

/**
 * Creates a project, optionally inside an existing folder.
 *
 * @param args `name`, plus any of `folder`, `note`, `due`.
 */
export const addProject = (args: Fields) => runOmniJS(scripts.addProject, args);

/**
 * Lists tags with their parent tag.
 *
 * @param args `limit`.
 */
export const listTags = (args: Fields) => runOmniJS(scripts.listTags, args);

/**
 * ISO timestamp to epoch millis. A bare date means the start of that day for a
 * defer date and the end of it for a due date, which is what people expect when
 * they say "due Friday".
 *
 * @param value ISO 8601 date or timestamp. Undefined leaves the date alone,
 *   null clears it.
 * @param kind Which end of a bare date to use.
 * @returns Epoch millis, or the undefined/null it was given.
 * @throws If the string isn't a date.
 */
export function toEpoch(
  value: string | null | undefined,
  kind: "due" | "defer",
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const at = new Date(bare ? `${value}T${kind === "due" ? "23:59:00" : "00:00:00"}` : value);
  if (Number.isNaN(at.getTime())) throw new Error(`Not a date I understand: ${value}`);
  return at.getTime();
}
