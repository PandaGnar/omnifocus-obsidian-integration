import { builtinModules } from "node:module";
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import "dotenv/config";
import esbuild from "esbuild";

import manifest from "./manifest.json" with { type: "json" };

const dev = process.argv.includes("--dev");

// Obsidian supplies these at runtime. Bundling them produces a plugin that
// loads a second copy of the editor and breaks.
const external = [
	"obsidian",
	"electron",
	"@codemirror/autocomplete",
	"@codemirror/collab",
	"@codemirror/commands",
	"@codemirror/language",
	"@codemirror/lint",
	"@codemirror/search",
	"@codemirror/state",
	"@codemirror/view",
	"@lezer/common",
	"@lezer/highlight",
	"@lezer/lr",
	// Both spellings: builtinModules lists bare names only, so a `node:fs`
	// import would fail to resolve under platform "browser".
	...builtinModules,
	...builtinModules.map((m) => `node:${m}`),
];

/** A misconfigured vault path is user error, not a crash worth a stack trace. */
function fail(message) {
	console.error(message);
	process.exit(1);
}

/**
 * A shell would expand `~` before Node ever saw it, but a value read from .env
 * arrives literally, so expand it here rather than reporting "no .obsidian/"
 * for a path the user considers perfectly valid.
 */
function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** In dev we build into the live vault so Obsidian can reload the plugin. */
function devOutDir() {
	const raw = process.env.OBSIDIAN_VAULT_PATH;
	const configured = raw?.trim();
	if (!configured) {
		// "not set" is a lie when the key is present but blank, and someone
		// staring at a .env line that plainly exists will lose a minute to it.
		fail(
			`OBSIDIAN_VAULT_PATH is ${raw === undefined ? "not set" : "set but empty"}.\n` +
				"Copy .env.example to .env and point OBSIDIAN_VAULT_PATH at your vault root\n" +
				"(the folder containing .obsidian/), then run npm run dev again.",
		);
	}
	const vault = resolve(expandHome(configured));
	if (!existsSync(join(vault, ".obsidian"))) {
		fail(
			`OBSIDIAN_VAULT_PATH="${configured}" does not look like a vault:\n` +
				`  resolved to ${vault}\n` +
				"there is no .obsidian/ directory there. Point it at the vault root, not a subfolder.",
		);
	}
	const outDir = join(vault, ".obsidian", "plugins", manifest.id);
	mkdirSync(outDir, { recursive: true });
	return outDir;
}

const outDir = dev ? devOutDir() : ".";

/** Obsidian reads manifest.json from the plugin folder, next to main.js. */
function copyManifest() {
	if (dev) copyFileSync("manifest.json", join(outDir, "manifest.json"));
}

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	outfile: join(outDir, "main.js"),
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2022",
	external,
	sourcemap: dev ? "inline" : false,
	minify: !dev,
	treeShaking: true,
	logLevel: "info",
	plugins: [
		{
			name: "copy-manifest",
			setup(build) {
				build.onEnd(copyManifest);
			},
		},
	],
});

if (dev) {
	await context.watch();
	console.log(`watching — building into ${outDir}`);
} else {
	await context.rebuild();
	await context.dispose();
	// Fail loudly rather than letting CI pass on a missing bundle.
	const out = join(outDir, "main.js");
	if (!existsSync(out) || statSync(out).size === 0) {
		throw new Error(`build produced no output at ${out}`);
	}
}
