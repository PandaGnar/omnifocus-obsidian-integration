// Command-line parsing for `npm run bench`. Pure: argv and an environment
// snapshot in, a validated options object or an error message out. Nothing here
// reads `process`, so the whole surface is unit-testable.

import { normalizeBaseUrl } from "../ollama/protocol";
import {
	DEFAULT_SETTINGS,
	NUM_CTX_MAX,
	NUM_CTX_MIN,
	NUM_PREDICT_MAX,
	NUM_PREDICT_MIN,
	isValidKeepAlive,
} from "../settings/settings";

/** The four sizes the plan names. 8K vs 32K is the KV-scaling comparison. */
export const DEFAULT_CONTEXT_SIZES = [2048, 8192, 16384, 32768];

/**
 * Decode sample length. Long enough for a stable tokens/sec figure, short
 * enough that a four-size run does not take all afternoon. It is also the
 * headroom reserved out of `num_ctx` for the reply.
 */
export const DEFAULT_NUM_PREDICT = 128;

/**
 * Slack between the prompt and `num_ctx`, on top of `num_predict`. The prompt
 * is sized with a chars/4 estimate that can be ~20% off; without a margin an
 * over-shooting estimate would silently truncate the prompt and the row would
 * measure the wrong thing.
 */
export const CONTEXT_HEADROOM_TOKENS = 512;

export const DEFAULT_OUTPUT_PATH = "docs/benchmarks.md";

export interface BenchOptions {
	baseUrl: string;
	model: string;
	/** Ascending, de-duplicated. Each becomes one `num_ctx` and one table row. */
	contextSizes: number[];
	numPredict: number;
	keepAlive: string;
	/** Where the markdown report is written, or null for `--no-write`. */
	outPath: string | null;
	/** Optional raw-JSON dump path, for re-rendering without re-running. */
	jsonPath: string | null;
}

export type BenchArgs =
	| { kind: "options"; options: BenchOptions }
	| { kind: "help"; text: string }
	| { kind: "error"; message: string };

export const USAGE = `Usage: npm run bench -- [options]

Times prefill (time-to-first-token) and decode (tokens/sec) separately at a
range of context sizes against a running Ollama server, measures prompt-cache
reuse by repeating each prompt, and records where the model is resident.

Options:
  --url <url>          Ollama base URL (default ${DEFAULT_SETTINGS.baseUrl}, or $OLLAMA_HOST)
  -m, --model <name>   Model to benchmark (default ${DEFAULT_SETTINGS.model}, or $MISE_BENCH_MODEL)
  --sizes <a,b,c>      Context sizes to test (default ${DEFAULT_CONTEXT_SIZES.join(",")})
  --num-predict <n>    Tokens to generate per run (default ${DEFAULT_NUM_PREDICT})
  --keep-alive <v>     keep_alive for every request (default ${DEFAULT_SETTINGS.keepAlive})
  --out <path>         Markdown report path (default ${DEFAULT_OUTPUT_PATH})
  --json <path>        Also write the raw measurements as JSON
  --no-write           Print the report, write nothing
  -h, --help           Show this help

The run fails loudly and writes nothing if the server is unreachable, the model
is not installed, or any single measurement fails. There is no partial table.`;

function parsePositiveInt(raw: string): number | null {
	if (!/^\d+$/.test(raw.trim())) return null;
	const value = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(value) && value > 0 ? value : null;
}

function parseSizes(raw: string): number[] | string {
	const parts = raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	if (parts.length === 0) return "--sizes needs at least one context size.";
	const sizes: number[] = [];
	for (const part of parts) {
		const value = parsePositiveInt(part);
		if (value === null) return `--sizes got "${part}", which is not a positive integer.`;
		if (value < NUM_CTX_MIN || value > NUM_CTX_MAX) {
			return `--sizes got ${value}, outside the supported range ${NUM_CTX_MIN}–${NUM_CTX_MAX}.`;
		}
		sizes.push(value);
	}
	// Ascending so the report reads small-to-large, and de-duplicated so a
	// repeated size cannot masquerade as an independent measurement.
	return [...new Set(sizes)].sort((a, b) => a - b);
}

/**
 * Parse argv (without `node` and the script path) against an environment.
 *
 * `env` is a parameter rather than a `process.env` read so the defaults are
 * testable. `OLLAMA_HOST` is honoured because that is the variable users
 * already set for the `ollama` CLI itself.
 */
