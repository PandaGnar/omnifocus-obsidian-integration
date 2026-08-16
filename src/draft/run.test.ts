import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fakeModel } from "../chat/fixtures/harness";
import { buildContextPack } from "../context/pack";
import { addDays, dailyNoteStem } from "../vault/dates";
import { DAILY_TEMPLATE_PATH } from "../vault/paths";
import { isNoOpDiff } from "./diff";
import { fixtureVault, type FakeVault } from "./fixtures/harness";
import {
	ALT_TEMPLATE_TEXT,
	HALF_WRITTEN_NOTE,
	HANDMADE_NOTE,
	MODEL_REPLY,
	TEMPLATE_TEXT,
} from "./fixtures/template";
import { headingOutline, parseNote } from "./sections";
import { type DraftTurnResult, runDraftTurn } from "./run";

/** 2026-08-16, the fixture vault's "today": ISO week 33, quarter 3. */
const TODAY = { year: 2026, month: 8, day: 16 };
/** Inside ISO week 32, which the fixture vault has no goal doc for. */
const IN_THE_W32_GAP = { year: 2026, month: 8, day: 5 };
/** The fixture vault's daily note for today, so `create` needs it gone. */
const TODAYS_NOTE = "Mise/26.08.16.md";

interface RunOptions {
	readonly vault?: FakeVault;
	readonly date?: { year: number; month: number; day: number };
	readonly reply?: string;
	readonly promptEvalCount?: number;
	readonly numCtx?: number;
	readonly doneReason?: string;
	readonly streamed?: boolean;
	readonly onSent?: (messages: readonly { role: string; content: string }[]) => void;
}

async function draft(options: RunOptions = {}): Promise<DraftTurnResult> {
	const vault = options.vault ?? fixtureVault({ omit: [TODAYS_NOTE] });
	const model = fakeModel({
		tokens: [options.reply ?? MODEL_REPLY],
		...(options.promptEvalCount === undefined
			? {}
			: { promptEvalCount: options.promptEvalCount }),
		...(options.numCtx === undefined ? {} : { numCtx: options.numCtx }),
		...(options.doneReason === undefined ? {} : { doneReason: options.doneReason }),
		...(options.streamed === undefined ? {} : { streamed: options.streamed }),
		...(options.onSent === undefined ? {} : { onSend: options.onSent }),
	});
	return runDraftTurn({
		deps: {
			index: vault.index(),
			date: options.date ?? TODAY,
			read: vault.read,
			send: model.send,
			numCtx: 32_768,
			numPredict: 2048,
		},
	});
}

/** Accept the plan the way the modal does: write `after` to `path`. */
function accept(vault: FakeVault, result: DraftTurnResult): void {
	vault.write(result.plan.path, result.plan.after);
}

describe("drafting a day with no note", () => {
	it("proposes a new note flat in Mise/", async () => {
		const result = await draft();
		expect(result.plan.action).toBe("create");
		expect(result.plan.path).toBe(TODAYS_NOTE);
	});

	it("produces a note with the template's heading structure", async () => {
		const result = await draft();
		expect(headingOutline(result.plan.after)).toEqual(
			headingOutline(TEMPLATE_TEXT.replace(/xx\.xx\.xx/g, "26.08.16")),
		);
	});

	it("produces a note structurally identical to a hand-made one", async () => {
		// PR 6's stated done-when, end to end: template read from the vault,
		// pack built, model asked, note composed.
		const result = await draft();
		expect(headingOutline(result.plan.after)).toEqual(headingOutline(HANDMADE_NOTE));
	});

	it("carries the model's content into the right sections", async () => {
		const result = await draft();
		const today = parseNote(result.plan.after).sections.find((s) => s.key === "today");
		expect(today?.bodyLines.join("\n")).toContain("Send the invoice");
	});

	it("writes nothing by itself", async () => {
		const vault = fixtureVault({ omit: [TODAYS_NOTE] });
		await draft({ vault });
		// The turn returns a plan; only the modal's accept button writes.
		expect(vault.has(TODAYS_NOTE)).toBe(false);
	});
});

