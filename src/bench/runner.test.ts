// The measurement loop, driven end to end against a fake transport.
//
// The fake server is deliberately not a stub of `OllamaClient` — the real
// client, the real NDJSON decoder and the real request builder all run here.
// What is faked is the socket and the clock, which is the only part a machine
// with no Ollama on it cannot supply.

import { describe, expect, it } from "vitest";

import { OllamaClient } from "../ollama/client";
import { DEFAULT_SETTINGS, type MiseSettings } from "../settings/settings";
import type { HttpRequest, HttpResponse, OllamaChatRequest } from "../ollama/types";
import { NS_PER_MS } from "./metrics";
import type { BenchOptions } from "./args";
import {
	BENCH_SEED,
	BENCH_TEMPERATURE,
	BenchmarkMeasurementError,
	BenchmarkUnavailableError,
	runBenchmark,
	type BenchEnvironment,
	type BenchRunnerDeps,
} from "./runner";
import type { OllamaPsResponse } from "./ps";

const MODEL = "gemma4:e4b";

/** Milliseconds the fake takes before the first token, cold and cached. */
const COLD_PREFILL_MS = 1200;
const WARM_PREFILL_MS = 40;
const DECODE_MS = 320;
const DECODE_TOKENS = 128;

const ENVIRONMENT: BenchEnvironment = {
	node: "v22.0.0",
	platform: "darwin",
	arch: "arm64",
	hostname: "test-host",
	totalMemoryBytes: 34_359_738_368,
	flashAttention: null,
	kvCacheType: null,
	numParallel: null,
};

const PS_RESPONSE: OllamaPsResponse = {
	models: [{ name: MODEL, model: MODEL, size: 12_000_000_000, size_vram: 12_000_000_000 }],
};

const SHOW_BODY = JSON.stringify({
	model_info: {
		"gemma4.block_count": 30,
		"gemma4.attention.head_count": 8,
		"gemma4.attention.head_count_kv": 4,
		"gemma4.attention.key_length": 256,
	},
});

interface FakeServerOptions {
	installedModels?: string[];
	failTagsWith?: Error;
	failChatAt?: number;
}

interface FakeServer {
	deps: BenchRunnerDeps;
	chatRequests: OllamaChatRequest[];
	psReads: number;
}

/**
 * A server that behaves like Ollama in the two ways this test turns on: it
 * bills prefill time by whether it has seen the exact prompt before (that is
 * the prompt cache), and it reports every duration in nanoseconds.
 */
function createFakeServer(options: FakeServerOptions = {}): FakeServer {
	const installed = options.installedModels ?? [MODEL, "gemma4:e2b"];
	const chatRequests: OllamaChatRequest[] = [];
	const seenPrompts = new Set<string>();
	let clock = 0;
	let chatCalls = 0;

	async function* stream(req: HttpRequest): AsyncIterable<string> {
		chatCalls += 1;
		if (options.failChatAt === chatCalls) {
			throw new TypeError("Failed to fetch");
		}
		const body = JSON.parse(req.body ?? "{}") as OllamaChatRequest;
		chatRequests.push(body);
		const key = JSON.stringify(body.messages);
		const cached = seenPrompts.has(key);
		seenPrompts.add(key);

		// Prompt tokens the fake claims to have evaluated: everything on a cold
		// run, a single token on a cache hit — which is what a prefix match looks
		// like from the client's side.
		const promptChars = body.messages.reduce((sum, message) => sum + message.content.length, 0);
		const promptTokens = Math.ceil(promptChars / 4);
		const prefillMs = cached ? WARM_PREFILL_MS : COLD_PREFILL_MS;

		clock += prefillMs;
		yield `${JSON.stringify({ model: MODEL, message: { role: "assistant", content: "1" } })}\n`;
		clock += DECODE_MS;
		yield `${JSON.stringify({
			model: MODEL,
			message: { role: "assistant", content: "\n2" },
			done: true,
			done_reason: "length",
			prompt_eval_count: cached ? 1 : promptTokens,
			prompt_eval_duration: prefillMs * NS_PER_MS,
			eval_count: DECODE_TOKENS,
			eval_duration: DECODE_MS * NS_PER_MS,
			load_duration: 5 * NS_PER_MS,
			total_duration: (prefillMs + DECODE_MS) * NS_PER_MS,
		})}\n`;
	}

	async function request(req: HttpRequest): Promise<HttpResponse> {
		if (req.url.endsWith("/api/tags")) {
			if (options.failTagsWith) throw options.failTagsWith;
			return {
				status: 200,
				text: JSON.stringify({ models: installed.map((name) => ({ name })) }),
			};
		}
		if (req.url.endsWith("/api/show")) return { status: 200, text: SHOW_BODY };
		throw new Error(`unexpected buffered request to ${req.url}`);
	}

	let settings: MiseSettings = {
		...DEFAULT_SETTINGS,
		model: MODEL,
		fallbackToNonStreaming: false,
	};
	const client = new OllamaClient({
		transport: { request, stream },
		getSettings: () => settings,
	});

	const server: FakeServer = {
		chatRequests,
		psReads: 0,
		deps: {
			client,
			applySettings: (patch) => {
				settings = { ...settings, ...patch };
			},
			readPs: async () => {
				server.psReads += 1;
				return PS_RESPONSE;
			},
			readServerVersion: async () => "0.12.9",
			now: () => clock,
			nowIso: () => "2026-08-16T12:00:00.000Z",
			log: () => undefined,
			environment: ENVIRONMENT,
		},
	};
	return server;
}

