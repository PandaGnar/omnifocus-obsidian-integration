// Assembles the context pack: the exact bytes the model is asked to read,
// in the exact order it reads them.
//
// Ordering is the whole point of this module, and it is a performance feature
// rather than a matter of taste. Ollama reuses the KV cache across requests by
// *longest common prefix*: if a follow-up question shares a prefix with the
// previous request and the model is still loaded, only the new tail is
// prefilled. One changed byte near the top throws all of that away and the user
// waits for a cold 17K-token prefill again.
//
// So the pack is ordered most-stable to least-stable:
//
//     system prompt
//     Life Goals and the other standing background docs
//     Y+ goals -> Quarter goals -> Month goals -> Week goals
//     the last N daily notes, oldest first
//     [reserved slot for retrieved chunks - empty, see below]
//     conversation
//     today's date
//     the question
//
// Three consequences worth stating out loud, because each is a rule the code
// below enforces rather than a description of what it happens to do:
//
//   - **No date anywhere near the top.** Not in the system prompt, not in a
//     header, not as "today is ...". The current date changes daily, and a
//     changed byte in the prefix costs the whole cache. It goes immediately
//     before the question, at the very bottom. Goal doc *names* (`26 W33
//     Goals`) do appear high up, but they identify a document rather than the
//     current instant, and they only change when the document does.
//
//   - **The retrieval slot sits after the stable block and before the
//     conversation.** It is a documented seam, not an implementation: PR-future
//     RAG chunks land there, and because they land *after* everything stable,
//     turning retrieval on cannot invalidate the cached goal docs above it.
//
//   - **Nothing is serialised from a Map, a Set, or `Object.keys`.** Every list
//     here comes from a `const` array or from `VaultIndex`, which sorts its
//     paths on the way in. Two runs over the same vault produce byte-identical
//     output; `pack.test.ts` asserts it, including under a permuted input path
//     array.
//
// Nothing in this module imports `obsidian`. Document text arrives through an
// injected `NoteReader`, so the whole assembler is testable with a literal
// object of fake note contents.

import { type CalendarDate, dailyNoteStem, isoWeek, pad2, shortYear } from "../vault/dates";
import {
	GOAL_HORIZONS,
	type GoalHorizon,
	type VaultIndex,
	resolveGoalDoc,
	resolveMostRecentDailyNoteBefore,
} from "../vault/resolver";
import { DEFAULT_BUDGET, applyBudget, headroomTokens, packBudgetTokens } from "./budget";
import { PER_MESSAGE_OVERHEAD_TOKENS, estimateTokens, truncateToTokens } from "./tokens";
import {
	type ContextBudget,
	type ContextPack,
	type ConversationTurn,
	type PackMessage,
	type PackNotice,
	type PackSection,
	type SectionGroup,
	type SectionKind,
} from "./types";

/**
 * Standing instructions. Deliberately free of dates, names, counts, and
 * anything else that varies between runs — this is the first thing in the
 * prompt and therefore the most expensive place in the file to change.
 */
export const SYSTEM_PROMPT = [
	"You are a planning assistant working inside the user's Obsidian vault.",
	"",
	"You are given the user's long-term planning documents, then their most",
	"recent daily notes, then the conversation so far, then the question.",
	"The documents are ordered from longest horizon to shortest; when they",
	"disagree, the shorter horizon is the more recent decision and wins.",
	"",
	"Ground every answer in the documents you were given. Quote or name the",
	"document you are drawing on. If the documents do not answer the question,",
	"say so plainly rather than inventing a plan the user did not write.",
	"Some documents may be missing or truncated; a note in the header says so",
	"when they are, and you should treat that as a gap rather than as evidence",
	"that the user has no goals at that horizon.",
	"",
	"Match the user's own vocabulary and the structure of their notes. Be",
	"concise; they are reading this between tasks.",
].join("\n");

/** Placeholder used by the `show context pack` command, which has no question. */
export const PREVIEW_QUESTION =
	"(preview - no question asked; this is what the standing context looks like)";

