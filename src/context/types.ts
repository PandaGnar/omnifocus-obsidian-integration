// Shared shapes for the context pack. Kept in their own module so `budget.ts`
// can reason about sections without importing the assembler that builds them.
//
// Nothing here imports `obsidian`, and nothing here reads a file: the pack is a
// pure function of (vault index, date, question, conversation, document text).

import type { CalendarDate } from "../vault/dates";

/**
 * Budget groups, in wire order. An array rather than an object because it is
 * iterated: `Object.keys` order is stable in practice for string keys but it is
 * not a contract anyone should be leaning on when the payoff for a stable
 * ordering is the KV cache.
 */
export const GROUP_ORDER = [
	"system",
	"stable",
	"dailies",
	"retrieved",
	"conversation",
	"question",
] as const;

export type SectionGroup = (typeof GROUP_ORDER)[number];

export type SectionKind =
	| "system"
	| "standing"
	| "goal"
	| "daily"
	| "retrieved"
	| "conversation"
	| "date"
	| "question";

export interface PackSection {
	/** Stable identifier, e.g. `goal:week`. Used by tests and the inspector. */
	readonly id: string;
	readonly kind: SectionKind;
	readonly group: SectionGroup;
	/** Human label for the inspector, e.g. `Week goals - 26 W31 Goals`. */
	readonly title: string;
	/** Vault path this section came from, when it came from a file. */
	readonly path: string | null;
	/** Exactly the text this section contributes to the prompt. */
	readonly text: string;
	readonly tokens: number;
	readonly truncated: boolean;
	/**
	 * Role of the chat message this section becomes, for the sections that
	 * become one of their own (conversation turns). `null` for sections that
	 * are concatenated into a shared message.
	 */
	readonly messageRole: "user" | "assistant" | null;
	/**
	 * Budget drop order. Lower drops first; `null` means the section is never
	 * dropped. See `DROP_RANK` in `pack.ts` for the ordering and its rationale.
	 */
	readonly dropRank: number | null;
}

export interface DroppedSection {
	readonly id: string;
	readonly title: string;
	readonly group: SectionGroup;
	readonly tokens: number;
	/** Why it went, in words the inspector can print verbatim. */
	readonly reason: string;
}

export type NoticeKind =
	| "gap"
	| "missing"
	| "unreadable"
	| "empty"
	| "duplicate"
	| "truncated"
	| "dropped"
	| "overflow";

export interface PackNotice {
	readonly kind: NoticeKind;
	readonly text: string;
}

export interface ConversationTurn {
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface PackMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

export interface ContextBudget {
	/** Sent explicitly on every request; never inferred from Ollama's default. */
	readonly numCtx: number;
	readonly numPredict: number;
	/** Ceiling per group, in estimated tokens. */
	readonly groups: Readonly<Record<SectionGroup, number>>;
	/** Ceiling per individual document, in estimated tokens. */
	readonly perDocument: Readonly<{
		standing: number;
		goal: number;
		daily: number;
		conversationTurn: number;
		question: number;
	}>;
	/** How many recent daily notes to try to include. */
	readonly dailyNoteCount: number;
}

export interface GroupTotal {
	readonly group: SectionGroup;
	readonly tokens: number;
	readonly cap: number;
}

export interface PackTokenTotals {
	readonly byGroup: readonly GroupTotal[];
	/** Kept-section tokens, excluding chat-template overhead. */
	readonly sections: number;
	/** Chat-template overhead for the messages this pack produces. */
	readonly messageOverhead: number;
	/** Unused half of the retrieved-chunks allowance, still charged. */
	readonly reservedRetrieved: number;
	/** sections + messageOverhead + reservedRetrieved. */
	readonly total: number;
	/** Sum of the group caps: what `total` is measured against. */
	readonly budget: number;
	/** numCtx - budget - numPredict. Slack the estimator is allowed to be wrong by. */
	readonly headroom: number;
}

export interface ContextPack {
	readonly date: CalendarDate;
	/** Kept sections, in wire order. */
	readonly sections: readonly PackSection[];
	/** Everything the budget removed, in the order it was removed. */
	readonly dropped: readonly DroppedSection[];
	/** Gaps, fallbacks and other things the user should know were substituted. */
	readonly notices: readonly PackNotice[];
	/** What PR 5 hands to `/api/chat`. */
	readonly messages: readonly PackMessage[];
	readonly budget: ContextBudget;
	readonly tokens: PackTokenTotals;
}
