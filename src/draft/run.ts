// One draft, end to end: read the template, build the pack, ask the model,
// compose the note, decide the write, and hand back everything the preview
// modal needs to show — including every reason the user might want to reject it.
//
// The same shape as `src/chat/turn.ts`, and for the same reason: given a vault
// index, a note reader and a `ChatSend`, the whole feature runs under `vitest`
// with no Obsidian and no Ollama. That is the only way "running it twice is a
// no-op" is provable on a machine with no model on it, and it is the stated
// done-when of PR 6.
//
// Nothing in this file imports `obsidian`.

import { DEFAULT_BUDGET } from "../context/budget";
import { buildContextPack, type NoteReader } from "../context/pack";
import type { ContextBudget, ContextPack } from "../context/types";
import type { ChatSend } from "../chat/turn";
import { type ChatSignal, packSignals, responseSignals } from "../chat/signals";
import { type ChatSource, deriveSources } from "../chat/sources";
import { assessPromptBudget, estimatePromptTokens } from "../ollama/protocol";
import type { ChatHandlers } from "../ollama/client";
import type { OllamaChatMessage } from "../ollama/types";
import { type CalendarDate, dailyNoteStem } from "../vault/dates";
import { DAILY_TEMPLATE_PATH } from "../vault/paths";
import { type VaultIndex, resolveDailyNote } from "../vault/resolver";
import { type DiffLine, diffLines } from "./diff";
import { type DraftWritePlan, planDailyDraft, planSignals } from "./plan";
import { buildDraftInstruction, draftReplySignals, parseDraftReply } from "./prompt";
import { composeFromTemplate, instantiateTemplate, type DailyTemplate } from "./template";

/**
 * The draft's context budget.
 *
 * Identical to the chat's except for the question slot, which holds a generated
 * instruction plus the template's whole outline rather than a typed sentence.
 * Widening it here rather than raising the default keeps the chat's accounting
 * honest — and because everything above the question is unchanged, the cached
 * prefix the two features share is unaffected.
 */
export const DRAFT_BUDGET: ContextBudget = {
	...DEFAULT_BUDGET,
	groups: { ...DEFAULT_BUDGET.groups, question: 1500 },
	perDocument: { ...DEFAULT_BUDGET.perDocument, question: 1500 },
};

export interface DraftTurnDeps {
	readonly index: VaultIndex;
	/** The day being drafted: today, or tomorrow. */
	readonly date: CalendarDate;
	/** Context reads. `cachedRead` in the plugin: assembling a prompt is not editing. */
	readonly read: NoteReader;
	/**
	 * Read of the note about to be written. Defaults to `read`; the plugin
	 * passes an uncached `read` so the diff is against what is on disk, not
	 * against a cache filled before the user started typing into the note.
	 */
	readonly readCurrent?: NoteReader;
	readonly send: ChatSend;
	readonly numCtx: number;
	readonly numPredict: number;
	readonly budget?: ContextBudget;
	/** Overridable so a test can point at a second template shape. */
	readonly templatePath?: string;
}

export interface DraftTurnRequest {
	readonly deps: DraftTurnDeps;
	/** Streamed tokens, so the modal can show the reply arriving. */
	readonly onToken?: (text: string) => void;
	/** Mid-flight notices, e.g. streaming gave up and the reply is buffered. */
	readonly onSignal?: (signal: ChatSignal) => void;
	readonly signal?: AbortSignal;
}

export interface DraftTurnResult {
	readonly date: CalendarDate;
	readonly template: DailyTemplate;
	readonly pack: ContextPack;
	/** The model's reply, verbatim, for the "what did it actually say" case. */
	readonly reply: string;
	/** The note as the draft would have it, before any merge with an existing note. */
	readonly draft: string;
	readonly plan: DraftWritePlan;
	readonly diff: readonly DiffLine[];
	readonly sources: readonly ChatSource[];
	/**
	 * Everything the user should weigh before accepting: vault gaps, dropped or
	 * truncated documents, a prompt Ollama silently decapitated, a reply stopped
	 * by `num_predict`, an answer that was buffered rather than streamed, and
	 * what the write itself would do.
	 */
	readonly signals: readonly ChatSignal[];
}

/**
 * Draft the note for `deps.date`.
 *
 * Throws rather than swallowing: unlike a chat turn, whose failure is a message
 * in a transcript, a draft that fails has nothing to show and the caller has a
 * modal to either open or not open.
 */
export async function runDraftTurn(request: DraftTurnRequest): Promise<DraftTurnResult> {
	const { deps } = request;
	const templatePath = deps.templatePath ?? DAILY_TEMPLATE_PATH;
	const stem = dailyNoteStem(deps.date);

	let templateText: string;
	try {
		templateText = await deps.read(templatePath);
	} catch (error) {
		throw new Error(
			`Could not read the daily-note template at ${templatePath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const template = instantiateTemplate(templateText, stem);

	const pack = await buildContextPack(
		{
			index: deps.index,
			date: deps.date,
			question: buildDraftInstruction(template.headings),
			budget: deps.budget ?? DRAFT_BUDGET,
		},
		deps.read,
	);

	// Gaps first, and before the model is even asked: "no `26 W32 Goals` — using
	// `26 W31 Goals`" is the difference between a draft grounded in this week's
	// plan and one grounded in a fortnight-old plan, and the user has to be able
	// to see that next to the draft they are deciding whether to accept.
	const signals: ChatSignal[] = [...packSignals(pack)];

	const messages: OllamaChatMessage[] = pack.messages.map((message) => ({
		role: message.role,
		content: message.content,
	}));

	const preflight = assessPromptBudget({
		estimatedPromptTokens: estimatePromptTokens(messages),
		numCtx: deps.numCtx,
		numPredict: deps.numPredict,
	});
	if (preflight.status !== "ok") {
		signals.push({
			code: `prompt-budget-${preflight.status}`,
			level: "warning",
			text: preflight.message,
		});
	}

	const handlers: ChatHandlers = {
		...(request.onToken === undefined ? {} : { onToken: request.onToken }),
		onStreamingUnavailable: (reason) =>
			request.onSignal?.({
				code: "streaming-unavailable",
				level: "info",
				text: `Streaming failed (${reason}); waiting for the whole draft at once.`,
			}),
	};

	const result = await deps.send(messages, handlers, request.signal);
	// The client's own signals: a prompt pinned at `num_ctx` (so the goal docs at
	// the top were dropped by the runtime), a reply stopped at the `num_predict`
	// cap rather than by the model, and a buffered rather than streamed answer.
	// A silently truncated daily note is worse than a failed one.
	signals.push(...responseSignals(result));

	const parsed = parseDraftReply(result.content, template.headings);
	// Counted against the headings the model was actually asked for, so a clean
	// run does not report the note's own title as a section it failed to write.
	signals.push(...draftReplySignals(parsed, template.fillable.length));

	const draft = composeFromTemplate(template, parsed.filled);

	const existingNote = resolveDailyNote(deps.index, deps.date);
	const readCurrent = deps.readCurrent ?? deps.read;
	const existing =
		existingNote === null
			? null
			: { note: existingNote, text: await readCurrent(existingNote.path) };

	const plan = planDailyDraft({ date: deps.date, existing, draft });
	signals.push(...planSignals(plan));

	return {
		date: deps.date,
		template,
		pack,
		reply: result.content,
		draft,
		plan,
		diff: diffLines(plan.before, plan.after),
		sources: deriveSources(pack),
		signals,
	};
}
