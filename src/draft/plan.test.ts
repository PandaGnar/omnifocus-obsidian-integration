import { describe, expect, it } from "vitest";

import { type DailyNote, newDailyNotePath } from "../vault/resolver";
import { diffStats, isNoOpDiff } from "./diff";
import {
	applyDraftWrite,
	confirmWrite,
	fillEmptySections,
	planDailyDraft,
	planDiff,
	planSignals,
} from "./plan";
import { headingOutline, isEmptyBody, lineContent, parseNote } from "./sections";
import { composeFromTemplate, instantiateTemplate } from "./template";
import { parseDraftReply } from "./prompt";
import {
	HALF_WRITTEN_NOTE,
	HANDMADE_NOTE,
	MODEL_REPLY,
	TEMPLATE_TEXT,
} from "./fixtures/template";

const DATE = { year: 2026, month: 8, day: 16 };
const template = instantiateTemplate(TEMPLATE_TEXT, "26.08.16");
const DRAFT = composeFromTemplate(template, parseDraftReply(MODEL_REPLY, template.headings).filled);

function note(path: string, duplicates: readonly string[] = []): DailyNote {
	return { date: DATE, path, duplicates };
}

describe("no existing note", () => {
	const plan = planDailyDraft({ date: DATE, existing: null, draft: DRAFT });

	it("creates the note flat in Mise/, where a new note goes", () => {
		expect(plan.action).toBe("create");
		expect(plan.path).toBe("Mise/26.08.16.md");
	});

	it("writes the draft unchanged", () => {
		expect(plan.after).toBe(DRAFT);
		expect(plan.before).toBe("");
	});

	it("is writable and shows the whole note as an addition", () => {
		expect(isNoOpDiff(planDiff(plan))).toBe(false);
		expect(diffStats(planDiff(plan)).removed).toBe(0);
	});
});

describe("an existing note", () => {
	const existing = { note: note("Mise/26.08.16.md"), text: HALF_WRITTEN_NOTE };
	const plan = planDailyDraft({ date: DATE, existing, draft: DRAFT });

	it("writes to the note that exists, never to a second file", () => {
		// `26.07.02 1.md` in the fixture vault is what this rule exists to
		// prevent, and it is in the real vault because it happened.
		expect(plan.action).toBe("fill");
		expect(plan.path).toBe("Mise/26.08.16.md");
	});

	it("leaves every line the user wrote exactly where it was", () => {
		expect(plan.after).toContain("Do not touch this line.");
		expect(plan.after).toContain("- [x] Already did the school run");
		// The draft's competing content for those two sections is not in the note.
		expect(plan.after).not.toContain("Finish the migration rehearsal");
		expect(plan.after).not.toContain("Cutover rehearsal, start to finish");
	});

	it("names the sections it preserved and the ones it filled", () => {
		expect(plan.preservedHeadings).toEqual(["Intention", "Today"]);
		expect(plan.filledHeadings).toEqual(["Waiting on", "Notes", "Threads", "Tomorrow"]);
	});

	it("removes scaffolding lines and nothing else", () => {
		// Filling `- [ ] ` with `- [ ] Confirm the trip dates` does show as a
		// removal, so the honest assertion is not "removes nothing" but "every
		// line it removed was structure with no content on it".
		const removed = planDiff(plan).filter((line) => line.kind === "remove");
		expect(removed.length).toBeGreaterThan(0);
		for (const line of removed) expect(lineContent(line.text)).toBe("");
	});

	it("keeps the note's heading structure unchanged", () => {
		expect(headingOutline(plan.after)).toEqual(headingOutline(HALF_WRITTEN_NOTE));
	});

	it("appends nothing when the note already has every template section", () => {
		expect(plan.appendedHeadings).toEqual([]);
	});

	it("writes into a note that lives in a YY.MM/ bucket, not a new flat one", () => {
		// Month folders are buckets, not date ranges: `Mise/26.06/` holds
		// `26.05.28.md`. Falling back to `newDailyNotePath` here would create
		// `Mise/26.05.28.md` beside it — a second note for the same day.
		const misfiled = { year: 2026, month: 5, day: 28 };
		const bucketed = planDailyDraft({
			date: misfiled,
			existing: {
				note: { date: misfiled, path: "Mise/26.06/26.05.28.md", duplicates: [] },
				text: HALF_WRITTEN_NOTE,
			},
			draft: DRAFT,
		});
		expect(bucketed.path).toBe("Mise/26.06/26.05.28.md");
		expect(bucketed.path).not.toBe(newDailyNotePath(misfiled));
	});
});

