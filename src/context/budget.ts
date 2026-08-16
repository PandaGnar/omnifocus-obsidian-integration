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
//   stable        6000   Life Goals + Y+/Q/M/W goal docs
//   dailies       3000   the last N daily notes
//   retrieved     3500   reserved for PR-future RAG; charged even while empty
//   conversation  4000   the chat history
//   question       500   today's date + the user's question
//   ------------------
//   total        17500   leaving 2048 for num_predict and ~13K of headroom
//
// The retrieved allowance is charged whether or not anything fills it. If it
// were only charged when used, switching retrieval on would silently move the
// pack over budget, which is the exact failure the budget exists to prevent.

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
		stable: 6000,
		dailies: 3000,
		retrieved: 3500,
		conversation: 4000,
		question: 500,
	},
	perDocument: {
		standing: 2000,
		goal: 2000,
		daily: 800,
		conversationTurn: 1500,
		question: 500,
	},
	dailyNoteCount: 5,
};

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
	readonly byGroup: readonly GroupTotal[];
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
 * Ties are impossible by construction — `pack.ts` hands out a distinct
 * `dropRank` to every droppable section — but the wire order is used as a
 * tiebreak anyway so that a future caller who reuses a rank cannot make the
 * output depend on array order.
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
 * 2. Whole pack: while the total (including the reserved retrieval allowance)
 *    is over the sum of the caps, drop the lowest-ranked section anywhere.
 *
 * Pass 2 is not redundant. Pass 1 cannot bring a group under its cap when
 * everything in it is undroppable — an over-long question is the realistic
 * case, since the question is never truncated and never dropped. Pass 2 is what
 * makes that excess come out of the daily notes rather than out of `num_ctx`.
 *
 * Per-*document* caps are not applied here: a document over its own cap is
 * truncated rather than dropped, which has to happen while the text is still in
 * hand. `pack.ts` does that before calling this.
 */
export function applyBudget(
	sections: readonly PackSection[],
	budget: ContextBudget,
): BudgetOutcome {
	const live = sections.map(() => true);
	const dropped: DroppedSection[] = [];
	const overflowed: SectionGroup[] = [];

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
	while (sumTokens(sections, live, null) + reserved > total) {
		const index = nextToDrop(sections, live, null);
		if (index === -1) {
			overflowed.push("system");
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
		byGroup,
	};
}