export function parseBenchArgs(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>> = {},
): BenchArgs {
	const options: BenchOptions = {
		baseUrl: env["OLLAMA_HOST"]?.trim() || DEFAULT_SETTINGS.baseUrl,
		model: env["MISE_BENCH_MODEL"]?.trim() || DEFAULT_SETTINGS.model,
		contextSizes: [...DEFAULT_CONTEXT_SIZES],
		numPredict: DEFAULT_NUM_PREDICT,
		keepAlive: DEFAULT_SETTINGS.keepAlive,
		outPath: DEFAULT_OUTPUT_PATH,
		jsonPath: null,
	};

	/**
	 * The value following a flag, or null when the flag was given without one.
	 * A following `--flag` counts as missing; a bare `-1` does not, so
	 * `--keep-alive -1` still works.
	 */
	const takeValue = (index: number): string | null => {
		const value = argv[index + 1];
		return value === undefined || value.startsWith("--") ? null : value;
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		switch (arg) {
			case "-h":
			case "--help":
				return { kind: "help", text: USAGE };
			case "--no-write":
				options.outPath = null;
				break;
			case "--url":
			case "--base-url": {
				const value = takeValue(i);
				if (value === null) return { kind: "error", message: `${arg} needs a URL.` };
				const normalized = normalizeBaseUrl(value);
				if (normalized === "") {
					return { kind: "error", message: `${arg} got "${value}", which is not a usable URL.` };
				}
				options.baseUrl = normalized;
				i += 1;
				break;
			}
			case "-m":
			case "--model": {
				const value = takeValue(i);
				if (value === null || value.trim() === "") {
					return { kind: "error", message: `${arg} needs a model name.` };
				}
				options.model = value.trim();
				i += 1;
				break;
			}
			case "--sizes": {
				const value = takeValue(i);
				if (value === null) {
					return { kind: "error", message: "--sizes needs a comma-separated list." };
				}
				const sizes = parseSizes(value);
				if (typeof sizes === "string") return { kind: "error", message: sizes };
				options.contextSizes = sizes;
				i += 1;
				break;
			}
			case "--num-predict": {
				const value = takeValue(i);
				const parsed = value === null ? null : parsePositiveInt(value);
				if (parsed === null) {
					return { kind: "error", message: "--num-predict needs a positive integer." };
				}
				if (parsed < NUM_PREDICT_MIN || parsed > NUM_PREDICT_MAX) {
					return {
						kind: "error",
						message: `--num-predict got ${parsed}, outside ${NUM_PREDICT_MIN}–${NUM_PREDICT_MAX}.`,
					};
				}
				options.numPredict = parsed;
				i += 1;
				break;
			}
			case "--keep-alive": {
				const value = takeValue(i);
				if (value === null || !isValidKeepAlive(value)) {
					return {
						kind: "error",
						message: "--keep-alive needs a duration like 30m, a number of seconds, or -1.",
					};
				}
				options.keepAlive = value.trim();
				i += 1;
				break;
			}
			case "--out": {
				const value = takeValue(i);
				if (value === null || value.trim() === "") {
					return { kind: "error", message: "--out needs a file path." };
				}
				options.outPath = value.trim();
				i += 1;
				break;
			}
			case "--json": {
				const value = takeValue(i);
				if (value === null || value.trim() === "") {
					return { kind: "error", message: "--json needs a file path." };
				}
				options.jsonPath = value.trim();
				i += 1;
				break;
			}
			default:
				return {
					kind: "error",
					message: `Unrecognised argument "${arg}".`,
				};
		}
	}

	// A prompt has to fit alongside the reply. Catch it here rather than after
	// the model has loaded and the first prefill has run.
	const smallest = options.contextSizes[0] ?? 0;
	const floor = options.numPredict + CONTEXT_HEADROOM_TOKENS;
	if (smallest <= floor) {
		return {
			kind: "error",
			message:
				`Context size ${smallest} leaves no room for a prompt: ${options.numPredict} ` +
				`reply tokens plus ${CONTEXT_HEADROOM_TOKENS} tokens of headroom already fill it. ` +
				"Use a larger --sizes value or a smaller --num-predict.",
		};
	}

	return { kind: "options", options };
}

/** Prompt size for a given context size: the window minus reply and headroom. */
export function promptTargetTokens(numCtx: number, numPredict: number): number {
	return Math.max(0, numCtx - numPredict - CONTEXT_HEADROOM_TOKENS);
}
