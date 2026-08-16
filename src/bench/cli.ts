// `npm run bench` — the shell around the pure parts.
//
// Everything decidable without a server lives in `args.ts`, `metrics.ts`,
// `prompt.ts`, `kv.ts`, `ps.ts` and `report.ts` and is unit-tested. What is
// left here is process plumbing: read argv, build the client, run, write the
// file, pick an exit code.
//
// The one behaviour worth stating out loud: when there is no server, this exits
// non-zero with an explanation and writes nothing. It never emits a zero-filled
// table, because a table of zeroes in a committed file is indistinguishable
// from a measurement and would be read as one later.

import { mkdirSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, totalmem } from "node:os";
import { dirname, resolve } from "node:path";

import { OllamaClient } from "../ollama/client";
import { endpointUrl } from "../ollama/protocol";
import { DEFAULT_SETTINGS, type MiseSettings } from "../settings/settings";
import { parseBenchArgs, type BenchOptions } from "./args";
import type { OllamaPsResponse } from "./ps";
import { renderBenchmarkDocument } from "./report";
import {
	BenchmarkMeasurementError,
	BenchmarkUnavailableError,
	runBenchmark,
	type BenchEnvironment,
	type BenchRunnerDeps,
} from "./runner";
import { createFetchTransport } from "./transport";

export interface CliIo {
	out: (line: string) => void;
	err: (line: string) => void;
}

const PS_PATH = "/api/ps";
const VERSION_PATH = "/api/version";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the deps the runner needs. Kept separate from `main` so the wiring is
 * readable: settings live in a mutable holder because `OllamaClient` reads them
 * per call, which is exactly the seam that lets `num_ctx` change between cases
 * without a second client.
 */
function createDeps(options: BenchOptions, io: CliIo): BenchRunnerDeps {
	const transport = createFetchTransport();
	let settings: MiseSettings = {
		...DEFAULT_SETTINGS,
		baseUrl: options.baseUrl,
		model: options.model,
		numPredict: options.numPredict,
		keepAlive: options.keepAlive,
		// The buffered fallback cannot produce a time-to-first-token — it delivers
		// the whole reply at once. Measuring prefill requires streaming, so a
		// streaming failure must surface as a failure rather than quietly becoming
		// an end-to-end latency reported in the TTFT column.
		fallbackToNonStreaming: false,
	};
	const client = new OllamaClient({ transport, getSettings: () => settings });

	const environment: BenchEnvironment = {
		node: process.version,
		platform: platform(),
		arch: arch(),
		hostname: hostname(),
		totalMemoryBytes: totalmem(),
		flashAttention: process.env["OLLAMA_FLASH_ATTENTION"] ?? null,
		kvCacheType: process.env["OLLAMA_KV_CACHE_TYPE"] ?? null,
	};

	return {
		client,
		applySettings: (patch) => {
			settings = { ...settings, ...patch };
		},
		readPs: async (): Promise<OllamaPsResponse | null> => {
			try {
				const response = await transport.request({
					url: endpointUrl(options.baseUrl, PS_PATH),
					method: "GET",
				});
				if (response.status < 200 || response.status >= 300) return null;
				const parsed: unknown = JSON.parse(response.text);
				return isRecord(parsed) ? (parsed as OllamaPsResponse) : null;
			} catch {
				// A build without /api/ps still produces valid timings; the memory
				// column degrades to "not loaded" rather than failing the run.
				return null;
			}
		},
		readServerVersion: async (): Promise<string | null> => {
			try {
				const response = await transport.request({
					url: endpointUrl(options.baseUrl, VERSION_PATH),
					method: "GET",
				});
				const parsed: unknown = JSON.parse(response.text);
				if (isRecord(parsed) && typeof parsed["version"] === "string") {
					return parsed["version"];
				}
				return null;
			} catch {
				return null;
			}
		},
		now: () => performance.now(),
		nowIso: () => new Date().toISOString(),
		log: (line) => io.err(line),
		environment,
	};
}

function writeFileAt(path: string, contents: string): string {
	const absolute = resolve(path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents, "utf8");
	return absolute;
}

/** Returns the process exit code. 0 only if every measurement succeeded. */
export async function main(
	argv: readonly string[],
	io: CliIo = { out: console.log, err: console.error },
): Promise<number> {
	const parsed = parseBenchArgs(argv, process.env);
	if (parsed.kind === "help") {
		io.out(parsed.text);
		return 0;
	}
	if (parsed.kind === "error") {
		io.err(parsed.message);
		io.err("Run with --help for the options.");
		return 2;
	}

	const options = parsed.options;
	io.err(
		`Benchmarking ${options.model} at ${options.baseUrl} — sizes ${options.contextSizes.join(
			", ",
		)}, num_predict ${options.numPredict}.`,
	);
	io.err("Each size runs twice: once cold, once with an identical prompt for the cache.");

	try {
		const run = await runBenchmark(options, createDeps(options, io));
		const document = renderBenchmarkDocument(run);
		if (options.outPath === null) {
			io.out(document);
		} else {
			const written = writeFileAt(options.outPath, document);
			io.err(`Wrote ${written}`);
		}
		if (options.jsonPath !== null) {
			const written = writeFileAt(options.jsonPath, `${JSON.stringify(run, null, "\t")}\n`);
			io.err(`Wrote ${written}`);
		}
		return 0;
	} catch (error) {
		if (error instanceof BenchmarkUnavailableError) {
			io.err(`\nBenchmark did not run.\n${error.message}`);
			return 1;
		}
		if (error instanceof BenchmarkMeasurementError) {
			io.err(`\nBenchmark aborted.\n${error.message}`);
			return 1;
		}
		io.err(`\nBenchmark failed: ${error instanceof Error ? error.stack : String(error)}`);
		return 1;
	}
}
