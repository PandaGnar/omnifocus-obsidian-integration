import { runOmniJS } from "./bridge.js";

export type Fields = Record<string, unknown>;

/** Helpers shared by every snippet. These run inside OmniFocus, not in Node. */
const prelude = `
const iso = d => d ? d.toISOString() : null;
const statusName = s => ["Available","Blocked","Completed","DueSoon","Dropped","Next","Overdue"]
  .find(k => Task.Status[k] === s) || "unknown";
const shape = t => ({
  id: t.id.primaryKey,
  name: t.name,
  project: t.containingProject ? t.containingProject.name : null,
  tags: t.tags.map(g => g.name),
  due: iso(t.dueDate),
  defer: iso(t.deferDate),
  flagged: t.flagged,
  status: statusName(t.taskStatus),
  note: (t.note || "").slice(0, 500),
});
const projectNamed = name => {
  const p = flattenedProjects.byName(name);
  if (!p) throw new Error("No project named " + name);
  return p;
};
const apply = (t, f) => {
  if (f.note !== undefined) t.note = f.note;
  if (f.flagged !== undefined) t.flagged = f.flagged;
  if (f.due !== undefined) t.dueDate = f.due === null ? null : new Date(f.due);
  if (f.defer !== undefined) t.deferDate = f.defer === null ? null : new Date(f.defer);
  if (f.estimatedMinutes !== undefined) t.estimatedMinutes = f.estimatedMinutes;
  if (f.tags !== undefined) {
    t.clearTags();
    t.addTags(f.tags.map(n => flattenedTags.byName(n) || new Tag(n)));
  }
};
`;

export const scripts = {
  listTasks: prelude + `
const pool = args.project ? projectNamed(args.project).flattenedTasks : [...inbox, ...flattenedTasks];
const text = args.search ? args.search.toLowerCase() : null;
const tag = args.tag ? args.tag.toLowerCase() : null;
const out = [], seen = new Set();
for (const t of pool) {
  const s = t.taskStatus;
  const finished = s === Task.Status.Completed || s === Task.Status.Dropped;
  if (finished && !args.includeCompleted) continue;
  if (args.available && (finished || s === Task.Status.Blocked)) continue;
  if (args.flagged && !t.flagged) continue;
  if (tag && !t.tags.some(g => g.name.toLowerCase() === tag)) continue;
  if (args.dueBefore && !(t.effectiveDueDate && t.effectiveDueDate.getTime() <= args.dueBefore)) continue;
  if (text && !(t.name + " " + t.note).toLowerCase().includes(text)) continue;
  if (seen.has(t.id.primaryKey)) continue;
  seen.add(t.id.primaryKey);
  out.push(shape(t));
  if (out.length >= args.limit) break;
}
return JSON.stringify(out);
`,

  addTask: prelude + `
const task = new Task(args.name, args.project ? projectNamed(args.project) : inbox.ending);
apply(task, args);
return JSON.stringify(shape(task));
`,

  updateTask: prelude + `
const task = Task.byIdentifier(args.id);
if (!task) throw new Error("No task with id " + args.id);
if (args.name !== undefined) task.name = args.name;
apply(task, args);
if (args.project !== undefined) moveTasks([task], projectNamed(args.project));
if (args.completed === true) task.markComplete();
if (args.completed === false) task.markIncomplete();
if (args.dropped === true) task.drop(false);
return JSON.stringify(shape(task));
`,

  listProjects: prelude + `
const name = s => ["Active","Done","Dropped","OnHold"].find(k => Project.Status[k] === s) || "unknown";
const text = args.search ? args.search.toLowerCase() : null;
const out = [];
for (const p of flattenedProjects) {
  const status = name(p.status);
  if (args.status && status.toLowerCase() !== args.status.toLowerCase()) continue;
  if (text && !p.name.toLowerCase().includes(text)) continue;
  out.push({
    id: p.id.primaryKey,
    name: p.name,
    status,
    folder: p.parentFolder ? p.parentFolder.name : null,
    due: iso(p.dueDate),
  });
  if (out.length >= args.limit) break;
}
return JSON.stringify(out);
`,

  addProject: prelude + `
let folder = null;
if (args.folder) {
  folder = flattenedFolders.byName(args.folder);
  if (!folder) throw new Error("No folder named " + args.folder);
}
const project = new Project(args.name, folder);
if (args.note !== undefined) project.note = args.note;
if (args.due !== undefined && args.due !== null) project.dueDate = new Date(args.due);
return JSON.stringify({ id: project.id.primaryKey, name: project.name, folder: args.folder || null });
`,

  listTags: `
return JSON.stringify(flattenedTags.map(g => ({
  id: g.id.primaryKey,
  name: g.name,
  parent: g.parent ? g.parent.name : null,
})));
`,
};

export const listTasks = (args: Fields) => runOmniJS(scripts.listTasks, args);
export const addTask = (args: Fields) => runOmniJS(scripts.addTask, args);
export const updateTask = (args: Fields) => runOmniJS(scripts.updateTask, args);
export const listProjects = (args: Fields) => runOmniJS(scripts.listProjects, args);
export const addProject = (args: Fields) => runOmniJS(scripts.addProject, args);
export const listTags = () => runOmniJS(scripts.listTags);

/**
 * ISO timestamp to epoch millis. A bare date means the start of that day for a
 * defer date and the end of it for a due date, which is what people expect when
 * they say "due Friday". Absent stays absent; null clears the date.
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