export interface StandingDoc {
	readonly path: string;
	readonly title: string;
}

/**
 * The rarely-changing docs listed in `docs/vault-conventions.md`, most
 * load-bearing first. Order is fixed here rather than derived from the vault,
 * because deriving it would let a file rename reshuffle the prompt prefix.
 *
 * Life Goals leads and is the last thing the budget will ever drop; the rest
 * are background and are dropped from the bottom of this list upwards.
 */
export const STANDING_CONTEXT_DOCS: readonly StandingDoc[] = [
	{ path: "Long Term/Life Goals.md", title: "Life goals" },
	{ path: "Long Term/Getting Unstuck Checklist.md", title: "Getting unstuck checklist" },
	{ path: "Long Term/Childcare.md", title: "Childcare" },
	{ path: "Financial Planning.md", title: "Financial planning" },
	{ path: "Long Term.md", title: "Long term" },
	{ path: "The Work.md", title: "The work" },
];

const HORIZON_TITLES: Readonly<Record<GoalHorizon, string>> = {
	yearPlus: "Multi-year goals",
	quarter: "Quarter goals",
	month: "Month goals",
	week: "Week goals",
};

// --- drop order ------------------------------------------------------------
//
// When the pack is over budget something has to go, and *which* thing has to be
// the same on every run. Ranks are assigned at assembly time; lower goes first:
//
//   100+  recent daily notes, oldest first. Colour rather than commitment, and
//         the oldest is the least likely to be what the question is about.
//   200+  background standing docs, reverse of their declared order, so `The
//         Work` goes before `Getting Unstuck Checklist`.
//   300+  conversation turns, oldest first. Losing old turns is visible to the
//         user and recoverable by asking again; losing a goal doc is neither.
//   400+  goal docs, longest horizon first: Y+, then quarter, month, week. The
//         week doc is the one a daily plan is actually built from.
//   500   Life Goals.
//
// Never dropped: the system prompt, the retrieval slot, today's date, and the
// question. A pack that has dropped all of the above and is still over budget
// is reported as an overflow rather than quietly mangled.
const DROP_RANK = {
	daily: 100,
	background: 200,
	conversation: 300,
	goal: 400,
	lifeGoals: 500,
} as const;

// --- section construction --------------------------------------------------

interface SectionInput {
	readonly id: string;
	readonly kind: SectionKind;
	readonly group: SectionGroup;
	readonly title: string;
	readonly path: string | null;
	readonly text: string;
	readonly truncated?: boolean;
	readonly messageRole?: "user" | "assistant" | null;
	readonly dropRank: number | null;
}

function makeSection(input: SectionInput): PackSection {
	return {
		id: input.id,
		kind: input.kind,
		group: input.group,
		title: input.title,
		path: input.path,
		text: input.text,
		tokens: estimateTokens(input.text),
		truncated: input.truncated ?? false,
		messageRole: input.messageRole ?? null,
		dropRank: input.dropRank,
	};
}

/**
 * One document as it appears in the prompt. The `Source:` line is there so the
 * model can name what it used and PR 5 can turn that into a clickable link, and
 * the optional `Note:` line is where a resolver fallback is admitted to rather
 * than papered over.
 */
function renderDocument(
	title: string,
	path: string,
	note: string | null,
	body: string,
): string {
	const header = [`## ${title}`, `Source: ${path}`];
	if (note !== null) header.push(`Note: ${note}`);
	return `${header.join("\n")}\n\n${body}`;
}

// --- dates -----------------------------------------------------------------
//
// Formatted from constant tables rather than `toLocaleDateString`, which would
// make the prompt depend on the host's locale and time zone. Two machines
// asking the same question on the same day should produce the same bytes.

const WEEKDAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

/** `Sunday 16 August 2026`. */
export function formatLongDate(date: CalendarDate): string {
	const weekday = WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
	const month = MONTHS[date.month - 1];
	return `${weekday} ${date.day} ${month} ${date.year}`;
}

