// Rendering: measurements in, `docs/benchmarks.md` out.
//
// Pure and total, including the "no results yet" case. The committed document
// and a populated one come out of the same code, so the structure a reader sees
// before the first run is exactly the structure the first run fills in — and a
// test asserts the committed file still matches `renderNotRunDocument()`, which
// is what keeps the placeholder from drifting away from the real output.
//
// One rule runs through all of it: a value we do not have renders as `n/a`,
// never as `0`. A zero in a committed table is indistinguishable from a
// measurement, and this file exists to make tuning evidence-based.

import { assessKvScaling, type KvGrowthPoint, type KvScalingAssessment } from "./kv";
import { formatCount, formatMs, formatPercent, formatRate } from "./metrics";
import { formatBytes } from "./ps";
import type { BenchCase, BenchmarkRun } from "./runner";

export const NOT_RUN_MARKER =
	"**Not yet run — no server was reachable when this landed.** No numbers below are real; " +
	"the tables are empty on purpose rather than filled with placeholders.";

const COMMAND = "npm run bench";

function renderTable(headers: readonly string[], rows: readonly string[][]): string {
	const lines = [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	];
	return lines.join("\n");
}

const PREFILL_HEADERS = [
	"num_ctx",
	"prompt tokens (est.)",
	"prompt_eval_count",
	"TTFT (wall)",
	"prefill (server)",
	"prefill rate",
	"decode rate",
	"tokens generated",
	"stop reason",
] as const;

const CACHE_HEADERS = [
	"num_ctx",
	"cold TTFT",
	"warm TTFT",
	"saved",
	"cold prompt_eval_count",
	"warm prompt_eval_count",
	"prefix reused",
] as const;

const MEMORY_HEADERS = [
	"num_ctx",
	"resident size",
	"in VRAM",
	"PROCESSOR",
	"bytes/context token vs 2k row",
] as const;

function prefillRow(benchCase: BenchCase): string[] {
	return [
		String(benchCase.numCtx),
		String(benchCase.estimatedPromptTokens),
		formatCount(benchCase.cold.promptEvalCount),
		formatMs(benchCase.cold.ttftMs),
		formatMs(benchCase.cold.prefillMs),
		formatRate(benchCase.cold.prefillTokensPerSecond),
		formatRate(benchCase.cold.decodeTokensPerSecond),
		formatCount(benchCase.cold.evalCount),
		benchCase.cold.doneReason ?? "n/a",
	];
}

function cacheRow(benchCase: BenchCase): string[] {
	return [
		String(benchCase.numCtx),
		formatMs(benchCase.cache.coldTtftMs),
		formatMs(benchCase.cache.warmTtftMs),
		formatMs(benchCase.cache.ttftSavedMs),
		formatCount(benchCase.cache.coldPromptEvalCount),
		formatCount(benchCase.cache.warmPromptEvalCount),
		formatPercent(benchCase.cache.reusedFraction),
	];
}

/**
 * Per-row incremental cost of context, taken against the smallest row rather
 * than against zero: resident size includes weights and compute buffers, which
 * do not grow with `num_ctx`, so only the difference between rows says anything
 * about the KV cache.
 */
function memoryRow(benchCase: BenchCase, baseline: BenchCase | undefined): string[] {
	const size = benchCase.residency?.sizeBytes ?? null;
	const baseSize = baseline?.residency?.sizeBytes ?? null;
	let perToken = "n/a";
	if (baseline !== undefined && baseline.numCtx !== benchCase.numCtx) {
		if (size !== null && baseSize !== null) {
			const bytes = (size - baseSize) / (benchCase.numCtx - baseline.numCtx);
			perToken = `${formatBytes(Math.abs(bytes))}${bytes < 0 ? " (negative)" : ""}`;
		}
	} else if (baseline !== undefined) {
		perToken = "baseline";
	}
	return [
		String(benchCase.numCtx),
		formatBytes(size),
		formatBytes(benchCase.residency?.sizeVramBytes ?? null),
		benchCase.residency?.processor ?? "not loaded",
		perToken,
	];
}

