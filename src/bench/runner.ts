// The measurement loop.
//
// It drives the plugin's own `OllamaClient` — same transport seam, same
// `/api/chat`, same explicit `num_ctx` — so what is timed here is what the
// plugin does, not a parallel HTTP path that could drift from it. Everything
// with a side effect (the clock, the network, the log) arrives through `deps`,
// which is what makes the whole loop testable offline against a fake transport.
//
// Two rules the shape of this file enforces:
//
//   - Prefill and decode are never blended. Each run yields a separate
//     time-to-first-token and a separate decode rate.
//   - A run that cannot be measured throws. There is no path that returns a
//     zero-filled row, because a zero in a committed table is indistinguishable
//     from a result.

import { OllamaClient } from "../ollama/client";
import type { OllamaChatMessage, OllamaShowResponse } from "../ollama/types";
import type { TruncationReport } from "../ollama/protocol";
import type { BenchOptions } from "./args";
import { promptTargetTokens } from "./args";
import { readKvGeometry, type KvGeometry } from "./kv";
import { cacheDelta, measureChat, type CacheDelta, type ChatMeasurement } from "./metrics";
import { buildBenchPrompt } from "./prompt";
import { matchesModel, readResidency, type ModelResidency, type OllamaPsResponse } from "./ps";

/**
 * No server, or no such model. Distinct from a measurement failure because the
 * fix is different — start Ollama, or pull the model — and because this is the
 * case the harness must never paper over with an empty table.
 */
export class BenchmarkUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchmarkUnavailableError";
	}
}

/** One case failed mid-run. The whole run is abandoned; nothing is written. */
export class BenchmarkMeasurementError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BenchmarkMeasurementError";
	}
}

export interface BenchCase {
	/** The `num_ctx` sent for this case, and the row label. */
	numCtx: number;
	label: string;
	/** Prompt size we aimed for, from `num_ctx` minus reply and headroom. */
	promptTargetTokens: number;
	/** Our chars/4 estimate of the prompt we built. */
	estimatedPromptTokens: number;
	/** First run of this prompt: nothing of it is in the KV cache yet. */
	cold: ChatMeasurement;
	/** Byte-identical repeat, so the whole prefix should be cache-reusable. */
	warm: ChatMeasurement;
	cache: CacheDelta;
	/** `/api/ps` immediately after the cold run, or null if the model was gone. */
	residency: ModelResidency | null;
	/** Truncation verdict for the cold run — a truncated prompt measures nothing. */
	truncationStatus: TruncationReport["status"];
	truncationMessage: string;
	/** False means the reply was buffered, so time-to-first-token is not real. */
	streamed: boolean;
}

export interface BenchEnvironment {
	node: string;
	platform: string;
	arch: string;
	/** Reported so a reader can tell whether the env vars below apply at all. */
	hostname: string;
	totalMemoryBytes: number | null;
	/**
	 * The tuning env vars *as seen by this process*. Only meaningful when the
	 * server runs on the same machine and inherited the same environment — the
	 * report says so rather than presenting them as server state.
	 */
	flashAttention: string | null;
	kvCacheType: string | null;
	/**
	 * The runtime allocates KV for `num_ctx × OLLAMA_NUM_PARALLEL`, so a server
	 * running the auto-selected value above 1 multiplies the very slope this
	 * benchmark measures and makes the measured ÷ theoretical ratio
	 * uninterpretable. Unrecorded, the KV verdict cannot be read at all.
	 */
	numParallel: string | null;
}

export interface BenchmarkRun {
	startedAt: string;
	durationMs: number;
	baseUrl: string;
	model: string;
	numPredict: number;
	keepAlive: string;
	serverVersion: string | null;
	geometry: KvGeometry | null;
	environment: BenchEnvironment;
	cases: BenchCase[];
}

/**
 * Fixed sampler settings, sent on every benchmark request.
 *
 * Decode throughput is measured over however many tokens the model chose to
 * generate under the `num_predict` cap. With sampling left to the server's
 * defaults, two runs of the identical prompt can stop at different lengths and
 * the decode column stops being comparable with itself — which is the one thing
 * a file that exists to be diffed against its own history has to be. A fixed
 * seed and a zero temperature pin it.
 */
export const BENCH_SEED = 1;
export const BENCH_TEMPERATURE = 0;

export interface BenchRunnerDeps {
	client: OllamaClient;
	/** Swap `num_ctx` and friends between cases; the client reads settings per call. */
	applySettings: (patch: {
		numCtx: number;
		numPredict: number;
		keepAlive: string;
		seed: number;
		temperature: number;
	}) => void;
	/** `/api/ps`, or null when the endpoint is unavailable on this build. */
	readPs: () => Promise<OllamaPsResponse | null>;
	/** `/api/version`, or null. Recorded so a result can be tied to a build. */
	readServerVersion: () => Promise<string | null>;
	now: () => number;
	nowIso: () => string;
	log: (line: string) => void;
	environment: BenchEnvironment;
}

interface SingleRun {
	measurement: ChatMeasurement;
	truncation: TruncationReport;
	streamed: boolean;
}

/**
 * One timed `/api/chat` call.
 *
 * Time-to-first-token is taken from the *first* streamed token, not from the
 * end of the call: that is the number the user feels on a long prompt, and it
 * is the one the plan's complaint is about. The server's own
 * `prompt_eval_duration` is recorded alongside it — they answer different
 * questions, since the wall-clock figure includes model load and queueing.
 */
