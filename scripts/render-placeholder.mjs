// Regenerate the committed `docs/benchmarks.md` placeholder from the same
// renderer the real run uses, so the structure a reader sees before the first
// run is exactly the structure the first run fills in.
//
//   node scripts/render-placeholder.mjs
//
// A test asserts the committed file still matches this output, so run it after
// changing anything in `src/bench/report.ts`.

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "node_modules", ".cache", "mise-bench", "report.mjs");

await esbuild.build({
	entryPoints: [join(root, "src", "bench", "report.ts")],
	outfile: bundle,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	logLevel: "warning",
});

const { renderNotRunDocument } = await import(pathToFileURL(bundle).href);
const target = join(root, "docs", "benchmarks.md");
writeFileSync(target, renderNotRunDocument(), "utf8");
console.log(`wrote ${target}`);
