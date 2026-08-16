// The guard's own guard.
//
// `scanForObsidianDependencies` is asserted by three suites that would all stay
// green if it silently stopped matching anything, because none of those
// directories contains an offender — that is the point of them. So the evasions
// are injected here, one per test, into a scratch directory: each form is
// written to disk, scanned, and required to be found. An earlier version of the
// check passed a real impure module sitting in `src/chat/`, and this is the
// suite that would have caught it.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanForObsidianDependencies, typeScriptFilesUnder } from "./purity";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "purity-"));
	// A pure file, so every scan below walks a directory with something innocent
	// in it as well as the offender.
	writeFileSync(join(dir, "pure.ts"), 'export const answer = "42";\n');
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Write `source` as `name` under the scratch dir and scan. */
function scan(name: string, source: string): ReturnType<typeof scanForObsidianDependencies> {
	writeFileSync(join(dir, name), source);
	return scanForObsidianDependencies(dir);
}

describe("forms the guard has to catch", () => {
	// Each of these was walked around by at least one copy of the old pattern.
	const evasions: ReadonlyArray<[label: string, source: string]> = [
		["a plain single-line import", 'import { Notice } from "obsidian";\n'],
		[
			"a multi-line import, which is what a formatter writes",
			'import {\n\tNotice,\n\tPlugin,\n\tTFile,\n} from "obsidian";\n',
		],
		["a type-only import, erased at build time", 'import type { TFile } from "obsidian";\n'],
		["a namespace import", 'import * as obsidian from "obsidian";\n'],
		["a re-export, which takes the dependency just as well", 'export { TFile } from "obsidian";\n'],
		["a star re-export", 'export * from "obsidian";\n'],
		["a dynamic import, the conditional-dependency spelling", 'const m = await import("obsidian");\n'],
		["a dynamic import with spaces inside the parens", 'const m = await import( "obsidian" );\n'],
		// The one position a backtick specifier is legal: inside the parens,
		// where the argument is an expression rather than a string literal. The
		// static forms below deliberately do not accept it — see the note on
		// `OBSIDIAN_DEPENDENCY` — so these two are what hold that half in place.
		["a template-literal dynamic import", "const m = await import(`obsidian`);\n"],
		["a template-literal require", "const { Notice } = require(`obsidian`);\n"],
		["the CommonJS spelling", 'const { Notice } = require("obsidian");\n'],
		["a bare side-effect import", 'import "obsidian";\n'],
		["single quotes", "import { Notice } from 'obsidian';\n"],
		// Type-only *and* single-quoted: the two evasions that were listed
		// separately, combined. `src/draft/`'s guard listed this one, and a
		// pattern can pass each half while failing the pair.
		["a single-quoted type-only import", "import type { App } from 'obsidian';\n"],
		["an import indented inside a block", '\tif (x) {\n\t\tconst m = require("obsidian");\n\t}\n'],
	];

	for (const [label, source] of evasions) {
		it(`catches ${label}`, () => {
			const result = scan("impure.ts", source);
			expect(result.dependencies.map((d) => d.file)).toEqual([join(dir, "impure.ts")]);
			expect(result.dependencies[0]?.line).toContain("obsidian");
		});
	}

	it("finds one inside a subdirectory, because subdirectories are not a loophole", () => {
		// `fixtures/` is the likeliest place to reach for `TFile`, and a
		// non-recursive walk never looked there.
		mkdirSync(join(dir, "fixtures"));
		writeFileSync(join(dir, "fixtures", "vault.ts"), 'import type { TFile } from "obsidian";\n');
		const result = scanForObsidianDependencies(dir);
		expect(result.dependencies.map((d) => d.file)).toEqual([
			join(dir, "fixtures", "vault.ts"),
		]);
	});

	it("reports every offender, not just the first", () => {
		writeFileSync(join(dir, "a.ts"), 'import { Notice } from "obsidian";\n');
		writeFileSync(join(dir, "b.ts"), 'export * from "obsidian";\n');
		expect(scanForObsidianDependencies(dir).dependencies).toHaveLength(2);
	});
});

describe("things the guard must not flag", () => {
	it("says nothing about a directory that is clean", () => {
		const result = scanForObsidianDependencies(dir);
		expect(result.dependencies).toEqual([]);
		expect(result.files).toEqual([join(dir, "pure.ts")]);
	});

	it("does not flag an import of a differently-named module", () => {
		expect(scan("other.ts", 'import { x } from "./obsidian-ish";\n').dependencies).toEqual([]);
	});

	it("does not flag the word in prose", () => {
		// Comments discussing the rule are the normal case in this repo, and a
		// guard that fails on its own documentation gets deleted.
		const prose = "// Nothing here reaches for the Obsidian API, which is the point.\n";
		expect(scan("commented.ts", prose).dependencies).toEqual([]);
	});

	it("does not flag a backticked module name in prose", () => {
		// The regression. Nearly every pure module in this repository opens by
		// saying so, and `src/draft/plan.ts` said it in the singular — "does not
		// import `obsidian`" — which the pattern read as a static import with a
		// template-literal specifier. That is not a thing TypeScript can compile,
		// so accepting it caught nothing and failed a real file.
		const prose = [
			"// The guarantee this file relies on and restates for the reader:",
			"// `src/draft/` outside the modal does not import `obsidian`, and the",
			"// modal is the shell. See also: it must not require `obsidian` either.",
			"export const x = 1;",
		].join("\n");
		expect(scan("documented.ts", prose).dependencies).toEqual([]);
	});
});

describe("the walk", () => {
	it("ignores files that are not TypeScript", () => {
		writeFileSync(join(dir, "notes.md"), 'import { Notice } from "obsidian";\n');
		const result = scanForObsidianDependencies(dir);
		expect(result.files).toEqual([join(dir, "pure.ts")]);
		expect(result.dependencies).toEqual([]);
	});

	it("honours an exclusion, which is how the shell module is allowed its import", () => {
		writeFileSync(join(dir, "view.ts"), 'import { Notice } from "obsidian";\n');
		const result = scanForObsidianDependencies(dir, {
			exclude: (file) => file.endsWith("view.ts"),
		});
		expect(result.dependencies).toEqual([]);
		expect(result.files).toEqual([join(dir, "pure.ts")]);
	});

	it("lists every TypeScript file it walked, so a caller can refuse a vacuous pass", () => {
		mkdirSync(join(dir, "nested"));
		writeFileSync(join(dir, "nested", "deep.ts"), "export const x = 1;\n");
		expect(typeScriptFilesUnder(dir).slice().sort()).toEqual(
			[join(dir, "pure.ts"), join(dir, "nested", "deep.ts")].sort(),
		);
	});
});