describe("running it twice", () => {
	it("is a no-op the second time", async () => {
		const vault = fixtureVault({ omit: [TODAYS_NOTE] });

		const first = await draft({ vault });
		expect(first.plan.action).toBe("create");
		accept(vault, first);
		const written = vault.textOf(TODAYS_NOTE);

		const second = await draft({ vault });
		expect(second.plan.action).toBe("noop");
		expect(isNoOpDiff(second.diff)).toBe(true);
		expect(second.plan.after).toBe(written);

		// And accepting it anyway changes nothing.
		accept(vault, second);
		expect(vault.textOf(TODAYS_NOTE)).toBe(written);
	});

	it("still creates exactly one file for the date", async () => {
		const vault = fixtureVault({ omit: [TODAYS_NOTE] });
		accept(vault, await draft({ vault }));
		accept(vault, await draft({ vault }));
		accept(vault, await draft({ vault }));
		const stem = dailyNoteStem(TODAY);
		const forToday = vault.paths().filter((path) => path.includes(stem));
		expect(forToday).toEqual([TODAYS_NOTE]);
	});

	it("says so rather than showing an empty preview", async () => {
		const vault = fixtureVault({ omit: [TODAYS_NOTE] });
		accept(vault, await draft({ vault }));
		const second = await draft({ vault });
		expect(second.signals.map((s) => s.code)).toContain("draft-noop");
	});
});

describe("a note that already exists", () => {
	it("never proposes a second file for the date", async () => {
		const vault = fixtureVault();
		vault.write(TODAYS_NOTE, HALF_WRITTEN_NOTE);
		const result = await draft({ vault });
		expect(result.plan.action).toBe("fill");
		expect(result.plan.path).toBe(TODAYS_NOTE);
	});

	it("fills only the empty sections", async () => {
		const vault = fixtureVault();
		vault.write(TODAYS_NOTE, HALF_WRITTEN_NOTE);
		const result = await draft({ vault });
		expect(result.plan.after).toContain("Do not touch this line.");
		expect(result.plan.after).not.toContain("Finish the migration rehearsal");
		expect(result.plan.preservedHeadings).toEqual(["Intention", "Today"]);
	});

	it("writes into a bucketed note rather than creating a flat one beside it", async () => {
		// `Mise/26.06/26.05.28.md` is a May note in a June bucket, which is how
		// the real vault is filed. The draft must land in it.
		const vault = fixtureVault();
		const result = await draft({ vault, date: { year: 2026, month: 5, day: 28 } });
		expect(result.plan.path).toBe("Mise/26.06/26.05.28.md");
		expect(result.plan.action).not.toBe("create");
	});

	it("writes into the note the resolver picked, not the collision suffix", async () => {
		// `Mise/26.07/26.07.02 1.md` is in the fixture tree because this happened
		// in the real vault. Drafting 26.07.02 must land in the original.
		const vault = fixtureVault();
		const result = await draft({ vault, date: { year: 2026, month: 7, day: 2 } });
		expect(result.plan.path).toBe("Mise/26.07/26.07.02.md");
		expect(result.plan.duplicates).toEqual(["Mise/26.07/26.07.02 1.md"]);
		expect(result.signals.map((s) => s.code)).toContain("draft-duplicate-note");
	});
});

describe("drafting tomorrow", () => {
	it("targets the next day and can still see today's note", async () => {
		const vault = fixtureVault();
		const tomorrow = addDays(TODAY, 1);
		const result = await draft({ vault, date: tomorrow });
		expect(result.plan.path).toBe(`Mise/${dailyNoteStem(tomorrow)}.md`);
		expect(result.plan.action).toBe("create");
		expect(result.sources.map((s) => s.path)).toContain("Mise/26.08.14.md");
	});
});

