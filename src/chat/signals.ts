// Everything the user has to be told about an answer that is not the answer
// itself, normalised into one list the view can render without a special case
// per source.
//
// The signals come from two places that never meet in the code below:
//
//   - the context pack, which knows the vault had a gap (`26 W32 Goals` does
//     not exist, so `26 W31 Goals` was sent instead), that a document was
//     dropped for budget, or that one was truncated at its per-document cap;
//   - the Ollama client, which knows the prompt came back pinned at `num_ctx`
//     (so the runtime silently decapitated it), that the reply stopped at
//     `num_predict` rather than at the model's own end, and that the answer was
//     buffered rather than streamed.
//
// Each of those failures is silent by default at its own layer: the vault gap
// is silent because a fallback document reads exactly like the right one, the
// truncation is silent because Ollama reports no error, and the reply cap is
// silent because a sentence that stops mid-thought still looks like prose. The
// plugin created two of the three conditions itself, which is the argument for
// carrying all of them to the surface rather than logging them.
//
// Pure: no `obsidian` import, no DOM. The view decides how a warning looks; this
// module decides what there is to say.

import type { ChatResult } from "../ollama/client";
import { hitReplyCap } from "../ollama/protocol";
import type { ContextPack, NoticeKind } from "../context/types";

export type SignalLevel = "info" | "warning";

export interface ChatSignal {
	/** Stable machine name, so tests assert on the signal rather than its prose. */
	readonly code: string;
	readonly level: SignalLevel;
	readonly text: string;
}

/**
 * How loudly each pack notice is reported.
 *
 * `gap` is a warning and not negotiable: it is the case where the user asks
 * about this week and is answered from last week's plan. Everything that
 * changes *what the model saw* is a warning; the rest is bookkeeping the user
 * may want but does not need to act on.
 */
const NOTICE_LEVELS: Readonly<Record<NoticeKind, SignalLevel>> = {
	gap: "warning",
	missing: "warning",
	unreadable: "warning",
	dropped: "warning",
	truncated: "warning",
	overflow: "warning",
	empty: "info",
	duplicate: "info",
};

/** Notices from the pack, in the order the assembler recorded them. */
export function packSignals(pack: ContextPack): readonly ChatSignal[] {
	return pack.notices.map((notice) => ({
		code: `context-${notice.kind}`,
		level: NOTICE_LEVELS[notice.kind],
		text: notice.text,
	}));
}

/**
 * Signals from the completed request.
 *
 * All three of these are things the user cannot see from the answer text. A
 * truncated prompt still produces fluent output; a capped reply still ends in a
 * word; a buffered answer is indistinguishable from a streamed one once it has
 * finished arriving. The last is reported at `info` rather than `warning`
 * because nothing about the answer is wrong — but it is reported, because it
 * means the streaming transport failed and the user is entitled to know their
 * cancel button had less to cancel than they thought.
 */
export function responseSignals(result: ChatResult): readonly ChatSignal[] {
	const signals: ChatSignal[] = [];

	if (!result.streamed) {
		signals.push({
			code: "not-streamed",
			level: "info",
			text:
				"Answer was buffered, not streamed: the streaming transport failed and the " +
				"request was retried in one piece. Set OLLAMA_ORIGINS=app://obsidian.md on " +
				"the server to get token-by-token output back.",
		});
	}

	if (result.truncation.status === "truncated") {
		signals.push({
			code: "prompt-truncated",
			level: "warning",
			text: result.truncation.message,
		});
	} else if (result.truncation.status === "unknown") {
		signals.push({
			code: "prompt-truncation-unknown",
			level: "info",
			text: result.truncation.message,
		});
	}

	if (hitReplyCap(result.final)) {
		signals.push({
			code: "reply-capped",
			level: "warning",
			text:
				"The reply stopped at the num_predict cap rather than because the model " +
				"finished. Raise num_predict in settings for a longer answer.",
		});
	}

	return signals;
}

/** True when anything in the list needs the user to act or to discount the answer. */
export function hasWarning(signals: readonly ChatSignal[]): boolean {
	return signals.some((signal) => signal.level === "warning");
}

/** Signals as markdown bullets, for the saved transcript. */
export function renderSignalsMarkdown(signals: readonly ChatSignal[]): string {
	if (signals.length === 0) return "";
	const lines = ["Context notes:"];
	for (const signal of signals) {
		lines.push(`- ${signal.level === "warning" ? "**" : ""}${signal.text}${
			signal.level === "warning" ? "**" : ""
		}`);
	}
	return lines.join("\n");
}
