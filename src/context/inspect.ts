// Renders a context pack for human inspection: what would be sent, what it
// costs, and what was left out and why.
//
// This is what `Mise: show context pack` puts on screen. The prompt is printed
// verbatim at the bottom rather than summarised — the point of the command is
// to be able to read the actual bytes before trusting an answer built on them.
//
// Numbers are formatted by hand rather than through `toLocaleString`, which is
// locale-dependent: a thousands separator that differs between machines would
// be a poor thing to have introduced in a module about determinism.

import type { ContextPack, PackSection } from "./types";
import { formatIsoDate, renderPromptText } from "./pack";

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function num(value: number, width: number): string {
	const text = String(value);
	return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function sectionLine(section: PackSection): string {
	const suffix = section.path === null ? "" : `  ${section.path}`;
	const flag = section.truncated ? " [truncated]" : "";
	return `  ${num(section.tokens, 6)}  ${pad(section.group, 13)}${section.title}${flag}${suffix}`;
}

export function renderPackInspection(pack: ContextPack): string {
	const out: string[] = [];
	const t = pack.tokens;

	out.push(`Context pack for ${formatIsoDate(pack.date)}`);
	out.push(
		`Estimated ${t.total} of ${t.budget} budgeted tokens ` +
			`(sections ${t.sections}, chat template ${t.messageOverhead}, ` +
			`retrieval reserve ${t.reservedRetrieved}).`,
	);
	out.push(
		`num_ctx ${pack.budget.numCtx}, num_predict ${pack.budget.numPredict}, ` +
			`headroom ${t.headroom}.`,
	);
	out.push(
		"Token counts are heuristic estimates, not a ceiling: high on prose, " +
			"low on tables and wikilinks (see src/context/tokens.ts). The " +
			"headroom above is the margin that covers it. The authoritative " +
			"check is the prompt_eval_count comparison in the Ollama client.",
	);

	out.push("");
	out.push("Groups");
	for (const group of t.byGroup) {
		const over = group.tokens > group.cap ? "  OVER" : "";
		out.push(`  ${pad(group.group, 14)}${num(group.tokens, 6)} / ${group.cap}${over}`);
	}

	out.push("");
	out.push(`Sections (${pack.sections.length}, in the order they are sent)`);
	for (const section of pack.sections) out.push(sectionLine(section));

	out.push("");
	if (pack.dropped.length === 0) {
		out.push("Dropped: nothing - the pack fits.");
	} else {
		out.push(`Dropped (${pack.dropped.length})`);
		for (const drop of pack.dropped) {
			out.push(`  ${num(drop.tokens, 6)}  ${pad(drop.group, 13)}${drop.title} - ${drop.reason}`);
		}
	}

	out.push("");
	if (pack.notices.length === 0) {
		out.push("Notices: none.");
	} else {
		out.push(`Notices (${pack.notices.length})`);
		for (const notice of pack.notices) out.push(`  ${pad(notice.kind, 12)}${notice.text}`);
	}

	out.push("");
	out.push("Prompt");
	out.push("======");
	out.push(renderPromptText(pack));

	return out.join("\n");
}
