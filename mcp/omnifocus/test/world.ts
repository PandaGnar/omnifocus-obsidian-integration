/**
 * A stand-in OmniFocus database, shaped the way the Omni Automation docs
 * describe rather than the way the snippets wish it were:
 *
 * - `flattenedTasks` holds inbox items, real tasks, and the hidden root task
 *   that represents each project. A root task carries the project's own id.
 * - `Task.Status` members are distinct objects, compared by identity.
 * - Tags and folders nest, and names repeat across branches.
 */
export function makeWorld() {
  const Status = {
    Available: { n: "Available" },
    Blocked: { n: "Blocked" },
    Completed: { n: "Completed" },
    DueSoon: { n: "DueSoon" },
    Dropped: { n: "Dropped" },
    Next: { n: "Next" },
    Overdue: { n: "Overdue" },
  };

  const home = { name: "Home", parent: null };
  const work = { name: "Work", parent: null };
  const errandsHome = { name: "Errands", parentFolder: home, flattenedTasks: [] as Task[] };
  const errandsWork = { name: "Errands", parentFolder: work, flattenedTasks: [] as Task[] };
  const ship = { name: "Ship v2", parentFolder: work, flattenedTasks: [] as Task[] };
  const projects = [errandsHome, errandsWork, ship];
  for (const [i, p] of projects.entries()) {
    (p as Record<string, unknown>).id = { primaryKey: "P" + i };
    (p as Record<string, unknown>).status = "Active";
    (p as Record<string, unknown>).dueDate = null;
  }

  const homeWork = { name: "Work", parent: home, id: { primaryKey: "G1" } };
  const loose = { name: "Errand", parent: null, id: { primaryKey: "G2" } };
  const tags = [homeWork, loose];

  type Task = ReturnType<typeof task>;
  function task(id: string, name: string, extra: Record<string, unknown> = {}) {
    return {
      id: { primaryKey: id },
      name,
      note: "",
      tags: [] as typeof tags,
      dueDate: null as Date | null,
      deferDate: null as Date | null,
      effectiveDueDate: null as Date | null,
      flagged: false,
      estimatedMinutes: null as number | null,
      taskStatus: Status.Available,
      containingProject: null as unknown,
      clearTags() {
        this.tags = [];
      },
      addTags(list: typeof tags) {
        this.tags = list;
      },
      markComplete() {
        this.taskStatus = Status.Completed;
      },
      markIncomplete() {
        this.taskStatus = Status.Available;
      },
      drop() {
        this.taskStatus = Status.Dropped;
      },
      ...extra,
    };
  }

  const inboxItem = task("T1", "Buy milk");
  const realTask = task("T2", "Write release notes", { containingProject: ship });
  // The project's root task: same id as the project, and it is in flattenedTasks.
  const rootTask = task("P2", "Ship v2", { containingProject: ship });
  ship.flattenedTasks = [realTask];

  const created: { tasks: unknown[]; projects: unknown[]; tags: unknown[] } = {
    tasks: [],
    projects: [],
    tags: [],
  };

  return {
    created,
    tasks: { inboxItem, realTask, rootTask },
    globals: {
      Task: Object.assign(
        function Task(this: Record<string, unknown>, name: string) {
          Object.assign(this, task("new", name));
          created.tasks.push(name);
        },
        {
          Status,
          byIdentifier: (id: string) =>
            [inboxItem, realTask, rootTask].find((t) => t.id.primaryKey === id) || null,
        },
      ),
      Project: Object.assign(
        function Project(this: Record<string, unknown>, name: string) {
          Object.assign(this, { name, id: { primaryKey: "new" }, parentFolder: null });
          created.projects.push(name);
        },
        { Status: { Active: "Active", Done: "Done", Dropped: "Dropped", OnHold: "OnHold" } },
      ),
      Tag: function Tag(this: Record<string, unknown>, name: string) {
        Object.assign(this, { name, parent: null, id: { primaryKey: "new" } });
        created.tags.push(name);
      },
      inbox: { ending: "inbox-end" },
      flattenedTasks: [inboxItem, realTask, rootTask],
      flattenedProjects: projects,
      flattenedFolders: [home, work],
      flattenedTags: tags,
      moveTasks: () => {},
    },
  };
}
