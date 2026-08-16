// The hard token budget: per-group caps, per-document caps, and a drop order
// that is fixed at assembly time so that going over budget produces the same
// prompt every time it happens.
//
// The numbers come from `docs/plan.md`'s runtime tuning section. `num_ctx` is
// 32768 and `num_predict` is 2048, and the pack claims well under the
// difference: a 2.3B-effective model given 40K tokens does not reliably use the
// middle of it, so the budget exists for answer quality first and speed second.
//
//   system         500   the standing instructions
//   stable        8000   Life Goals + background docs + Y+/Q/M/W goal docs
//   dailies       3000   the last N daily notes
//   retrieved     3500   reserved for PR-future RAG; charged even while empty
//   conversation  4000   the chat history
//   question       500   today's date, any gap notes, and the user's question
//   ------------------
//   total        19500   leaving 2048 for num_predict and 11220 of headroom
//
// The retrieved allowance is charged whether or not anything fills it. If it
// were only charged when used, switching retrieval on would silently move the
// pack over budget, which is the exact failure the budget exists to prevent.
//
// Calibrating the two mechanisms against each other
// -------------------------------------------------
// There are two ways to come in under a cap — truncate a document, or drop it
// whole — and they used not to be calibrated against each other. `daily` was
// 800 tokens with room for five dailies in a 3000-token group (4000 > 3000),
// and `stable` allowed ten documents at 2000 in a 6000-token group. The
// per-document caps therefore never bound anything: the group cap bound first,
// and its only remedy is dropping documents whole. Profiled at realistic sizes
// that discarded the multi-year and quarterly goal docs, untruncated, while
// ~19,890 tokens of `num_ctx` sat unused.
//
// So the per-document caps are now *derived* from the group cap and the number
// of documents the group is sized for — see `documentCapTokens`. A full group's
// worth of documents at their cap sums to exactly the group cap, which makes
// truncation the binding constraint and dropping the genuine last resort the
// comment on `applyBudget` always claimed it was.
//
// The slot counts feeding that division must be *constants*, not the number of
// documents that happened to resolve today. Dividing by "how many goal docs
// exist for this date" would make every other document's truncation point
// depend on the calendar, which is the prompt-cache leak `pack.ts` exists to
// avoid. Under-filling a group on a date with a missing horizon is the price.
//
// `stable` moved 6000 -> 8000 so that ten fixed documents get 800 tokens each
// rather than 600; 600 cuts a real `Goals` doc mid-list. `conversation` is the
// one group whose membership is unbounded, so its per-turn cap cannot be
// derived and dropping the oldest turns stays the mechanism there — which is
// the behaviour a chat view wants anyway.
//
// That raise costs headroom, so it is argued from what survives it, not from
// the estimator being conservative (`tokens.ts` explains why that argument is
// not available): 32768 - 19500 - 2048 = 11220 tokens, better than a third of
// the usable window. Busting `num_ctx` would need the estimate to be low by
// 1.57x across the whole prompt, i.e. a real aggregate rate under 1.9
// characters per token, which mixed markdown does not reach.

import {
	GROUP_ORDER,
	type ContextBudget,
	type DroppedSection,
	type GroupTotal,
	type PackSection,
	type SectionGroup,
} from "./types";

export const DEFAULT_BUDGET: ContextBudget = {
	numCtx: 32_768,
	numPredict: 2048,
	groups: {
		system: 500,
		stable: 8000,
		dailies: 3000,
		retrieved: 3500,
		conversation: 4000,
		question: 500,
	},
	perDocument: {
		// Ceilings, not the caps actually applied: `documentCapTokens` lowers
		// these to the group's fair share. They are the point at which a single
		// document is too big to be worth sending whole even if it would fit.
		standing: 2000,
		goal: 2000,
		daily: 800,
		conversationTurn: 1500,
		question: 500,
	},
	dailyNoteCandidates: 5,
};

/**
 * The per-document cap actually applied: the declared ceiling, lowered so that
 * `slots` documents at their cap still fit `group`'s cap.
 *
 * `slots` must be a constant of the build — the length of a `const` array, or
 * `dailyNoteCandidates` — and never a count of what resolved for today's date.
 * See the header: a date-dependent cap is a date-dependent truncation point,
 * which is a date-dependent prompt prefix.
 */
export function documentCapTokens(
	budget: ContextBudget,
	group: SectionGroup,
	slots: number,
	declaredCap: number,
): number {
	if (slots <= 0) return declaredCap;
	return Math.min(declaredCap, Math.floor(budget.groups[group] / slots));
}

/** Sum of the group caps: the ceiling the assembled pack is measured against. */
export function packBudgetTokens(budget: ContextBudget): number {
	let total = 0;
	for (const group of GROUP_ORDER) total += budget.groups[group];
	return total;
}

/**
 * Tokens left over inside `num_ctx` once the pack and the reply are paid for.
 * This is the slack the estimator in `tokens.ts` is allowed to be wrong by.
 */
export function headroomTokens(budget: ContextBudget): number {
	return budget.numCtx - packBudgetTokens(budget) - budget.numPredict;
}

