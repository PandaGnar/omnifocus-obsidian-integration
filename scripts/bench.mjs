// `npm run bench` entry point.
//
// The harness is TypeScript that lives in `src/bench/` alongside the client it
// measures, so it is typechecked and unit-tested with everything else. Node
// cannot import that directly, so this bundles it with esbuild — already a
// dependency, no new tooling — and runs the bundle.
//
// The bundle deliberately does NOT mark `obsidian` external: the harness must
// never import it, and a build failure here is the cheapest possible way to
// find out that something did.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "node_modules", ".cache", "mise-bench", "cli.mjs");

mkdirSync(dirname(outFile), { recursive: true });

await esbuild.build({
	entryPoints: [join(root, "src", "bench", "cli.ts")],
	outfile: outFile,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	sourcemap: "inline",
	logLevel: "warning",
});

const { main } = await import(pathToFileURL(outFile).href);
process.exitCode = await main(process.argv.slice(2));
