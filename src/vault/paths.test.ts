import { describe, expect, it } from "vitest";

import {
	basename,
	depth,
	isArchivedPath,
	isExcludedPath,
	isMarkdown,
	isTemplatePath,
	splitCollisionSuffix,
	stem,
} from "./paths";

describe("path pieces", () => {
	it("splits basename and stem", () => {
		expect(basename("Mise/26.07/26.07.02 1.md")).toBe("26.07.02 1.md");
		expect(stem("Mise/26.07/26.07.02 1.md")).toBe("26.07.02 1");
		expect(stem("Long Term/26 Y+ Goals.md")).toBe("26 Y+ Goals");
	});

	it("keeps dotted stems intact — daily notes are full of dots", () => {
		expect(stem("Mise/26.08.16.md")).toBe("26.08.16");
		expect(stem("Long Term/Archive/xx.xx.xx Mise Old 24.01.08.md")).toBe(
			"xx.xx.xx Mise Old 24.01.08",
		);
	});

	it("counts folder depth", () => {
		expect(depth("Long Term.md")).toBe(0);
		expect(depth("Mise/26.08.16.md")).toBe(1);
		expect(depth("Mise/26.07/26.07.02.md")).toBe(2);
	});

	it("recognises markdown", () => {
		expect(isMarkdown("Mise/26.08.16.md")).toBe(true);
		expect(isMarkdown("zAssets/Pasted image 1.png")).toBe(false);
	});
});

describe("isTemplatePath", () => {
	it.each([
		"Mise/xx.xx.xx Mise.md",
		"Long Term/xx Wxx Goals.md",
		"Long Term/xx Mxx Goals.md",
		"Long Term/xx Qx Goals.md",
		// Unspaced, unlike the live `26 Y+ Goals.md` beside it.
		"Long Term/xxY+ Goals.md",
		"Long Term/xx.xx.xx Needs Assessment.md",
	])("flags %s", (path) => {
		expect(isTemplatePath(path)).toBe(true);
	});

	it.each([
		"Long Term/26 Y+ Goals.md",
		"Long Term/26 W33 Goals.md",
		"Mise/26.08.16.md",
	])("leaves %s alone", (path) => {
		expect(isTemplatePath(path)).toBe(false);
	});
});

describe("isArchivedPath", () => {
	it.each([
		"Long Term/Archive/2025/25 W52 Goals.md",
		"Long Term/Archive/2025/25.12/25.12.31.md",
		"Notes/Archive/Some old note.md",
	])("flags %s", (path) => {
		expect(isArchivedPath(path)).toBe(true);
	});

	it("does not flag a note that is merely called Archive", () => {
		expect(isArchivedPath("Long Term/Archive.md")).toBe(false);
	});
});

describe("isExcludedPath", () => {
	it.each([
		["template", "Mise/xx.xx.xx Mise.md"],
		["archive", "Long Term/Archive/2025/25 Q4 Goals.md"],
		["attachment folder", "zAssets/diagram.md"],
		["pasted image", "Pasted image 20260814093000.png"],
		["untitled", "Untitled 1.md"],
		["welcome", "Welcome.md"],
		["app state", ".obsidian/plugins/mise-assistant/main.js"],
		["trash", ".trash/26.08.15.md"],
	])("excludes a %s", (_label, path) => {
		expect(isExcludedPath(path)).toBe(true);
	});

	it.each([
		"Mise/26.08.16.md",
		"Mise/26.07/26.07.02 1.md",
		"Long Term/26 W33 Goals.md",
		"Long Term/Life Goals.md",
		"Financial Planning.md",
	])("keeps %s", (path) => {
		expect(isExcludedPath(path)).toBe(false);
	});

	it("re-admits archives only when the caller asks for history", () => {
		const archived = "Long Term/Archive/2025/25.12/25.12.31.md";
		expect(isExcludedPath(archived, { includeArchives: true })).toBe(false);
		// The retired template stays out even then — it is scaffolding, and
		// `vault-conventions.md` says only the current one is authoritative.
		expect(
			isExcludedPath("Long Term/Archive/xx.xx.xx Mise Old 24.01.08.md", {
				includeArchives: true,
			}),
		).toBe(true);
	});
});

describe("splitCollisionSuffix", () => {
	it("splits Obsidian's collision suffix", () => {
		expect(splitCollisionSuffix("26.07.02 1")).toEqual({
			base: "26.07.02",
			suffix: 1,
		});
		expect(splitCollisionSuffix("25.01.29 12")).toEqual({
			base: "25.01.29",
			suffix: 12,
		});
	});

	it("leaves unsuffixed stems alone", () => {
		expect(splitCollisionSuffix("26.07.02")).toEqual({
			base: "26.07.02",
			suffix: null,
		});
		// `Goals` is not a number, so nothing is stripped.
		expect(splitCollisionSuffix("26 W33 Goals")).toEqual({
			base: "26 W33 Goals",
			suffix: null,
		});
	});
});