export interface BudgetOutcome {
	readonly kept: readonly PackSection[];
	readonly dropped: readonly DroppedSection[];
	/** Groups still over cap after everything droppable in them was dropped. */
	readonly overflowed: readonly SectionGroup[];
	/**
	 * True when the *whole pack* is still over the sum of the caps and nothing
	 * droppable is left. Distinct from `overflowed`, which names a group that
	 * busted its own cap: pass 2 used to report this condition as an overflow of
	 * the `system` group, which is neither the cause nor usually even over.
	 */
	readonly packOverflow: boolean;
	readonly byGroup: readonly GroupTotal[];
}

export interface BudgetOptions {
	/**
	 * Chat-template overhead to hold back, in tokens. `pack.ts` passes the
	 * overhead for the messages the *undropped* pack would produce, which is an
	 * upper bound on the overhead the kept pack produces (dropping sections can
	 * only remove messages). Charging it here is what makes `tokens.total`
	 * genuinely bounded by the figure the budget enforced — it used to be added
	 * to the reported total afterwards, outside anything that checked it.
	 */
	readonly messageOverhead?: number;
}

function sumTokens(
	sections: readonly PackSection[],
	live: readonly boolean[],
	group: SectionGroup | null,
): number {
	let total = 0;
	for (let i = 0; i < sections.length; i += 1) {
		const section = sections[i] as PackSection;
		if (!live[i]) continue;
		if (group !== null && section.group !== group) continue;
		total += section.tokens;
	}
	return total;
}

/**
 * Index of the next section to drop, or -1 when nothing droppable is left.
 *
 * `pack.ts` hands out distinct `dropRank`s within each band, so ties only arise
 * where it deliberately clamps — past the hundredth conversation turn. The
 * strict `<` makes the earliest section in wire order win, and since every
 * group is assembled oldest-first that keeps the documented policy (drop the
 * oldest) even where the ranks have run out of room to say it.
 */
function nextToDrop(
	sections: readonly PackSection[],
	live: readonly boolean[],
	group: SectionGroup | null,
): number {
	let best = -1;
	let bestRank = Number.POSITIVE_INFINITY;
	for (let i = 0; i < sections.length; i += 1) {
		const section = sections[i] as PackSection;
		if (!live[i]) continue;
		if (section.dropRank === null) continue;
		if (group !== null && section.group !== group) continue;
		if (section.dropRank < bestRank) {
			best = i;
			bestRank = section.dropRank;
		}
	}
	return best;
}

/**
 * Enforces the caps, in two passes.
 *
 * 1. Per group: while a group is over its cap, drop its lowest-ranked section.
 * 2. Whole pack: while the total (including the reserved retrieval allowance
 *    and the chat-template overhead) is over the sum of the caps, drop the
 *    lowest-ranked section anywhere.
 *
 * Pass 2 is not redundant. Pass 1 cannot bring a group under its cap when
 * everything in it is undroppable — an over-long question is the realistic
 * case, since the question is never truncated and never dropped. Pass 2 is what
 * makes that excess come out of the daily notes rather than out of `num_ctx`.
 *
 * Per-*document* caps are not applied here: a document over its own cap is
 * truncated rather than dropped, which has to happen while the text is still in
 * hand. `pack.ts` does that before calling this, using `documentCapTokens` so
 * that a full group of documents at their caps cannot bust the group cap — with
 * the deliberate exception of the conversation, whose length nobody bounds.
 * Pass 1 dropping anything therefore means either a long conversation or a
 * caller who overrode the caps.
 */
export function applyBudget(
	sections: readonly PackSection[],
	budget: ContextBudget,
	options: BudgetOptions = {},
): BudgetOutcome {
	const live = sections.map(() => true);
	const dropped: DroppedSection[] = [];
	const overflowed: SectionGroup[] = [];
	const messageOverhead = options.messageOverhead ?? 0;
	let packOverflow = false;

	const remove = (index: number, reason: string): void => {
		const section = sections[index] as PackSection;
		live[index] = false;
		dropped.push({
			id: section.id,
			title: section.title,
			group: section.group,
			tokens: section.tokens,
			reason,
		});
	};

	for (const group of GROUP_ORDER) {
		const cap = budget.groups[group];
		while (sumTokens(sections, live, group) > cap) {
			const index = nextToDrop(sections, live, group);
			if (index === -1) {
				overflowed.push(group);
				break;
			}
			remove(index, `over the ${group} cap of ${cap} tokens`);
		}
	}

	const total = packBudgetTokens(budget);
	const retrievedUsed = sumTokens(sections, live, "retrieved");
	// Whatever the retrieval slot does not use is still held back for it.
	const reserved = Math.max(0, budget.groups.retrieved - retrievedUsed);
	while (sumTokens(sections, live, null) + reserved + messageOverhead > total) {
		const index = nextToDrop(sections, live, null);
		if (index === -1) {
			packOverflow = true;
			break;
		}
		remove(index, `over the total pack budget of ${total} tokens`);
	}

	const byGroup: GroupTotal[] = GROUP_ORDER.map((group) => ({
		group,
		tokens: sumTokens(sections, live, group),
		cap: budget.groups[group],
	}));

	return {
		kept: sections.filter((_, i) => live[i]),
		dropped,
		overflowed,
		packOverflow,
		byGroup,
	};
}