/** Things that make a row's numbers untrustworthy, said next to the numbers. */
export function collectWarnings(run: BenchmarkRun): string[] {
	const warnings: string[] = [];
	for (const benchCase of run.cases) {
		if (benchCase.truncationStatus === "truncated") {
			warnings.push(
				`num_ctx ${benchCase.numCtx}: the prompt was truncated, so that row measures a ` +
					`prompt of a different size than the label claims. ${benchCase.truncationMessage}`,
			);
		}
		if (!benchCase.streamed) {
			warnings.push(
				`num_ctx ${benchCase.numCtx}: the reply was buffered rather than streamed, so the ` +
					"TTFT column for that row is end-to-end latency, not time-to-first-token.",
			);
		}
		const gpu = benchCase.residency?.gpuPercent;
		if (typeof gpu === "number" && gpu < 100) {
			warnings.push(
				`num_ctx ${benchCase.numCtx}: only ${gpu}% of the model is on the GPU ` +
					`(${benchCase.residency?.processor}). Prefix cache reuse is reported broken on ` +
					"CPU-only backends (ollama#14780), so treat the cache row with suspicion.",
			);
		}
		if (benchCase.residency === null) {
			warnings.push(
				`num_ctx ${benchCase.numCtx}: /api/ps did not list the model, so no memory or ` +
					"processor figure could be taken for that row.",
			);
		}
		if (benchCase.cold.doneReason === "length") {
			warnings.push(
				`num_ctx ${benchCase.numCtx}: generation stopped at the num_predict cap, which is ` +
					"expected here — the decode rate is measured over exactly that many tokens.",
			);
		}
	}
	return warnings;
}

function growthPoints(run: BenchmarkRun): KvGrowthPoint[] {
	const points: KvGrowthPoint[] = [];
	for (const benchCase of run.cases) {
		const size = benchCase.residency?.sizeBytes;
		if (typeof size === "number") points.push({ numCtx: benchCase.numCtx, sizeBytes: size });
	}
	return points;
}

export function renderKvVerdict(assessment: KvScalingAssessment): string {
	const lines: string[] = [];
	const ratio = assessment.ratio === null ? "n/a" : assessment.ratio.toFixed(2);
	lines.push(`- Verdict: **${assessment.verdict}**`);
	lines.push(
		`- Measured growth: ${
			assessment.measuredBytesPerToken === null
				? "n/a"
				: `${formatBytes(assessment.measuredBytesPerToken)} per context token`
		}` +
			(assessment.fromNumCtx !== null && assessment.toNumCtx !== null
				? ` (between num_ctx ${assessment.fromNumCtx} and ${assessment.toNumCtx})`
				: ""),
	);
	lines.push(
		`- Untrimmed f16 KV cache would cost: ${
			assessment.theoreticalBytesPerToken === null
				? "n/a — model geometry unavailable"
				: `${formatBytes(assessment.theoreticalBytesPerToken)} per context token`
		}`,
	);
	lines.push(`- Ratio measured ÷ theoretical: ${ratio}`);
	lines.push(`- ${assessment.explanation}`);
	return lines.join("\n");
}

const HEADER = `# Benchmarks

Prefill and decode timings for the local model, measured on the machine that
runs the plugin. Regenerate this file with:

\`\`\`
ollama serve          # in another terminal, if it is not already running
${COMMAND}
\`\`\`

\`${COMMAND} -- --help\` lists the flags (base URL, model, sizes, \`--no-write\`).

## Why these numbers and not one number

The complaint this project started from is **prefill**: time-to-first-token on a
long prompt. Decode on a small local model is generally fine. A single blended
tokens/sec figure would average the problem away, so prefill and decode are
measured and reported separately, and time-to-first-token is taken from the
first streamed token rather than from the end of the call.

Two claims in \`plan.md\` are marked unverified and this file is what settles
them:

1. Whether the runtime actually trims the sliding-window part of the KV cache
   for this architecture — i.e. whether a large \`num_ctx\` is affordable. The
   memory table and the scaling verdict below answer it.
2. Whether KV cache quantisation is needed, and whether flash attention is
   active. The same slope bears on the first; the environment block records the
   second as far as a client can observe it.

Everything is measured through the plugin's own Ollama client — same
\`/api/chat\`, same explicit \`num_ctx\` — so these are the plugin's timings, not
a separate HTTP path's.`;

function section(title: string, body: string): string {
	return `## ${title}\n\n${body}`;
}

const PREFILL_NOTE =
	"`TTFT (wall)` is our stopwatch from request to first token and includes model load;\n" +
	"`prefill (server)` is Ollama's own `prompt_eval_duration`. They answer different\n" +
	"questions and are both here on purpose.";