describe("idempotence", () => {
	// The stated done-when. Run one is the `create` above; run two is that same
	// draft planned against the note run one wrote.
	const first = planDailyDraft({ date: DATE, existing: null, draft: DRAFT });
	const second = planDailyDraft({
		date: DATE,
		existing: { note: note("Mise/26.08.16.md"), text: first.after },
		draft: DRAFT,
	});

	it("writes nothing on the second run", () => {
		expect(second.action).toBe("noop");
		expect(second.after).toBe(second.before);
	});

	it("shows an empty diff on the second run", () => {
		expect(isNoOpDiff(planDiff(second))).toBe(true);
		expect(diffStats(planDiff(second))).toEqual({ added: 0, removed: 0 });
	});

	it("stays a no-op on the third run", () => {
		const third = planDailyDraft({
			date: DATE,
			existing: { note: note("Mise/26.08.16.md"), text: second.after },
			draft: DRAFT,
		});
		expect(third.action).toBe("noop");
	});

	it("is a no-op even for the sections the model left empty both times", () => {
		// `## Schedule` is scaffolding in run one's output, so run two is free to
		// fill it — and must still produce the same bytes, because the draft it
		// is filling from has the same scaffolding.
		const schedule = parseNote(second.before).sections.find((s) => s.key === "schedule");
		// Spelled out, and with a non-empty fallback: `isEmptyBody(undefined ?? [])`
		// is `true`, so a section that vanished would have passed either way.
		expect(schedule?.bodyLines).toEqual([""]);
		expect(isEmptyBody(schedule?.bodyLines ?? ["content"])).toBe(true);
		expect(second.action).toBe("noop");
	});

	it("re-offers a section the model declined, when a later run does fill it", () => {
		// The honest limit of the property above: it is proven against a fixed
		// reply. A real model is free to fill `## Schedule` on the next run, and
		// that is a write, not a no-op — rule 2 keeps it safe (the section is
		// still scaffolding, so nothing of the user's is at risk) and the diff
		// shows it, but "run it twice and nothing happens" is a claim about the
		// plan and not about the feature in the field.
		const laterDraft = composeFromTemplate(
			template,
			parseDraftReply(
				MODEL_REPLY.replace("## Schedule\n", "## Schedule\n\n09:30 standup\n"),
				template.headings,
			).filled,
		);
		const again = planDailyDraft({
			date: DATE,
			existing: { note: note("Mise/26.08.16.md"), text: first.after },
			draft: laterDraft,
		});
		expect(again.action).toBe("fill");
		expect(again.filledHeadings).toEqual(["Schedule"]);
		// And nothing run one wrote moved.
		expect(again.after).toContain("Finish the migration rehearsal");
	});

	it("does not rewrite a note whose only oddity is trailing blank lines", () => {
		// The merge re-renders the parsed note, so anything the parser normalises
		// shows up here as a spurious write against a note nobody touched.
		const padded = `${HANDMADE_NOTE}\n\n\n`;
		const plan = planDailyDraft({
			date: DATE,
			existing: { note: note("Mise/26.08.16.md"), text: padded },
			draft: DRAFT,
		});
		expect(plan.action).toBe("noop");
		expect(plan.after).toBe(padded);
	});

	it("is a no-op against a note the user has since finished by hand", () => {
		const done = planDailyDraft({
			date: DATE,
			existing: { note: note("Mise/26.08.16.md"), text: HANDMADE_NOTE },
			draft: DRAFT,
		});
		expect(done.action).toBe("noop");
		expect(done.filledHeadings).toEqual([]);
	});
});

