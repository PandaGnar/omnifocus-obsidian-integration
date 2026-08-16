// Settings shape, defaults and validation. Pure — no `obsidian` import — so
// the sanitiser can be unit-tested against the junk a hand-edited or
// version-skewed `data.json` can contain.

import { normalizeBaseUrl } from "../ollama/protocol";

/**
 * `gemma4:e4b` is the default; `gemma4:e2b` is the ≤16 GB fallback. Both are
 * 128K-context, but that ceiling is a memory limit, not a working set — see
 * `docs/plan.md`.
 */
export const DEFAULT_MODEL = "gemma4:e4b";
export const SMALL_MACHINE_MODEL = "gemma4:e2b";

export const NUM_CTX_MIN = 512;
export const NUM_CTX_MAX = 131072;
export const NUM_PREDICT_MIN = 1;
export const NUM_PREDICT_MAX = 32768;

export interface MiseSettings {
	baseUrl: string;
	model: string;
	/** Sent on every request; never left to the server. */
	numCtx: number;
	numPredict: number;
	/** Duration string (`30m`, `1h`), seconds as a string, or `-1` for forever. */
	keepAlive: string;
	/** When true, a failed streaming attempt retries without streaming. */
	fallbackToNonStreaming: boolean;
}

export const DEFAULT_SETTINGS: MiseSettings = {
	// 127.0.0.1 rather than localhost: on machines where localhost resolves to
	// ::1 first, Ollama's default IPv4-only bind refuses the connection.
	baseUrl: "http://127.0.0.1:11434",
	model: DEFAULT_MODEL,
	numCtx: 32768,
	numPredict: 2048,
	// Ollama's default is 5 minutes. Unloading the model throws away the prompt
	// cache, which turns a sub-second follow-up into a full cold prefill.
	keepAlive: "30m",
	fallbackToNonStreaming: true,
};

const KEEP_ALIVE_PATTERN = /^(-1|0|\d+(\.\d+)?(ns|us|ms|s|m|h)?)$/;

/** `30m`, `1h`, `600`, `0` (unload now) and `-1` (never unload) are all valid. */
export function isValidKeepAlive(value: string): boolean {
	return KEEP_ALIVE_PATTERN.test(value.trim());
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.round(n), min), max);
}

export function normalizeNumCtx(value: unknown): number {
	return clampInt(value, DEFAULT_SETTINGS.numCtx, NUM_CTX_MIN, NUM_CTX_MAX);
}

export function normalizeNumPredict(value: unknown): number {
	return clampInt(value, DEFAULT_SETTINGS.numPredict, NUM_PREDICT_MIN, NUM_PREDICT_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
	const value = source[key];
	return typeof value === "string" ? value : null;
}

/**
 * Turn whatever `loadData()` returned into a usable settings object. Obsidian
 * hands back the raw parsed `data.json`, which may be null on first run, may
 * predate a field, and may have been edited by hand — so nothing is trusted.
 */
export function sanitizeSettings(loaded: unknown): MiseSettings {
	if (!isRecord(loaded)) return { ...DEFAULT_SETTINGS };

	const baseUrlRaw = readString(loaded, "baseUrl");
	const baseUrl =
		baseUrlRaw === null || normalizeBaseUrl(baseUrlRaw) === ""
			? DEFAULT_SETTINGS.baseUrl
			: normalizeBaseUrl(baseUrlRaw);

	const modelRaw = readString(loaded, "model")?.trim() ?? "";
	const keepAliveRaw = readString(loaded, "keepAlive")?.trim() ?? "";
	const fallback = loaded["fallbackToNonStreaming"];

	return {
		baseUrl,
		model: modelRaw === "" ? DEFAULT_SETTINGS.model : modelRaw,
		numCtx: normalizeNumCtx(loaded["numCtx"]),
		numPredict: normalizeNumPredict(loaded["numPredict"]),
		keepAlive: isValidKeepAlive(keepAliveRaw)
			? keepAliveRaw
			: DEFAULT_SETTINGS.keepAlive,
		fallbackToNonStreaming:
			typeof fallback === "boolean"
				? fallback
				: DEFAULT_SETTINGS.fallbackToNonStreaming,
	};
}

/**
 * Warnings worth showing next to the settings rather than at request time.
 * Returns an empty array when the configuration is unremarkable.
 */
export function settingsWarnings(settings: MiseSettings): string[] {
	const warnings: string[] = [];
	if (settings.numCtx > 65536) {
		warnings.push(
			`num_ctx of ${settings.numCtx} costs KV cache memory and prefill time on every ` +
				"request. Long context degrades answer quality before it degrades speed.",
		);
	}
	if (settings.keepAlive === "0") {
		warnings.push(
			"keep_alive of 0 unloads the model after every request, discarding the prompt " +
				"cache. Expect a cold prefill on every question.",
		);
	}
	return warnings;
}