async function runOnce(
	deps: BenchRunnerDeps,
	messages: OllamaChatMessage[],
): Promise<SingleRun> {
	const started = deps.now();
	let ttftMs: number | null = null;
	const result = await deps.client.chat(messages, {
		onToken: () => {
			if (ttftMs === null) ttftMs = deps.now() - started;
		},
	});
	const wallMs = deps.now() - started;
	return {
		measurement: measureChat({ final: result.final, wallMs, ttftMs }),
		truncation: result.truncation,
		streamed: result.streamed,
	};
}

async function readGeometry(client: OllamaClient, model: string): Promise<KvGeometry | null> {
	try {
		const show: OllamaShowResponse = await client.show(model);
		return readKvGeometry(show);
	} catch {
		// Older builds omit model_info. The run is still valid; the KV verdict
		// degrades to "measured slope, nothing to compare it against".
		return null;
	}
}

/**
 * Run the whole benchmark. Throws rather than returning a partial result.
 *
 * Per context size the loop runs the same prompt twice: once cold, then
 * byte-identically again. The second run is the prompt-cache measurement — with
 * the model still loaded, Ollama should match the whole prefix and prefill
 * almost nothing. Each size gets its own label baked into the first line of the
 * prompt, so a smaller size cannot warm the cache for a larger one and make its
 * "cold" run a lie — and the label carries this run's start time, so neither can
 * a previous invocation of the benchmark itself.
 */
export async function runBenchmark(
	options: BenchOptions,
	deps: BenchRunnerDeps,
): Promise<BenchmarkRun> {
	const startedAt = deps.nowIso();
	const startedMs = deps.now();

	let models: string[];
	try {
		models = await deps.client.listModels();
	} catch (error) {
		throw new BenchmarkUnavailableError(
			`Could not reach Ollama at ${options.baseUrl}: ${
				error instanceof Error ? error.message : String(error)
			}\nStart the server with \`ollama serve\` and try again. Nothing was written.`,
		);
	}
	if (!models.some((installed) => matchesModel(installed, options.model))) {
		throw new BenchmarkUnavailableError(
			`Model "${options.model}" is not installed on ${options.baseUrl}.\n` +
				`Run: ollama pull ${options.model}\n` +
				`Installed: ${models.length === 0 ? "(none)" : models.join(", ")}\n` +
				"Nothing was written.",
		);
	}

	const serverVersion = await deps.readServerVersion();
	const geometry = await readGeometry(deps.client, options.model);
	const cases: BenchCase[] = [];

	for (const numCtx of options.contextSizes) {
		// The run's own start time is mixed into the label — and so, through the
		// label, into the prompt — because otherwise a "cold" run is only cold the
		// first time anyone runs the benchmark. `keep_alive` is 30m by default, so
		// a second `npm run bench` inside that window sends a prompt the server
		// still has cached: cold TTFT collapses onto warm TTFT, and reusedFraction
		// becomes (1 − 1) / 1 = 0, reporting 0% prefix reuse — the exact opposite
		// of the truth, with nothing in the table to say so. Within a single run
		// both requests of a case still share one prompt object, which is the
		// byte-identity the cache measurement depends on.
		const label = `ctx-${numCtx}-${startedAt}`;
		const targetTokens = promptTargetTokens(numCtx, options.numPredict);
		const prompt = buildBenchPrompt({ label, targetTokens });
		deps.applySettings({
			numCtx,
			numPredict: options.numPredict,
			keepAlive: options.keepAlive,
			seed: BENCH_SEED,
			temperature: BENCH_TEMPERATURE,
		});

		deps.log(`num_ctx ${numCtx}: cold run (~${prompt.estimatedTokens} estimated tokens)…`);
		let cold: SingleRun;
		try {
			cold = await runOnce(deps, prompt.messages);
		} catch (error) {
			throw new BenchmarkMeasurementError(
				`The cold run at num_ctx ${numCtx} failed: ${
					error instanceof Error ? error.message : String(error)
				}\nNo results were written — a partial table would be worse than none.`,
				{ cause: error },
			);
		}

		// Read residency between the two runs: the model is certainly loaded now,
		// and the KV cache is sized for this num_ctx.
		const residency = readResidency(await deps.readPs(), options.model);

		deps.log(`num_ctx ${numCtx}: warm run (identical prompt, expecting a cache hit)…`);
		let warm: SingleRun;
		try {
			warm = await runOnce(deps, prompt.messages);
		} catch (error) {
			throw new BenchmarkMeasurementError(
				`The warm run at num_ctx ${numCtx} failed: ${
					error instanceof Error ? error.message : String(error)
				}\nNo results were written — a partial table would be worse than none.`,
				{ cause: error },
			);
		}

		cases.push({
			numCtx,
			label,
			promptTargetTokens: targetTokens,
			estimatedPromptTokens: prompt.estimatedTokens,
			cold: cold.measurement,
			warm: warm.measurement,
			cache: cacheDelta(cold.measurement, warm.measurement),
			residency,
			truncationStatus: cold.truncation.status,
			truncationMessage: cold.truncation.message,
			streamed: cold.streamed && warm.streamed,
		});
	}

	return {
		startedAt,
		durationMs: deps.now() - startedMs,
		baseUrl: options.baseUrl,
		model: options.model,
		numPredict: options.numPredict,
		keepAlive: options.keepAlive,
		serverVersion,
		geometry,
		environment: deps.environment,
		cases,
	};
}