describe("fillEmptySections", () => {
	it("does not touch a note with nothing empty in it", () => {
		const merged = fillEmptySections(HANDMADE_NOTE, DRAFT);
		expect(merged.text).toBe(HANDMADE_NOTE);
		expect(merged.filled).toEqual([]);
	});

	it("fills an empty section and only an empty section", () => {
		const before = ["## a", "", "mine", "", "## b", "- [ ] ", ""].join("\n");
		const draft = ["## a", "", "theirs", "", "## b", "- [ ] theirs too", ""].join("\n");
		const merged = fillEmptySections(before, draft);
		expect(merged.text).toContain("mine");
		expect(merged.text).not.toContain("theirs\n");
		expect(merged.text).toContain("- [ ] theirs too");
		expect(merged.filled).toEqual(["b"]);
		expect(merged.preserved).toEqual(["a"]);
	});

	it("leaves an empty section empty when the draft has nothing for it", () => {
		const before = ["## a", "- [ ] ", ""].join("\n");
		expect(fillEmptySections(before, "## a\n- [ ] \n").text).toBe(before);
	});

	it("fills each occurrence of a repeated heading from its own reply section", () => {
		// Two `## Notes` in one note is a shape a person can type. The draft has
		// one Notes body, so it belongs to one of them — copying it into both puts
		// the model's paragraph in the note twice.
		const before = ["## Notes", "- [ ] ", "", "## Notes", "- [ ] ", ""].join("\n");
		const merged = fillEmptySections(before, "## Notes\n\n- from the model\n");
		expect(merged.text).toBe(
			["## Notes", "- from the model", "", "## Notes", "- [ ] ", ""].join("\n"),
		);
		expect(merged.filled).toEqual(["Notes"]);
	});

	it("leaves a divider the user typed where it is", () => {
		// A lone `---` is the one "empty-looking" body a person types on purpose,
		// and this path replaces a body rather than appending to it.
		const before = ["## Notes", "", "---", ""].join("\n");
		const merged = fillEmptySections(before, "## Notes\n\n- from the model\n");
		expect(merged.text).toBe(before);
		expect(merged.preserved).toEqual(["Notes"]);
	});

	it("appends template sections the note is missing, below what is there", () => {
		// A note the user typed by hand, or one written before the template grew a
		// section, has nothing for the fill path to work with. Without the append
		// it would stay undraftable for that section forever.
		const bare = ["# 26.08.16", "", "## Assistant log", "", "### A question", "", "An answer."].join(
			"\n",
		);
		const merged = fillEmptySections(bare, DRAFT);
		expect(merged.text.startsWith(bare)).toBe(true);
		expect(merged.appended).toContain("Intention");
		expect(merged.appended).not.toContain("26.08.16");
		expect(merged.text).toContain("An answer.");
	});

	it("keeps prose the user wrote under the note's title", () => {
		// The title is not a section the draft fills, but it is a section the note
		// can have a body under, and that body is the user's.
		const before = ["# 26.08.16", "", "Woke up late.", "", "## a", "- [ ] ", ""].join("\n");
		const merged = fillEmptySections(before, "## a\n- [ ] filled\n");
		expect(merged.text).toContain("Woke up late.");
		expect(merged.preserved).toContain("26.08.16");
	});

	it("stays a no-op once the appended sections are there", () => {
		const bare = ["# 26.08.16", "", "## Assistant log", "", "An answer.", ""].join("\n");
		const once = fillEmptySections(bare, DRAFT).text;
		expect(fillEmptySections(once, DRAFT).text).toBe(once);
	});

	it("preserves the note's own preamble", () => {
		const before = ["---", "tags: [mise]", "---", "", "## a", "- [ ] ", ""].join("\n");
		expect(fillEmptySections(before, "## a\n- [ ] filled\n").text.startsWith("---\ntags: [mise]\n---\n")).toBe(
			true,
		);
	});
});

describe("planSignals", () => {
	it("warns about a duplicate note for the same date", () => {
		const plan = planDailyDraft({
			date: DATE,
			existing: {
				note: note("Mise/26.08.16.md", ["Mise/26.08.16 1.md"]),
				text: HALF_WRITTEN_NOTE,
			},
			draft: DRAFT,
		});
		const duplicate = planSignals(plan).find((s) => s.code === "draft-duplicate-note");
		expect(duplicate?.level).toBe("warning");
		expect(duplicate?.text).toContain("Mise/26.08.16 1.md");
	});

	it("says a second run has nothing to do", () => {
		const plan = planDailyDraft({
			date: DATE,
			existing: { note: note("Mise/26.08.16.md"), text: HANDMADE_NOTE },
			draft: DRAFT,
		});
		expect(planSignals(plan).map((s) => s.code)).toEqual(["draft-noop"]);
	});

	it("names the sections it will not touch", () => {
		const plan = planDailyDraft({
			date: DATE,
			existing: { note: note("Mise/26.08.16.md"), text: HALF_WRITTEN_NOTE },
			draft: DRAFT,
		});
		const fill = planSignals(plan).find((s) => s.code === "draft-fill");
		expect(fill?.text).toContain("Intention");
		expect(fill?.text).toContain("Today");
	});
});