describe("signals reaching the user", () => {
	it("reports the goal-doc gap the draft was grounded in", async () => {
		// The vault has W29-W31 and W33 but no W32. A draft for 5 August is built
		// on `26 W31 Goals`, and the user has to be told before they accept it.
		const vault = fixtureVault();
		const result = await draft({ vault, date: IN_THE_W32_GAP });
		const gap = result.signals.find(
			(s) => s.code === "context-gap" && s.text.includes("W32"),
		);
		expect(gap?.level).toBe("warning");
		expect(gap?.text).toContain("no `26 W32 Goals`");
		expect(gap?.text).toContain("using `26 W31 Goals`");
	});

	it("reports a prompt Ollama silently truncated", async () => {
		const result = await draft({ promptEvalCount: 4096, numCtx: 4096 });
		expect(result.signals.map((s) => [s.code, s.level])).toContainEqual([
			"prompt-truncated",
			"warning",
		]);
	});

	it("reports a reply stopped by the num_predict cap", async () => {
		const result = await draft({ doneReason: "length" });
		expect(result.signals.map((s) => [s.code, s.level])).toContainEqual([
			"reply-capped",
			"warning",
		]);
	});

	it("reports an answer that was buffered rather than streamed", async () => {
		const result = await draft({ streamed: false });
		expect(result.signals.map((s) => s.code)).toContain("not-streamed");
	});

	it("warns when the model filled nothing", async () => {
		const result = await draft({ reply: "I have nothing to suggest." });
		expect(result.signals.map((s) => [s.code, s.level])).toContainEqual([
			"draft-empty",
			"warning",
		]);
	});

	it("reports only the gaps the vault actually has", async () => {
		// The fixture vault has `26 W33` but no `26 M08`, so today's draft is
		// grounded in July's month goals and says so — and says nothing else.
		const result = await draft();
		expect(result.signals.filter((s) => s.code === "context-gap").map((s) => s.text)).toEqual([
			"no `26 M08 Goals` - using `26 M07 Goals`",
		]);
		const codes = result.signals.map((s) => s.code);
		expect(codes).not.toContain("prompt-truncated");
		expect(codes).not.toContain("reply-capped");
		expect(codes).not.toContain("not-streamed");
		expect(codes).not.toContain("draft-empty");
	});
});

describe("the prompt", () => {
	it("puts the instruction last and the standing context first", async () => {
		let sent: readonly { role: string; content: string }[] = [];
		await draft({ onSent: (messages) => (sent = messages) });
		expect(sent[0]?.role).toBe("system");
		expect(sent[0]?.content).toContain("Life goals");
		const last = sent[sent.length - 1];
		expect(last?.role).toBe("user");
		expect(last?.content).toContain("Draft my daily note");
	});

	it("keeps the date out of the cacheable prefix", async () => {
		let sent: readonly { role: string; content: string }[] = [];
		await draft({ onSent: (messages) => (sent = messages) });
		const prefix = sent.slice(0, -1).map((m) => m.content).join("\n");
		expect(prefix).not.toContain("August");
		expect(sent[sent.length - 1]?.content).toContain("Sunday 16 August 2026");
	});

	it("puts the template outline in the question and nowhere else", async () => {
		let sent: readonly { role: string; content: string }[] = [];
		await draft({ onSent: (messages) => (sent = messages) });
		const prefix = sent.slice(0, -1).map((m) => m.content).join("\n");
		expect(prefix).not.toContain("## Waiting on");
		expect(sent[sent.length - 1]?.content).toContain("## Waiting on");
	});

	it("does not ask the model to write under the note's date title", async () => {
		// The title is a name for the day. Asked for, it gets a paragraph above
		// the first `##` that no hand-made note has — and it is reported as an
		// unfilled section on every otherwise clean run.
		let sent: readonly { role: string; content: string }[] = [];
		const result = await draft({ onSent: (messages) => (sent = messages) });
		const instruction = sent[sent.length - 1]?.content ?? "";
		expect(instruction).toContain("## Intention");
		expect(instruction).not.toContain("# 26.08.16");
		const unfilled = result.signals.find((s) => s.code === "draft-unfilled");
		expect(unfilled?.text).toBe("1 of 7 sections were left as the template wrote them: Schedule.");
	});

	it("shares its cacheable prefix with a chat turn on the same day", async () => {
		// The instruction sits in the question slot precisely so that drafting and
		// asking reuse one KV cache. Move it into the system prompt and the two
		// features fork into separate prefix lineages, each paying a cold prefill
		// every time the user switches — invisible except as slowness.
		const vault = fixtureVault({ omit: [TODAYS_NOTE] });
		let sent: readonly { role: string; content: string }[] = [];
		await draft({ vault, onSent: (messages) => (sent = messages) });
		const chat = await buildContextPack(
			{ index: vault.index(), date: TODAY, question: "What should I focus on today?" },
			vault.read,
		);
		// Both being `undefined` would satisfy `toBe`, so the harness is checked
		// before the property is.
		expect(sent[0]?.content).toBeTypeOf("string");
		expect(sent[0]?.content).not.toBe("");
		expect(sent[0]?.content).toBe(chat.messages[0]?.content);
	});

	it("sends the same stable block on two runs a template edit apart", async () => {
		// The stable block is the expensive part of the prefill, and the template
		// is not in it — the outline goes in the question slot at the bottom. So
		// editing the template between two runs must change the instruction and
		// leave the cached prefix alone.
		const vault = fixtureVault({ omit: [TODAYS_NOTE] });
		const first: string[] = [];
		const last: string[] = [];
		const take = (messages: readonly { role: string; content: string }[]): void => {
			first.push(messages[0]?.content ?? "");
			last.push(messages[messages.length - 1]?.content ?? "");
		};

		await draft({ vault, onSent: take });
		vault.write(DAILY_TEMPLATE_PATH, `${TEMPLATE_TEXT}## Later\n\n`);
		await draft({ vault, onSent: take });

		expect(first).toHaveLength(2);
		expect(first[0]).toBeTypeOf("string");
		expect(first[0]).not.toBe("");
		expect(first[0]).toBe(first[1]);
		// And the edit really did reach the prompt, below the stable block.
		expect(last[0]).not.toContain("## Later");
		expect(last[1]).toContain("## Later");
	});

	it("quotes the template's own headings, whatever they are", async () => {
		const vault = fixtureVault({ omit: [TODAYS_NOTE] });
		vault.write(DAILY_TEMPLATE_PATH, ALT_TEMPLATE_TEXT);
		let sent: readonly { role: string; content: string }[] = [];
		const result = await draft({ vault, onSent: (messages) => (sent = messages) });
		const instruction = sent[sent.length - 1]?.content ?? "";
		expect(instruction).toContain("#### Later");
		expect(instruction).not.toContain("## Intention");
		expect(headingOutline(result.plan.after)).toEqual(headingOutline(ALT_TEMPLATE_TEXT));
	});
});

