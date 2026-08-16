import { describe, expect, it } from "vitest";

import {
	DEFAULT_MODEL,
	DEFAULT_SETTINGS,
	NUM_CTX_MAX,
	NUM_CTX_MIN,
	isValidKeepAlive,
	normalizeNumCtx,
	normalizeNumPredict,
	sanitizeSettings,
	settingsWarnings,
} from "./settings";

describe("defaults", () => {
	it("matches the researched defaults", () => {
		expect(DEFAULT_SETTINGS.model).toBe("gemma4:e4b");
		expect(DEFAULT_SETTINGS.numCtx).toBe(32768);
		expect(DEFAULT_SETTINGS.numPredict).toBe(2048);
		expect(DEFAULT_SETTINGS.keepAlive).toBe("30m");
	});
});

describe("isValidKeepAlive", () => {
	it("accepts durations, bare seconds, and the never-unload sentinel", () => {
		for (const value of ["30m", "1h", "5s", "600", "0", "-1", "1.5h"]) {
			expect(isValidKeepAlive(value), value).toBe(true);
		}
	});

	it("rejects nonsense that would make Ollama reject the whole request", () => {
		for (const value of ["", "forever", "30 minutes", "-2", "m30", "30m30"]) {
			expect(isValidKeepAlive(value), value).toBe(false);
		}
	});
});

describe("normalizeNumCtx", () => {
	it("keeps a sane value", () => {
		expect(normalizeNumCtx(8192)).toBe(8192);
	});

	it("parses a value typed into a text field", () => {
		expect(normalizeNumCtx("16384")).toBe(16384);
	});

	it("clamps rather than sending a value the server will reject", () => {
		expect(normalizeNumCtx(1)).toBe(NUM_CTX_MIN);
		expect(normalizeNumCtx(10_000_000)).toBe(NUM_CTX_MAX);
	});

	it("falls back to the default for junk", () => {
		expect(normalizeNumCtx("abc")).toBe(DEFAULT_SETTINGS.numCtx);
		expect(normalizeNumCtx(undefined)).toBe(DEFAULT_SETTINGS.numCtx);
		expect(normalizeNumCtx(Number.NaN)).toBe(DEFAULT_SETTINGS.numCtx);
	});
});

describe("normalizeNumPredict", () => {
	it("never returns the unbounded default", () => {
		expect(normalizeNumPredict(-1)).toBeGreaterThan(0);
		expect(normalizeNumPredict(0)).toBeGreaterThan(0);
	});
});

describe("sanitizeSettings", () => {
	it("returns defaults for a first run with no data.json", () => {
		expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(sanitizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
	});

	it("normalises a hand-typed base URL", () => {
		expect(sanitizeSettings({ baseUrl: "127.0.0.1:11434/api/" }).baseUrl).toBe(
			"http://127.0.0.1:11434",
		);
	});

	it("falls back to the default host when the stored URL is blank", () => {
		expect(sanitizeSettings({ baseUrl: "   " }).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
	});

	it("fills in fields added after the file was written", () => {
		const settings = sanitizeSettings({ baseUrl: "http://127.0.0.1:11434" });
		expect(settings.model).toBe(DEFAULT_MODEL);
		expect(settings.numCtx).toBe(DEFAULT_SETTINGS.numCtx);
		expect(settings.fallbackToNonStreaming).toBe(true);
	});

	it("rejects a keep_alive the server would refuse", () => {
		expect(sanitizeSettings({ keepAlive: "forever" }).keepAlive).toBe(
			DEFAULT_SETTINGS.keepAlive,
		);
		expect(sanitizeSettings({ keepAlive: "-1" }).keepAlive).toBe("-1");
	});

	it("keeps a user's explicit false for the fallback toggle", () => {
		expect(sanitizeSettings({ fallbackToNonStreaming: false }).fallbackToNonStreaming).toBe(
			false,
		);
	});

	it("coerces a wrong-typed number field instead of trusting it", () => {
		expect(sanitizeSettings({ numCtx: "8192" }).numCtx).toBe(8192);
		expect(sanitizeSettings({ numCtx: {} }).numCtx).toBe(DEFAULT_SETTINGS.numCtx);
	});
});

describe("settingsWarnings", () => {
	it("says nothing about the defaults", () => {
		expect(settingsWarnings(DEFAULT_SETTINGS)).toEqual([]);
	});

	it("warns about a very large context window", () => {
		expect(settingsWarnings({ ...DEFAULT_SETTINGS, numCtx: 131072 })).toHaveLength(1);
	});

	it("warns that keep_alive 0 discards the prompt cache", () => {
		expect(settingsWarnings({ ...DEFAULT_SETTINGS, keepAlive: "0" })[0]).toMatch(
			/prompt cache/i,
		);
	});
});