describe("confirmWrite", () => {
	const plan = planDailyDraft({
		date: DATE,
		existing: { note: note("Mise/26.08.16.md"), text: HALF_WRITTEN_NOTE },
		draft: DRAFT,
	});

	it("accepts the preview when the note has not moved", () => {
		expect(confirmWrite(plan, HALF_WRITTEN_NOTE, plan.after)).toEqual({
			ok: true,
			text: plan.after,
		});
	});

	it("accepts an edited draft", () => {
		const edited = `${plan.after}\n## Added by hand\n`;
		expect(confirmWrite(plan, HALF_WRITTEN_NOTE, edited)).toEqual({ ok: true, text: edited });
	});

	it("refuses when the note changed while the preview was open", () => {
		const result = confirmWrite(plan, `${HALF_WRITTEN_NOTE}\ntyped meanwhile\n`, plan.after);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("changed while the preview was open");
	});

	it("refuses when the note is missing but the plan expected one", () => {
		expect(confirmWrite(plan, null, plan.after).ok).toBe(false);
	});

	it("refuses to write text identical to what is already there", () => {
		expect(confirmWrite(plan, HALF_WRITTEN_NOTE, HALF_WRITTEN_NOTE).ok).toBe(false);
	});

	it("refuses a create whose target sprang into existence", () => {
		const create = planDailyDraft({ date: DATE, existing: null, draft: DRAFT });
		expect(confirmWrite(create, "someone else got there first", DRAFT).ok).toBe(false);
		expect(confirmWrite(create, null, DRAFT)).toEqual({ ok: true, text: DRAFT });
	});
});

/**
 * A vault that can tell an atomic write from a read followed by a write.
 *
 * `process` applies its callback to the bytes it holds and stores the result,
 * with no gap. `read` and `modify` are the pair it replaces, and they are here
 * so that a change to `applyDraftWrite` that reaches for them shows up in the
 * call log rather than passing quietly.
 */
class FakeWriteVault {
	readonly log: string[] = [];
	constructor(public data: string | null) {}

	create = (path: string, data: string): Promise<string> => {
		this.log.push("create");
		if (this.data !== null) return Promise.reject(new Error(`${path} already exists`));
		this.data = data;
		return Promise.resolve(path);
	};

	process = (_file: string, fn: (data: string) => string): Promise<string> => {
		this.log.push("process");
		const next = fn(this.data ?? "");
		this.data = next;
		return Promise.resolve(next);
	};

	read = (_file: string): Promise<string> => {
		this.log.push("read");
		return Promise.resolve(this.data ?? "");
	};

	modify = (_file: string, data: string): Promise<void> => {
		this.log.push("modify");
		this.data = data;
		return Promise.resolve();
	};
}

describe("applyDraftWrite", () => {
	const plan = planDailyDraft({
		date: DATE,
		existing: { note: note("Mise/26.08.16.md"), text: HALF_WRITTEN_NOTE },
		draft: DRAFT,
	});

	it("checks and writes in one operation, leaving no window between them", async () => {
		// `read` then `modify` narrows the race rather than closing it: Obsidian
		// Sync and the editor's autosave both land in gaps that size, and `modify`
		// would overwrite them with bytes computed before they existed.
		const vault = new FakeWriteVault(HALF_WRITTEN_NOTE);
		const outcome = await applyDraftWrite(plan, plan.after, "file", vault);
		expect(outcome).toEqual({ ok: true });
		expect(vault.log).toEqual(["process"]);
		expect(vault.data).toBe(plan.after);
	});

	it("refuses inside the same operation and leaves the bytes untouched", async () => {
		const moved = `${HALF_WRITTEN_NOTE}typed meanwhile\n`;
		const vault = new FakeWriteVault(moved);
		const outcome = await applyDraftWrite(plan, plan.after, "file", vault);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.reason).toContain("changed while the preview was open");
		expect(vault.data).toBe(moved);
	});

	it("creates a note that does not exist yet", async () => {
		const create = planDailyDraft({ date: DATE, existing: null, draft: DRAFT });
		const vault = new FakeWriteVault(null);
		expect(await applyDraftWrite(create, DRAFT, null, vault)).toEqual({ ok: true });
		expect(vault.log).toEqual(["create"]);
		expect(vault.data).toBe(DRAFT);
	});

	it("lets a create that lost the race fail rather than clobbering", async () => {
		// `Vault.create` throws when the path exists, which is the loud failure
		// this path wants; nothing here catches it.
		const create = planDailyDraft({ date: DATE, existing: null, draft: DRAFT });
		const vault = new FakeWriteVault("someone else got there first");
		await expect(applyDraftWrite(create, DRAFT, null, vault)).rejects.toThrow("already exists");
		expect(vault.data).toBe("someone else got there first");
	});
});
