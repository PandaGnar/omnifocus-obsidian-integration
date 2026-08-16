// The "this directory does not touch the plugin API" check, in one place.
//
// Four suites assert it — `src/vault/`, `src/context/`, `src/chat/` and
// `src/draft/` are all meant to be testable without Obsidian, and each of them
// is the layer some future change will be tempted to reach out of. Three of
// them asserted it with three copies of a regex, and the copies drifted: two of
// those anchored to `^\s*import[^\n]*` and so could not see the import a
// formatter writes once the name list outgrows the print width. A guard that
// only catches the careless version of the mistake is worth very little, since
// the careless version is also the one you notice by eye. The fourth was
// written on a branch of its own, against a pattern of its own, which is the
// same divergence starting over.
//
// So the pattern lives here, is shared by every guard, and has a suite of its
// own that injects each evasion into a scratch directory and insists it is
// found. This module is not a test helper in the sense of "only tests use it" —
// it is the definition of the property, and `purity.test.ts` is what proves the
// definition works.
//
// It lives outside the guarded directories deliberately: it necessarily
// contains the module name it looks for, and a guard whose own source trips it
// would be unusable.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every way a TypeScript file can take a dependency on a module, as one
 * expression. Each alternative is here because it is a real thing someone
 * writes, not because it completes a taxonomy:
 *
 *   - `from "obsidian"` covers plain imports, `import type`, `import * as`,
 *     and `export { TFile } from "obsidian"` — a re-export takes the
 *     dependency exactly as effectively as an import, and the shared `from`
 *     tail is the only token all of those have in common;
 *   - `require("obsidian")` covers the CommonJS spelling, which the bundler
 *     resolves just the same;
 *   - `import("obsidian")` covers the dynamic form, which is what someone
 *     writes to make a dependency conditional — the most plausible way to
 *     "only reach for the API in the desktop path";
 *   - bare `import "obsidian"` covers a side-effect import.
 *
 * `\s*` rather than `[^\n]*` between the keyword and the module name is the
 * whole point: it crosses newlines, so the multi-line form is caught. Type-only
 * imports are caught for free, and they matter — they are erased at build time,
 * which is exactly what makes one easy to add without noticing.
 *
 * The two halves differ only in which quotes they accept, and that difference
 * is what keeps the guard usable. A backtick specifier is legal in exactly one
 * position — inside the parentheses of `import()` or `require()`, where the
 * argument is an ordinary expression — and is a syntax error in a static
 * `import`/`export … from`, whose specifier must be a string literal. Accepting
 * a backtick in the static half therefore catches nothing that can compile, and
 * costs something real: ``does not import `obsidian` `` is a sentence this
 * repository writes at the top of nearly every pure module, and a guard that
 * fails on its own documentation is a guard somebody deletes. `src/draft/`'s
 * header said precisely that, and the shared pattern flagged it.
 *
 * So static forms take quotes only; the call forms keep the backtick and gain a
 * mandatory `(`, which is what a template literal needs in front of it anyway.
 * `purity.test.ts` pins both directions.
 */
const OBSIDIAN_DEPENDENCY =
	/(?:\bfrom|\bimport)\s*["']obsidian["']|(?:\brequire|\bimport)\s*\(\s*["'`]obsidian["'`]/;

/** Every `.ts` file under `dir`, recursively: subdirectories are not a loophole. */
export function typeScriptFilesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return typeScriptFilesUnder(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

export interface ObsidianDependency {
	readonly file: string;
	/** The offending line, trimmed, so a failure names what it found. */
	readonly line: string;
}

export interface PurityScan {
	/** Every file examined. Assert on this: a walk that found nothing passes vacuously. */
	readonly files: readonly string[];
	/** Empty on the happy path. */
	readonly dependencies: readonly ObsidianDependency[];
}

export interface PurityScanOptions {
	/** Files to skip, e.g. the one module that is allowed to be the shell. */
	readonly exclude?: (file: string) => boolean;
}

/**
 * Scan `dir` recursively for anything that pulls in the Obsidian API.
 *
 * Returns rather than throws so the calling test owns its own assertions, and
 * in particular so it can assert that the walk found a plausible number of
 * files. Both halves matter: a guard that finds no offenders because it found
 * no files is the failure mode that lets an impure module sit in the tree while
 * the suite reports green.
 */
export function scanForObsidianDependencies(
	dir: string,
	options: PurityScanOptions = {},
): PurityScan {
	const files = typeScriptFilesUnder(dir).filter((file) => options.exclude?.(file) !== true);
	const dependencies: ObsidianDependency[] = [];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		if (!OBSIDIAN_DEPENDENCY.test(source)) continue;
		dependencies.push({ file, line: offendingLine(source) });
	}
	return { files, dependencies };
}

/**
 * The line the match landed on, for the failure message. A multi-line import
 * matches at `from`, which is the last line of the statement rather than the
 * first — near enough to find it, and naming a line beats naming a file.
 */
function offendingLine(source: string): string {
	const at = source.search(OBSIDIAN_DEPENDENCY);
	const start = source.lastIndexOf("\n", at) + 1;
	const end = source.indexOf("\n", at);
	return source.slice(start, end === -1 ? undefined : end).trim();
}
