// A line diff, so that nothing is written to the vault the user has not seen
// first.
//
// Written by hand rather than pulled in: the plugin ships as a single bundled
// `main.js` into the user's vault, and a diff over two markdown notes is a
// forty-line dynamic program. The tables are O(n*m) in lines, which for two
// daily notes is a few thousand cells.
//
// The property that matters downstream is `isNoOpDiff`: it is the visible half
// of "running it twice is a no-op". The write path decides on its own by
// comparing strings, so the diff never *causes* a write — but if the two ever
// disagreed, the user would be shown an empty diff and then have a note
// rewritten underneath them, so `plan.test.ts` asserts they agree.
//
// Nothing in this file imports `obsidian`.

export type DiffKind = "context" | "add" | "remove";

export interface DiffLine {
	readonly kind: DiffKind;
	readonly text: string;
}

/**
 * Longest common subsequence table over lines.
 *
 * Lines rather than characters or words: the unit the user reviews is a line of
 * their note, and a character diff of restructured markdown is unreadable.
 */
function lcsTable(before: readonly string[], after: readonly string[]): Int32Array[] {
	const table: Int32Array[] = [];
	for (let i = 0; i <= before.length; i += 1) table.push(new Int32Array(after.length + 1));
	for (let i = before.length - 1; i >= 0; i -= 1) {
		const row = table[i] as Int32Array;
		const next = table[i + 1] as Int32Array;
		for (let j = after.length - 1; j >= 0; j -= 1) {
			row[j] =
				before[i] === after[j]
					? (next[j + 1] as number) + 1
					: Math.max(next[j] as number, row[j + 1] as number);
		}
	}
	return table;
}

/**
 * Every line of both texts, tagged. Removals are emitted before additions at
 * the same position, which is the order every diff the user has ever read uses.
 */
export function diffLines(before: string, after: string): readonly DiffLine[] {
	// An empty string is zero lines, not one empty line: a note being created
	// has no "before", and showing a phantom blank removal would be a lie.
	const a = before === "" ? [] : before.split("\n");
	const b = after === "" ? [] : after.split("\n");
	const table = lcsTable(a, b);

	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ kind: "context", text: a[i] as string });
			i += 1;
			j += 1;
			continue;
		}
		const down = (table[i + 1] as Int32Array)[j] as number;
		const right = (table[i] as Int32Array)[j + 1] as number;
		if (down >= right) {
			out.push({ kind: "remove", text: a[i] as string });
			i += 1;
		} else {
			out.push({ kind: "add", text: b[j] as string });
			j += 1;
		}
	}
	while (i < a.length) {
		out.push({ kind: "remove", text: a[i] as string });
		i += 1;
	}
	while (j < b.length) {
		out.push({ kind: "add", text: b[j] as string });
		j += 1;
	}
	return out;
}

export interface DiffStats {
	readonly added: number;
	readonly removed: number;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.kind === "add") added += 1;
		else if (line.kind === "remove") removed += 1;
	}
	return { added, removed };
}

/** True when the two texts are identical — nothing to write, nothing to show. */
export function isNoOpDiff(lines: readonly DiffLine[]): boolean {
	return lines.every((line) => line.kind === "context");
}

const PREFIX: Readonly<Record<DiffKind, string>> = {
	context: "  ",
	add: "+ ",
	remove: "- ",
};

/**
 * The diff with long unchanged runs replaced by a `null` marker.
 *
 * `context` lines around a change are kept so the user can see *where* in their
 * note the change lands. Pure and shared, so the modal's rendering and the text
 * rendering below elide identically rather than drifting apart.
 */
export function collapseDiff(
	lines: readonly DiffLine[],
	contextLines = 3,
): readonly (DiffLine | null)[] {
	const keep = lines.map((line) => line.kind !== "context");
	for (let i = 0; i < lines.length; i += 1) {
		if ((lines[i] as DiffLine).kind === "context") continue;
		for (let d = 1; d <= contextLines; d += 1) {
			if (i - d >= 0) keep[i - d] = true;
			if (i + d < lines.length) keep[i + d] = true;
		}
	}

	const out: (DiffLine | null)[] = [];
	let eliding = false;
	for (let i = 0; i < lines.length; i += 1) {
		if (!keep[i]) {
			if (!eliding) out.push(null);
			eliding = true;
			continue;
		}
		eliding = false;
		out.push(lines[i] as DiffLine);
	}
	return out;
}

/** One collapsed diff line as text. `null` is the elision marker. */
export function diffLineText(line: DiffLine | null): string {
	return line === null ? "..." : `${PREFIX[line.kind]}${line.text}`;
}