describe("failures", () => {
	it("explains a missing template rather than inventing one", async () => {
		const vault = fixtureVault({ omit: [TODAYS_NOTE, DAILY_TEMPLATE_PATH] });
		await expect(draft({ vault })).rejects.toThrow(/template/i);
	});

	it("lets a model failure out rather than half-writing a note", async () => {
		const vault = fixtureVault({ omit: [TODAYS_NOTE] });
		const model = fakeModel({ failWith: new Error("connection refused") });
		await expect(
			runDraftTurn({
				deps: {
					index: vault.index(),
					date: TODAY,
					read: vault.read,
					send: model.send,
					numCtx: 32_768,
					numPredict: 2048,
				},
			}),
		).rejects.toThrow("connection refused");
		expect(vault.has(TODAYS_NOTE)).toBe(false);
	});
});

describe("no obsidian dependency", () => {
	// Any way a module can reach the package, not just the single-line `import`
	// that a formatter would break the moment a third symbol is added. A bare
	// type import type-checks and `obsidian` is an esbuild external, so nothing
	// else in the toolchain would notice a module that quietly acquired one.
	const REACHES_OBSIDIAN = /["']obsidian["']/;

	it("catches every way a module can reach the package", () => {
		// The guard's own guard: a pattern that matched nothing would pass the
		// test below on every file in the tree.
		for (const form of [
			'import { App } from "obsidian";',
			"import type { App } from 'obsidian';",
			'import "obsidian";',
			'import {\n\tApp,\n\tTFile,\n} from "obsidian";',
			'export { Modal } from "obsidian";',
			'export * from "obsidian";',
			'const { App } = require("obsidian");',
			'const m = await import("obsidian");',
		]) {
			expect(form).toMatch(REACHES_OBSIDIAN);
		}
		expect('import { addDays } from "../vault/dates";').not.toMatch(REACHES_OBSIDIAN);
	});

	it("imports nothing from obsidian anywhere under src/draft except the modal", () => {
		// Same guard as `src/vault/resolver.test.ts`, `src/context/pack.test.ts`
		// and `src/chat/turn.test.ts`. `modal.ts` is the deliberate exception: it
		// is the Obsidian shell, and everything worth testing was kept out of it
		// on purpose — the template parser, the merge, the diff and the plan all
		// live in files this guard covers. This file is the other exception: the
		// samples above are the very strings the pattern looks for.
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((entry) => {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) return walk(full);
				return full.endsWith(".ts") ? [full] : [];
			});

		const self = fileURLToPath(import.meta.url);
		const files = walk(dirname(self)).filter(
			(file) => !file.endsWith("modal.ts") && file !== self,
		);
		// Not vacuous: the walk found the whole directory, not an empty list.
		expect(files.length).toBeGreaterThan(8);
		expect(files.some((file) => file.endsWith("plan.ts"))).toBe(true);
		expect(files.some((file) => file.endsWith(join("fixtures", "harness.ts")))).toBe(true);
		for (const file of files) {
			expect(readFileSync(file, "utf8")).not.toMatch(REACHES_OBSIDIAN);
		}
	});
});