/** `2026-08-16`. */
export function formatIsoDate(date: CalendarDate): string {
	return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

// --- assembly --------------------------------------------------------------

/** Injected content reader. Rejecting is fine; the pack reports and moves on. */
export type NoteReader = (path: string) => Promise<string>;

export interface ContextPackRequest {
	readonly index: VaultIndex;
	/** The day the pack is *for*. Only ever rendered at the bottom. */
	readonly date: CalendarDate;
	readonly question: string;
	readonly conversation?: readonly ConversationTurn[];
	readonly budget?: ContextBudget;
	readonly systemPrompt?: string;
}

/** A document the pack wants, before its contents have been read. */
interface DocRequest {
	readonly id: string;
	readonly kind: SectionKind;
	readonly group: SectionGroup;
	readonly title: string;
	readonly path: string;
	readonly note: string | null;
	readonly cap: number;
	readonly dropRank: number;
}

export async function buildContextPack(
	request: ContextPackRequest,
	read: NoteReader,
): Promise<ContextPack> {
	const budget = request.budget ?? DEFAULT_BUDGET;
	const index = request.index;
	const date = request.date;
	const conversation = request.conversation ?? [];
	const notices: PackNotice[] = [];
	const docs: DocRequest[] = [];

	// --- standing background docs, in their declared order -----------------
	STANDING_CONTEXT_DOCS.forEach((doc, i) => {
		if (!index.paths.includes(doc.path)) {
			notices.push({
				kind: "missing",
				text: `standing doc not in the vault: ${doc.path}`,
			});
			return;
		}
		docs.push({
			id: `standing:${doc.path}`,
			kind: "standing",
			group: "stable",
			title: doc.title,
			path: doc.path,
			note: null,
			cap: budget.perDocument.standing,
			dropRank:
				i === 0
					? DROP_RANK.lifeGoals
					: DROP_RANK.background + (STANDING_CONTEXT_DOCS.length - 1 - i),
		});
	});

	// --- goal docs, longest horizon first -----------------------------------
	GOAL_HORIZONS.forEach((horizon, i) => {
		const resolved = resolveGoalDoc(index, horizon, date);
		if (resolved.path === null || resolved.label === null) {
			notices.push({
				kind: "missing",
				text: `no ${HORIZON_TITLES[horizon].toLowerCase()} doc at or before \`${resolved.requestedLabel}\``,
			});
			return;
		}
		// A fallback is surfaced, never silently substituted: the vault has real
		// gaps (2026 has no W32, no M08) and an answer built on last week's plan
		// while claiming to be about this week is worse than no answer.
		let note: string | null = null;
		if (!resolved.exact) {
			note = `no \`${resolved.requestedLabel}\` note exists, so this is the most recent doc at this horizon`;
			notices.push({
				kind: "gap",
				text: `no \`${resolved.requestedLabel}\` - using \`${resolved.label}\``,
			});
		}
		for (const duplicate of resolved.duplicates) {
			notices.push({
				kind: "duplicate",
				text: `ignoring duplicate of \`${resolved.label}\`: ${duplicate}`,
			});
		}
		docs.push({
			id: `goal:${horizon}`,
			kind: "goal",
			group: "stable",
			title: `${HORIZON_TITLES[horizon]} - ${resolved.label}`,
			path: resolved.path,
			note,
			cap: budget.perDocument.goal,
			dropRank: DROP_RANK.goal + i,
		});
	});

	// --- the last N daily notes, oldest first -------------------------------
	//
	// Walked backwards through the resolver rather than by subtracting days:
	// 26.08.02, 26.08.07 and 26.08.15 do not exist, and "the last five notes"
	// means the last five that were written. Strictly *before* `date`, so that
	// drafting today's note never feeds today's note back in.
	const dailies: { path: string; date: CalendarDate; duplicates: readonly string[] }[] = [];
	let cursor = date;
	for (let i = 0; i < budget.dailyNoteCount; i += 1) {
		const note = resolveMostRecentDailyNoteBefore(index, cursor);
		if (note === null) break;
		dailies.push({ path: note.path, date: note.date, duplicates: note.duplicates });
		cursor = note.date;
	}
	dailies.reverse();
	dailies.forEach((daily, i) => {
		for (const duplicate of daily.duplicates) {
			notices.push({
				kind: "duplicate",
				text: `ignoring duplicate of \`${dailyNoteStem(daily.date)}\`: ${duplicate}`,
			});
		}
		docs.push({
			id: `daily:${dailyNoteStem(daily.date)}`,
			kind: "daily",
			group: "dailies",
			title: `Daily note ${dailyNoteStem(daily.date)}`,
			path: daily.path,
			note: null,
			cap: budget.perDocument.daily,
			dropRank: DROP_RANK.daily + i,
		});
	});

	// --- read the documents -------------------------------------------------
	//
	// Sequentially, in the order assembled above. Sequential rather than
	// Promise.all so an unreadable note is attributed to the right document and
	// so the vault is not asked for a dozen files at once for no gain: the whole
	// candidate set is a dozen files.
	const docSections: PackSection[] = [];
	for (const doc of docs) {
		let raw: string;
		try {
			raw = await read(doc.path);
		} catch (error) {
			notices.push({
				kind: "unreadable",
				text: `could not read ${doc.path}: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		const body = raw.trim();
		if (body.length === 0) {
			notices.push({ kind: "empty", text: `skipping empty note: ${doc.path}` });
			continue;
		}
		const cut = truncateToTokens(body, doc.cap);
		if (cut.truncated) {
			notices.push({
				kind: "truncated",
				text: `${doc.path} truncated to the ${doc.cap}-token per-document cap (estimated ${cut.originalTokens} tokens)`,
			});
		}
		docSections.push(
			makeSection({
				id: doc.id,
				kind: doc.kind,
				group: doc.group,
				title: doc.title,
				path: doc.path,
				text: renderDocument(doc.title, doc.path, doc.note, cut.text),
				truncated: cut.truncated,
				dropRank: doc.dropRank,
			}),
		);
	}

	// --- sections, in wire order --------------------------------------------
	const sections: PackSection[] = [];

	sections.push(
		makeSection({
			id: "system",
			kind: "system",
			group: "system",
			title: "System prompt",
			path: null,
			text: request.systemPrompt ?? SYSTEM_PROMPT,
			dropRank: null,
		}),
	);

	for (const section of docSections) {
		if (section.group === "stable") sections.push(section);
	}
	for (const section of docSections) {
		if (section.group === "dailies") sections.push(section);
	}

	// The reserved retrieval seam. It contributes no bytes today; its allowance
	// is charged against the budget anyway (see `budget.ts`) so that filling it
	// later cannot push the pack over `num_ctx`. Anything inserted here lands
	// after every stable document and before the conversation, which is the only
	// position that leaves the cached prefix above it intact.
	sections.push(
		makeSection({
			id: "retrieved",
			kind: "retrieved",
			group: "retrieved",
			title: "Retrieved chunks (reserved, not implemented)",
			path: null,
			text: "",
			dropRank: null,
		}),
	);

	conversation.forEach((turn, i) => {
		const cut = truncateToTokens(turn.text.trim(), budget.perDocument.conversationTurn);
		if (cut.truncated) {
			notices.push({
				kind: "truncated",
				text: `conversation turn ${i + 1} truncated to the ${budget.perDocument.conversationTurn}-token cap`,
			});
		}
		sections.push(
			makeSection({
				id: `conversation:${i}`,
				kind: "conversation",
				group: "conversation",
				title: `Conversation turn ${i + 1} (${turn.role})`,
				path: null,
				text: cut.text,
				truncated: cut.truncated,
				messageRole: turn.role,
				dropRank: DROP_RANK.conversation + i,
			}),
		);
	});

	// The date. Bottom of the prompt on purpose - see the header of this file.
	const { weekYear, week } = isoWeek(date);
	sections.push(
		makeSection({
			id: "date",
			kind: "date",
			group: "question",
			title: "Today's date",
			path: null,
			text: `Today is ${formatLongDate(date)} (ISO week ${shortYear(weekYear)} W${pad2(week)}).`,
			dropRank: null,
		}),
	);

	// The question is never truncated and never dropped. If it does not fit,
	// that is worth saying out loud rather than answering a question the user
	// did not finish asking.
	const questionText = `Question:\n${request.question.trim()}`;
	const questionTokens = estimateTokens(questionText);
	if (questionTokens > budget.perDocument.question) {
		notices.push({
			kind: "overflow",
			text: `the question is an estimated ${questionTokens} tokens, over its ${budget.perDocument.question}-token allowance; it is sent in full and context is dropped to make room`,
		});
	}
	sections.push(
		makeSection({
			id: "question",
			kind: "question",
			group: "question",
			title: "Question",
			path: null,
			text: questionText,
			dropRank: null,
		}),
	);

	// --- budget --------------------------------------------------------------
	const outcome = applyBudget(sections, budget);
	for (const drop of outcome.dropped) {
		notices.push({
			kind: "dropped",
			text: `dropped ${drop.title} (${drop.tokens} tokens): ${drop.reason}`,
		});
	}
	for (const group of outcome.overflowed) {
		notices.push({
			kind: "overflow",
			text: `the ${group} group is over its cap with nothing left that may be dropped`,
		});
	}

	const messages = buildMessages(outcome.kept);
	const sectionTokens = outcome.kept.reduce((sum, s) => sum + s.tokens, 0);
	const retrievedUsed = outcome.kept
		.filter((s) => s.group === "retrieved")
		.reduce((sum, s) => sum + s.tokens, 0);
	const reservedRetrieved = Math.max(0, budget.groups.retrieved - retrievedUsed);
	const messageOverhead = messages.length * PER_MESSAGE_OVERHEAD_TOKENS;

	return {
		date,
		sections: outcome.kept,
		dropped: outcome.dropped,
		notices,
		messages,
		budget,
		tokens: {
			byGroup: outcome.byGroup,
			sections: sectionTokens,
			messageOverhead,
			reservedRetrieved,
			total: sectionTokens + messageOverhead + reservedRetrieved,
			budget: packBudgetTokens(budget),
			headroom: headroomTokens(budget),
		},
	};
}

/**
 * Sections to `/api/chat` messages.
 *
 * The entire stable block rides in the system message. Gemma has no system role
 * of its own, so Ollama's template prepends system content to the first user
 * turn — either way it lands at the very start of the rendered prompt, which is
 * the position the cache cares about. Conversation turns stay as their own
 * alternating messages, because the chat template expects them to, and the date
 * and question share the final user message.
 */
function buildMessages(sections: readonly PackSection[]): PackMessage[] {
	const messages: PackMessage[] = [];

	const stable = sections
		.filter(
			(s) =>
				s.group === "system" ||
				s.group === "stable" ||
				s.group === "dailies" ||
				s.group === "retrieved",
		)
		.map((s) => s.text)
		.filter((text) => text.length > 0);
	if (stable.length > 0) messages.push({ role: "system", content: stable.join("\n\n") });

	for (const section of sections) {
		if (section.group !== "conversation") continue;
		if (section.text.length === 0) continue;
		messages.push({ role: section.messageRole ?? "user", content: section.text });
	}

	const tail = sections
		.filter((s) => s.group === "question")
		.map((s) => s.text)
		.filter((text) => text.length > 0);
	if (tail.length > 0) messages.push({ role: "user", content: tail.join("\n\n") });

	return messages;
}

/**
 * The pack as one string: what the model sees, modulo the chat template's own
 * turn markers. This is the artefact the byte-identity tests hash.
 */
export function renderPromptText(pack: ContextPack): string {
	return pack.messages.map((m) => `<<< ${m.role} >>>\n${m.content}`).join("\n\n");
}

/**
 * Everything before the final user message: the part of the prompt that must
 * not move between requests on the same day, and must not contain the date.
 */
export function stablePrefix(pack: ContextPack): string {
	const all = pack.messages.slice(0, -1);
	return all.map((m) => `<<< ${m.role} >>>\n${m.content}`).join("\n\n");
}
