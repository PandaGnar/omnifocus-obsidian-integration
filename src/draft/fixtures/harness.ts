// A vault you can write to.
//
// The chat fixtures build a `VaultIndex` once and read from a frozen list,
// which is all a chat turn needs. A draft *writes*, and the property PR 6 is
// judged on — "running it twice is a no-op" — cannot be tested without a vault
// that remembers the first run. So this is the smallest thing that can: a list
// of path/content pairs, an index derived from it, and a `write` that adds or
// replaces one entry.
//
// It is deliberately not a mock of Obsidian's `Vault`. Nothing here pretends to
// have a `TFile`, a metadata cache or an event bus; the plugin's adapter is
// three calls wide and this stands in for exactly those three.

import { NOTE_CONTENTS } from "../../context/fixtures/notes";
import { VAULT_TREE } from "../../vault/fixtures/vaultTree";
import { DAILY_TEMPLATE_PATH } from "../../vault/paths";
import { createVaultIndex, type VaultIndex } from "../../vault/resolver";
import { TEMPLATE_TEXT } from "./template";

export class FakeVault {
	private readonly contents = new Map<string, string>();
	private readonly order: string[] = [];

	constructor(entries: readonly (readonly [string, string])[]) {
		for (const [path, text] of entries) this.write(path, text);
	}

	/** Every path, in insertion order — deliberately unsorted, like Obsidian. */
	paths(): readonly string[] {
		return [...this.order];
	}

	index(): VaultIndex {
		return createVaultIndex(this.paths());
	}

	read = (path: string): Promise<string> => {
		const text = this.contents.get(path);
		return text === undefined
			? Promise.reject(new Error(`no such note: ${path}`))
			: Promise.resolve(text);
	};

	write(path: string, text: string): void {
		if (!this.contents.has(path)) this.order.push(path);
		this.contents.set(path, text);
	}

	has(path: string): boolean {
		return this.contents.has(path);
	}

	textOf(path: string): string | null {
		return this.contents.get(path) ?? null;
	}
}

/**
 * The fixture vault as a writable one: every path from `VAULT_TREE`, the
 * contents from `NOTE_CONTENTS` where there are any, and the daily template.
 *
 * Paths with no fixture content still exist as *paths*, because the resolver
 * works from the path list and several of its cases (the collision suffixes,
 * the misfiled buckets) live in files nobody reads.
 */
export function fixtureVault(options: { readonly omit?: readonly string[] } = {}): FakeVault {
	const omit = new Set(options.omit ?? []);
	const known = new Map<string, string>([
		...NOTE_CONTENTS.map(([path, text]) => [path, text] as [string, string]),
		[DAILY_TEMPLATE_PATH, TEMPLATE_TEXT],
	]);

	const entries: [string, string][] = [];
	for (const path of VAULT_TREE) {
		if (omit.has(path)) continue;
		if (!path.endsWith(".md")) continue;
		entries.push([path, known.get(path) ?? ""]);
	}
	return new FakeVault(entries);
}
