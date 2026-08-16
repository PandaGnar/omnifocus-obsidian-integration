// Prompt-cache discipline, enforced at runtime rather than assumed.
//
// Ollama reuses the KV cache across requests by longest common prefix. PR 4
// built a pack whose prefix is byte-stable *given the same inputs*; a chat view
// changes the inputs on every turn, because the conversation grows. So the
// question this module answers is narrower and sharper than "is the pack
// deterministic": across the turns of one conversation, does the cached prefix
// still hold?
//
// Two properties, and they are not the same property:
//
//   1. **The stable block is byte-identical.** Everything before the
//      conversation — system prompt, standing docs, goal docs, daily notes —
//      must be the same bytes on turn 5 as on turn 1. This is the expensive
//      part of the prefill, roughly 6-9K tokens against a question worth a few
//      dozen, so losing it is the difference between a sub-second follow-up and
//      a cold rebuild.
//
//   2. **The prefix only grew.** Turn N's cached prefix must start with turn
//      N-1's. Appending a turn is free; rewriting one is not.
//
// Property 1 can genuinely fail, and pretending otherwise would be the wrong
// kind of confidence. `budget.ts`'s second pass drops the lowest-ranked section
// anywhere in the pack when the total goes over, and daily notes rank lowest.
// The reachable trigger is a question longer than its own allowance: the
// question is never truncated and never dropped, so the room comes out of the
// context instead. One long question therefore changes the stable block that
// the *next* turn inherits, and the cost lands on a turn the user has no reason
// to associate with it. That is the correct trade — the budget exists to keep
// the pack small — but it must not be silent, because the only other symptom is
// a follow-up that inexplicably took forty seconds. Hence `prefixSignal`.
//
// A growing conversation on its own does not do this: the conversation has a
// group cap of its own, and `applyBudget`'s first pass drops old turns to stay
// under it before the total is ever at risk.
//
// Pure: no `obsidian`, no timers, no I/O.

import { stablePrefix } from "../context/pack";
import type { ContextPack } from "../context/types";
import type { ChatSignal } from "./signals";

export interface PrefixSnapshot {
	/**
	 * The system message: the stable block, and the part of the prompt no turn
	 * of a conversation is allowed to change.
	 */
	readonly stableBlock: string;
	/** Everything before the final user message — the whole cacheable prefix. */
	readonly prefix: string;
}

/**
 * `buildMessages` puts the entire stable block in the single system message and
 * each conversation turn in a message of its own, so the system message *is*
 * the stable block. Reading it out here rather than re-deriving it from
 * `pack.sections` means this checks what is actually sent.
 */
export function snapshotPrefix(pack: ContextPack): PrefixSnapshot {
	const system = pack.messages.find((message) => message.role === "system");
	return {
		stableBlock: system?.content ?? "",
		prefix: stablePrefix(pack),
	};
}

export interface PrefixComparison {
	/** Nothing to compare against; the first turn of a conversation. */
	readonly first: boolean;
	/** Property 1: the stable block did not change. */
	readonly stableBlockUnchanged: boolean;
	/** Property 2: the new prefix starts with the old one. */
	readonly appendOnly: boolean;
	/** Byte offset of the first difference in the stable block, or null. */
	readonly divergedAt: number | null;
	/** True when the KV cache from the previous turn is still usable in full. */
	readonly cacheHeld: boolean;
}

/** Index of the first differing character, or null when one is a prefix of the other. */
function firstDifference(a: string, b: string): number | null {
	const shared = Math.min(a.length, b.length);
	for (let i = 0; i < shared; i += 1) {
		if (a[i] !== b[i]) return i;
	}
	return a.length === b.length ? null : shared;
}

export function comparePrefixes(
	previous: PrefixSnapshot | null,
	current: PrefixSnapshot,
): PrefixComparison {
	if (previous === null) {
		return {
			first: true,
			stableBlockUnchanged: true,
			appendOnly: true,
			divergedAt: null,
			cacheHeld: false,
		};
	}
	const stableBlockUnchanged = previous.stableBlock === current.stableBlock;
	const appendOnly = current.prefix.startsWith(previous.prefix);
	return {
		first: false,
		stableBlockUnchanged,
		appendOnly,
		divergedAt: stableBlockUnchanged
			? null
			: firstDifference(previous.stableBlock, current.stableBlock),
		cacheHeld: stableBlockUnchanged && appendOnly,
	};
}

/**
 * What to tell the user when the prefix moved. Null on the happy path and on
 * the first turn — a chat view that narrated every successful cache hit would
 * be noise, and the reason to surface this at all is that the failure is
 * otherwise invisible except as unexplained slowness.
 */
export function prefixSignal(comparison: PrefixComparison): ChatSignal | null {
	if (comparison.first || comparison.cacheHeld) return null;
	const cause = comparison.stableBlockUnchanged
		? "an earlier turn was rewritten rather than appended to"
		: "the standing context changed between turns, most likely because the " +
			"budget dropped a document to make room for the conversation";
	return {
		code: "cache-invalidated",
		level: "info",
		text:
			`Ollama's prompt cache could not be reused for this turn: ${cause}. ` +
			"Expect a slower first token. Clearing the conversation restores it.",
	};
}

/**
 * Running check across the turns of one conversation. Holds a string per
 * conversation, which is the price of noticing; the alternative is a plugin
 * that cannot tell a cold prefill from a warm one.
 */
export class PrefixTracker {
	private previous: PrefixSnapshot | null = null;

	/** Record this turn's pack and report what it did to the cache. */
	observe(pack: ContextPack): PrefixComparison {
		const current = snapshotPrefix(pack);
		const comparison = comparePrefixes(this.previous, current);
		this.previous = current;
		return comparison;
	}

	/** A cleared conversation starts a new prefix lineage. */
	reset(): void {
		this.previous = null;
	}
}