function makeOptions(overrides: Partial<BenchOptions> = {}): BenchOptions {
	return {
		baseUrl: "http://127.0.0.1:11434",
		model: MODEL,
		contextSizes: [2048, 8192],
		numPredict: 128,
		keepAlive: "30m",
		outPath: null,
		jsonPath: null,
		...overrides,
	};
}

describe("runBenchmark", () => {
	it("measures every requested context size, twice each", async () => {
		const server = createFakeServer();
		const run = await runBenchmark(makeOptions(), server.deps);

		expect(run.cases.map((c) => c.numCtx)).toEqual([2048, 8192]);
		expect(server.chatRequests).toHaveLength(4);
		expect(server.psReads).toBe(2);
		expect(run.model).toBe(MODEL);
		expect(run.serverVersion).toBe("0.12.9");
	});

	it("sends the case's num_ctx explicitly on every request", async () => {
		const server = createFakeServer();
		await runBenchmark(makeOptions({ contextSizes: [2048, 8192, 16384] }), server.deps);
		expect(server.chatRequests.map((req) => req.options.num_ctx)).toEqual([
			2048, 2048, 8192, 8192, 16384, 16384,
		]);
		for (const req of server.chatRequests) {
			expect(req.options.num_predict).toBe(128);
			expect(req.keep_alive).toBe("30m");
			expect(req.stream).toBe(true);
			expect(req.model).toBe(MODEL);
		}
	});

	it("keeps prefill and decode apart, in the right units", async () => {
		const server = createFakeServer();
		const run = await runBenchmark(makeOptions({ contextSizes: [8192] }), server.deps);
		const only = run.cases[0];

		// Wall-clock TTFT is the fake's prefill delay, in milliseconds.
		expect(only?.cold.ttftMs).toBe(COLD_PREFILL_MS);
		// Server-reported prefill is the same span, converted out of nanoseconds.
		expect(only?.cold.prefillMs).toBe(COLD_PREFILL_MS);
		expect(only?.cold.decodeMs).toBe(DECODE_MS);
		expect(only?.cold.decodeTokensPerSecond).toBeCloseTo(
			DECODE_TOKENS / (DECODE_MS / 1000),
			6,
		);
		// Prefill evaluated thousands of tokens in 1.2 s; decode made 128 in 0.32 s.
		// If these were ever swapped the two rates would trade places.
		expect(only?.cold.prefillTokensPerSecond ?? 0).toBeGreaterThan(
			only?.cold.decodeTokensPerSecond ?? 0,
		);
		expect(only?.cold.wallMs).toBe(COLD_PREFILL_MS + DECODE_MS);
	});

	it("shows the prompt cache saving on the second identical run", async () => {
		const server = createFakeServer();
		const run = await runBenchmark(makeOptions({ contextSizes: [8192] }), server.deps);
		const only = run.cases[0];

		expect(only?.warm.ttftMs).toBe(WARM_PREFILL_MS);
		expect(only?.cache.ttftSavedMs).toBe(COLD_PREFILL_MS - WARM_PREFILL_MS);
		expect(only?.cache.warmPromptEvalCount).toBe(1);
		expect(only?.cache.reusedFraction ?? 0).toBeGreaterThan(0.99);
	});

	it("sends a byte-identical prompt for the warm run and a different one per size", async () => {
		const server = createFakeServer();
		await runBenchmark(makeOptions({ contextSizes: [2048, 8192] }), server.deps);
		const [coldSmall, warmSmall, coldLarge] = server.chatRequests;

		expect(JSON.stringify(warmSmall?.messages)).toBe(JSON.stringify(coldSmall?.messages));
		// Different sizes must not share a prefix, or the larger one's "cold" run
		// would be a cache hit and the whole row would be a lie.
		expect(coldLarge?.messages[0]?.content).not.toBe(coldSmall?.messages[0]?.content);
	});

	it("makes the cold run cold again on a second invocation", async () => {
		// The fake bills prefill by whether it has seen the exact prompt before,
		// which is what a 30-minute keep_alive does to a repeat `npm run bench`.
		// With a prompt deterministic in num_ctx alone, the second run's "cold"
		// row would be a cache hit: full prefill collapses to one token and the
		// table reports 0% prefix reused — the opposite of the truth.
		const server = createFakeServer();
		const first = await runBenchmark(makeOptions({ contextSizes: [8192] }), server.deps);
		const second = await runBenchmark(makeOptions({ contextSizes: [8192] }), {
			...server.deps,
			nowIso: () => "2026-08-16T12:30:00.000Z",
		});

		const [firstCold] = server.chatRequests;
		const secondCold = server.chatRequests[2];
		expect(JSON.stringify(secondCold?.messages)).not.toBe(JSON.stringify(firstCold?.messages));
		// Cold means cold: a full prefill both times, and a near-total reuse on the
		// warm run both times. The defect shows up as a second-run cold count of 1
		// and a reused fraction of 0.
		expect(first.cases[0]?.cache.coldPromptEvalCount ?? 0).toBeGreaterThan(1000);
		expect(second.cases[0]?.cache.coldPromptEvalCount ?? 0).toBeGreaterThan(1000);
		expect(second.cases[0]?.cache.reusedFraction ?? 0).toBeGreaterThan(0.99);
		// …while the pair inside the second run stays byte-identical, which is the
		// property the cache measurement itself rests on.
		expect(JSON.stringify(server.chatRequests[3]?.messages)).toBe(
			JSON.stringify(secondCold?.messages),
		);
	});

	it("pins the sampler so the decode column is reproducible between runs", async () => {
		const server = createFakeServer();
		await runBenchmark(makeOptions({ contextSizes: [2048, 8192] }), server.deps);
		expect(server.chatRequests).toHaveLength(4);
		for (const req of server.chatRequests) {
			expect(req.options.seed).toBe(BENCH_SEED);
			expect(req.options.temperature).toBe(BENCH_TEMPERATURE);
		}
	});

	it("sizes each prompt to its context window", async () => {
		const server = createFakeServer();
		const run = await runBenchmark(makeOptions({ contextSizes: [2048, 8192] }), server.deps);
		const [small, large] = run.cases;

		expect(small?.estimatedPromptTokens).toBeGreaterThanOrEqual(small?.promptTargetTokens ?? 0);
		expect(small?.estimatedPromptTokens ?? 0).toBeLessThan(2048);
		expect(large?.estimatedPromptTokens ?? 0).toBeGreaterThan(7000);
		expect(large?.estimatedPromptTokens ?? 0).toBeLessThan(8192);
	});

	it("records residency and model geometry", async () => {
		const server = createFakeServer();
		const run = await runBenchmark(makeOptions({ contextSizes: [8192] }), server.deps);
		expect(run.cases[0]?.residency?.processor).toBe("100% GPU");
		expect(run.cases[0]?.residency?.sizeBytes).toBe(12_000_000_000);
		expect(run.geometry?.layers).toBe(30);
		expect(run.geometry?.fullKvBytesPerToken).toBe(2 * 30 * 4 * 256 * 2);
	});

	it("survives a build with no /api/ps rather than failing the run", async () => {
		const server = createFakeServer();
		const run = await runBenchmark(makeOptions({ contextSizes: [8192] }), {
			...server.deps,
			readPs: async () => null,
		});
		expect(run.cases[0]?.residency).toBeNull();
		expect(run.cases[0]?.cold.ttftMs).toBe(COLD_PREFILL_MS);
	});

	it("fails loudly when the server is unreachable", async () => {
		const server = createFakeServer({ failTagsWith: new TypeError("fetch failed") });
		await expect(runBenchmark(makeOptions(), server.deps)).rejects.toBeInstanceOf(
			BenchmarkUnavailableError,
		);
		await expect(runBenchmark(makeOptions(), server.deps)).rejects.toThrow(
			/Could not reach Ollama.*Nothing was written/s,
		);
	});

	it("fails loudly when the model is not installed", async () => {
		const server = createFakeServer({ installedModels: ["llama3:8b"] });
		const error = await runBenchmark(makeOptions(), server.deps).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BenchmarkUnavailableError);
		expect(String(error)).toContain("ollama pull gemma4:e4b");
		expect(server.chatRequests).toHaveLength(0);
	});

	it("aborts the whole run when one measurement fails, rather than reporting a partial table", async () => {
		// Third chat call = the cold run of the second size.
		const server = createFakeServer({ failChatAt: 3 });
		const error = await runBenchmark(makeOptions(), server.deps).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BenchmarkMeasurementError);
		expect(String(error)).toMatch(/cold run at num_ctx 8192 failed/);
		expect(String(error)).toMatch(/No results were written/);
	});

	it("accepts a model named with an implicit :latest", async () => {
		const server = createFakeServer({ installedModels: [`${MODEL}:latest`] });
		const run = await runBenchmark(makeOptions({ contextSizes: [8192] }), server.deps);
		expect(run.cases).toHaveLength(1);
	});
});