const CACHE_NOTE =
	"Each prompt is sent twice, byte-identically. Ollama reuses the KV cache by longest\n" +
	"common prefix, so the second run should evaluate almost no prompt tokens. `saved` is\n" +
	"cold TTFT minus warm TTFT — the thing PR 4's stable-prefix ordering is buying.";

const MEMORY_NOTE =
	"Resident size and processor come from `/api/ps`, the same data `ollama ps` prints.\n" +
	"The last column is the marginal cost of context, taken against the smallest row,\n" +
	"because weights and compute buffers do not grow with `num_ctx`.";

/**
 * The committed placeholder: real structure, no numbers, and an explicit
 * statement that it has not been run. Deliberately not zero-filled.
 */
export function renderNotRunDocument(): string {
	return [
		HEADER,
		section("Status", NOT_RUN_MARKER),
		section(
			"Prefill and decode",
			`${renderTable(PREFILL_HEADERS, [])}\n\n${PREFILL_NOTE}`,
		),
		section("Prompt cache reuse", `${renderTable(CACHE_HEADERS, [])}\n\n${CACHE_NOTE}`),
		section("Memory and processor", `${renderTable(MEMORY_HEADERS, [])}\n\n${MEMORY_NOTE}`),
		section(
			"KV-cache scaling verdict",
			"Unanswered until the benchmark runs. It needs resident-size readings at two\n" +
				"different context sizes (8192 and 32768 are the interesting pair) and the model\n" +
				"geometry from `/api/show`.",
		),
		section("Environment", "Recorded when the benchmark runs."),
		"",
	].join("\n\n");
}

function environmentBlock(run: BenchmarkRun): string {
	const env = run.environment;
	const lines = [
		`- Host: ${env.hostname} (${env.platform}/${env.arch})`,
		`- Total memory: ${formatBytes(env.totalMemoryBytes)}`,
		`- Node: ${env.node}`,
		`- Ollama: ${run.serverVersion ?? "version not reported"} at ${run.baseUrl}`,
		`- Model: ${run.model}`,
		`- num_predict: ${run.numPredict}, keep_alive: ${run.keepAlive}`,
		`- Model geometry: ${
			run.geometry === null
				? "not reported by /api/show"
				: `${run.geometry.layers} layers, ${run.geometry.kvHeads} KV heads, head dim ${run.geometry.headDim}`
		}`,
		`- OLLAMA_FLASH_ATTENTION: ${env.flashAttention ?? "unset"}`,
		`- OLLAMA_KV_CACHE_TYPE: ${env.kvCacheType ?? "unset"}`,
		"",
		"The two environment variables are read from the process that ran the benchmark.",
		"They describe the server only if it was started from the same environment on the",
		"same machine — a server launched by a login agent may well see different values.",
	];
	return lines.join("\n");
}

/** The full report for a completed run. */
export function renderBenchmarkDocument(run: BenchmarkRun): string {
	const baseline = run.cases[0];
	const warnings = collectWarnings(run);
	const assessment = assessKvScaling(growthPoints(run), run.geometry);
	const status =
		`Run ${run.startedAt} against \`${run.model}\` at ${run.baseUrl} ` +
		`(${run.environment.platform}/${run.environment.arch}, ollama ${
			run.serverVersion ?? "version unknown"
		}). ${run.cases.length} context size${run.cases.length === 1 ? "" : "s"}, ` +
		`${formatMs(run.durationMs)} total.`;

	return [
		HEADER,
		section("Status", status),
		section(
			"Prefill and decode",
			`${renderTable(PREFILL_HEADERS, run.cases.map(prefillRow))}\n\n${PREFILL_NOTE}`,
		),
		section(
			"Prompt cache reuse",
			`${renderTable(CACHE_HEADERS, run.cases.map(cacheRow))}\n\n${CACHE_NOTE}`,
		),
		section(
			"Memory and processor",
			`${renderTable(
				MEMORY_HEADERS,
				run.cases.map((benchCase) => memoryRow(benchCase, baseline)),
			)}\n\n${MEMORY_NOTE}`,
		),
		section("KV-cache scaling verdict", renderKvVerdict(assessment)),
		section(
			"Warnings",
			warnings.length === 0
				? "None. Every row streamed, fit its context window, and ran with the model loaded."
				: warnings.map((warning) => `- ${warning}`).join("\n"),
		),
		section("Environment", environmentBlock(run)),
		"",
	].join("\n\n");
}
