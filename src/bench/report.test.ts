import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NS_PER_MS, cacheDelta, measureChat } from "./metrics";
import { describeProcessor, gpuPercent } from "./ps";
import {
	NOT_RUN_MARKER,
	collectWarnings,
	renderBenchmarkDocument,
	renderNotRunDocument,
} from "./report";
import type { BenchCase, BenchmarkRun } from "./runner";

const BENCHMARKS_PATH = fileURLToPath(new URL("../../docs/benchmarks.md", import.meta.url));

function makeCase({
	numCtx,
	...overrides
}: Partial<BenchCase> & { numCtx: number }): BenchCase {
	const cold = measureChat({
		final: {
			done_reason: "length",
			prompt_eval_count: numCtx - 640,
			prompt_eval_duration: 1200 * NS_PER_MS,
			eval_count: 128,
			eval_duration: 320 * NS_PER_MS,
			// Every cold run reloads the model, because num_ctx changed for it.
			load_duration: 300 * NS_PER_MS,
		},
		wallMs: 1520,
		ttftMs: 1200,
	});
	const warm = measureChat({
		final: {
			done_reason: "length",
			prompt_eval_count: 1,
			prompt_eval_duration: 40 * NS_PER_MS,
			eval_count: 128,
			eval_duration: 320 * NS_PER_MS,
			// The warm run reloads nothing: that asymmetry is the whole problem.
			load_duration: 0,
		},
		wallMs: 360,
		ttftMs: 40,
	});
	const sizeBytes = 12_000_000_000;
	return {
		numCtx,
		label: `ctx-${numCtx}`,
		promptTargetTokens: numCtx - 640,
		estimatedPromptTokens: numCtx - 600,
		cold,
		warm,
		cache: cacheDelta(cold, warm),
		residency: {
			name: "gemma4:e4b",
			sizeBytes,
			sizeVramBytes: sizeBytes,
			processor: describeProcessor(sizeBytes, sizeBytes),
			gpuPercent: gpuPercent(sizeBytes, sizeBytes),
		},
		truncationStatus: "ok",
		truncationMessage: "Prompt fit.",
		streamed: true,
		...overrides,
	};
}

function makeRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
	return {
		startedAt: "2026-08-16T12:00:00.000Z",
		durationMs: 42_000,
		baseUrl: "http://127.0.0.1:11434",
		model: "gemma4:e4b",
		numPredict: 128,
		keepAlive: "30m",
		serverVersion: "0.12.9",
		geometry: { layers: 30, kvHeads: 4, headDim: 256, fullKvBytesPerToken: 122_880 },
		environment: {
			node: "v22.0.0",
			platform: "darwin",
			arch: "arm64",
			hostname: "test-host",
			totalMemoryBytes: 34_359_738_368,
			flashAttention: null,
			kvCacheType: null,
			numParallel: null,
		},
		cases: [makeCase({ numCtx: 8192 }), makeCase({ numCtx: 32768 })],
		...overrides,
	};
}

/** Body rows of the first markdown table that follows `heading`. */
function tableRows(document: string, heading: string): string[] {
	const section = document.split(`## ${heading}`)[1] ?? "";
	const lines = section.split("\n");
	const start = lines.findIndex((line) => line.startsWith("|"));
	if (start === -1) return [];
	const rows: string[] = [];
	// Skip the header line and the separator line.
	for (const line of lines.slice(start + 2)) {
		if (!line.startsWith("|")) break;
		rows.push(line);
	}
	return rows;
}

/**
 * Every shape a fabricated measurement takes in this report, so that a number
 * invented into the placeholder is caught wherever it is put.
 *
 * Bare integers are allowed and have to be: `num_ctx` sizes (8192, 32768) name
 * the intent of a run rather than reporting one. Everything else that could be
 * mistaken for a result is not — including the shapes the earlier regex let
 * through, which required a space before the unit and knew only GB and MB, so
 * `12GB`, `480 KB`, `7552 prompt tokens` and `98% reused` all passed it.
 */
const FABRICATION_PATTERNS: readonly RegExp[] = [
	// Any decimal at all: every measured quantity here renders with one.
	/\b\d+\.\d+\b/g,
	// Durations, with or without a space: `1.20 s`, `40.0 ms`, `900ms`.
	/\d+(\.\d+)?\s*(ns|µs|us|ms|s)\b/gi,
	// Rates.
	/\d+(\.\d+)?\s*(tok\/s|tokens?\/s|tps)\b/gi,
	// Sizes, binary or decimal, spaced or not: `12GB`, `480 KB`, `1.5 GiB`.
	/\d+(\.\d+)?\s*([KMGT]i?B|B)\b/g,
	// Percentages: `98% reused`, `100% GPU`.
	/\d+(\.\d+)?\s*%/g,
	// Bare counts of things the tables count.
	/\d+\s+(prompt |eval |generated |reused |context )?tokens?\b/gi,
	/\d+\s+(bytes|layers|heads)\b/gi,
];

/** Every fabricated-looking number in `text`, in the order they appear. */
function fabricatedMeasurements(text: string): string[] {
	const found: string[] = [];
	for (const pattern of FABRICATION_PATTERNS) {
		found.push(...(text.match(pattern) ?? []));
	}
	return found;
}

describe("fabricatedMeasurements", () => {
	// The guard is only worth what it catches, so what it catches is pinned
	// here rather than assumed. Each of these was planted in the placeholder and
	// survived the previous regex.
	it.each([
		"Resident size 12GB.",
		"KV 480 KB per token.",
		"Prefill evaluated 7552 prompt tokens.",
		"98% reused.",
		"| 8192 | 7552 | 1.20 s | 6293.3 tok/s |",
		"Model load took 900ms.",
		"Growth was 1.5 GiB across the pair.",
		"30 layers of it.",
	])("catches %j", (planted) => {
		expect(fabricatedMeasurements(planted)).not.toEqual([]);
	});

	it("leaves bare context sizes alone — they are intent, not measurement", () => {
		expect(
			fabricatedMeasurements("Run at num_ctx 8192 and 32768; see PR 4 and the 2k row."),
		).toEqual([]);
	});
});

describe("renderNotRunDocument", () => {
	const document = renderNotRunDocument();

	it("says plainly that it has not been run", () => {
		expect(document).toContain(NOT_RUN_MARKER);
		expect(document).toContain("Not yet run");
	});

	it("gives the exact command that populates it", () => {
		expect(document).toContain("npm run bench");
	});

	it("has the table structure but no rows — no placeholder numbers at all", () => {
		for (const heading of ["Prefill and decode", "Prompt cache reuse", "Memory and processor"]) {
			expect(document).toContain(`## ${heading}`);
			expect(tableRows(document, heading)).toEqual([]);
		}
	});

	it("contains no fabricated measurements", () => {
		expect(fabricatedMeasurements(document)).toEqual([]);
	});
});

describe("the committed docs/benchmarks.md", () => {
	const committed = readFileSync(BENCHMARKS_PATH, "utf8");

	it("is exactly what renderNotRunDocument produces", () => {
		// If this fails, either the renderer changed and the committed placeholder
		// was not regenerated, or someone hand-edited numbers into it.
		expect(committed).toBe(renderNotRunDocument());
	});

	// The three below deliberately never mention the renderer. Byte-identity
	// above catches a hand-edit only by way of a comparison to generated output;
	// if the renderer itself were ever taught to emit a number, that assertion
	// would go on passing. These read the committed bytes and nothing else.
	it("contains no fabricated measurements, judged on the file itself", () => {
		expect(fabricatedMeasurements(committed)).toEqual([]);
	});

	it("has empty tables — every heading, no body rows", () => {
		for (const heading of ["Prefill and decode", "Prompt cache reuse", "Memory and processor"]) {
			expect(committed).toContain(`## ${heading}`);
			expect(tableRows(committed, heading)).toEqual([]);
		}
	});

	it("says on its face that it has not been run", () => {
		expect(committed).toContain("Not yet run");
		expect(committed).toContain(NOT_RUN_MARKER);
	});
});

describe("renderBenchmarkDocument", () => {
	const document = renderBenchmarkDocument(makeRun());

	it("puts one row per context size in each table", () => {
		expect(tableRows(document, "Prefill and decode")).toHaveLength(2);
		expect(tableRows(document, "Prompt cache reuse")).toHaveLength(2);
		expect(tableRows(document, "Memory and processor")).toHaveLength(2);
	});

	it("reports prefill and decode as separate columns with separate numbers", () => {
		const row = tableRows(document, "Prefill and decode")[0] ?? "";
		expect(row).toContain("1.20 s"); // wall-clock TTFT
		expect(row).toContain("400.0 tok/s"); // decode: 128 tokens in 320 ms
		expect(row).toContain("6293.3 tok/s"); // prefill: 7552 tokens in 1200 ms
	});

	it("shows what the prompt cache saved", () => {
		const row = tableRows(document, "Prompt cache reuse")[0] ?? "";
		expect(row).toContain("1.20 s"); // cold TTFT
		expect(row).toContain("40.0 ms"); // warm TTFT
		expect(row).toContain("100%"); // prefix reused
	});

	it("charges model load to the model, not to the prompt cache", () => {
		// The fixture's cold run carries 300 ms of model load and its warm run
		// none, because changing num_ctx per case reloads the model before every
		// cold run. Raw cold − warm is 1160 ms; the cache is worth 860 ms of it,
		// and the load is printed rather than buried inside the saving.
		const row = tableRows(document, "Prompt cache reuse")[0] ?? "";
		expect(row).toContain("300.0 ms"); // cold model load, visible
		expect(row).toContain("860.0 ms"); // saving with the load taken out
		expect(row).not.toContain("1.16 s"); // the raw difference is not the saving
		expect(document).toContain("saved (load excluded)");
	});

	it("declines to state a saving when the server reported no load time", () => {
		const noLoad = measureChat({
			final: { prompt_eval_count: 8000, prompt_eval_duration: 1200 * NS_PER_MS },
			wallMs: 1520,
			ttftMs: 1200,
		});
		const warm = measureChat({ final: { load_duration: 0 }, wallMs: 360, ttftMs: 40 });
		const run = makeRun({
			cases: [makeCase({ numCtx: 8192, cold: noLoad, cache: cacheDelta(noLoad, warm) })],
		});
		const row = tableRows(renderBenchmarkDocument(run), "Prompt cache reuse")[0] ?? "";
		expect(row).toContain("n/a");
		expect(row).not.toContain("1.16 s");
	});

	it("marks the first memory row as the baseline and prices the rest against it", () => {
		const rows = tableRows(document, "Memory and processor");
		expect(rows[0]).toContain("baseline");
		expect(rows[0]).toContain("100% GPU");
		// Both rows report the same resident size here, so the marginal cost is 0 B.
		expect(rows[1]).toContain("0 B");
	});

	it("renders the KV verdict from the measured slope", () => {
		expect(document).toContain("## KV-cache scaling verdict");
		expect(document).toContain("Verdict: **sub-linear**");
	});

	it("records the environment, including the three tuning variables", () => {
		expect(document).toContain("OLLAMA_FLASH_ATTENTION: unset");
		expect(document).toContain("OLLAMA_KV_CACHE_TYPE: unset");
		// The runtime sizes the KV cache for num_ctx × parallel, so an unrecorded
		// value makes the slope above — the point of the whole run — unreadable.
		expect(document).toContain("OLLAMA_NUM_PARALLEL: unset");
		expect(document).toContain("ollama 0.12.9");
	});

	it("records a set OLLAMA_NUM_PARALLEL rather than reporting it as unset", () => {
		const run = makeRun({
			environment: { ...makeRun().environment, numParallel: "4" },
		});
		expect(renderBenchmarkDocument(run)).toContain("OLLAMA_NUM_PARALLEL: 4");
	});

	it("renders missing counters as n/a rather than zero", () => {
		const blank = measureChat({ final: null, wallMs: 100, ttftMs: null });
		const run = makeRun({
			cases: [makeCase({ numCtx: 8192, cold: blank, cache: cacheDelta(blank, blank) })],
		});
		const row = tableRows(renderBenchmarkDocument(run), "Prefill and decode")[0] ?? "";
		expect(row).toContain("n/a");
		expect(row).not.toMatch(/\|\s*0\.0 ms\s*\|/);
	});
});

describe("collectWarnings", () => {
	it("is quiet when every row is clean", () => {
		const clean = makeRun({
			cases: [
				makeCase({ numCtx: 8192, cold: measureChat({ final: {}, wallMs: 1, ttftMs: 1 }) }),
			],
		});
		expect(collectWarnings(clean)).toEqual([]);
	});

	it("flags a truncated prompt", () => {
		const run = makeRun({
			cases: [
				makeCase({
					numCtx: 8192,
					truncationStatus: "truncated",
					truncationMessage: "Prompt was truncated.",
				}),
			],
		});
		expect(collectWarnings(run).join("\n")).toMatch(/prompt was truncated/);
	});

	it("flags a CPU fallback, because it invalidates the cache row", () => {
		const run = makeRun({
			cases: [
				makeCase({
					numCtx: 8192,
					residency: {
						name: "gemma4:e4b",
						sizeBytes: 10_000,
						sizeVramBytes: 3_000,
						processor: describeProcessor(10_000, 3_000),
						gpuPercent: gpuPercent(10_000, 3_000),
					},
				}),
			],
		});
		expect(collectWarnings(run).join("\n")).toMatch(/30% of the model is on the GPU/);
		expect(collectWarnings(run).join("\n")).toMatch(/14780/);
	});

	it("flags a buffered reply, whose TTFT column is not a TTFT", () => {
		const run = makeRun({ cases: [makeCase({ numCtx: 8192, streamed: false })] });
		expect(collectWarnings(run).join("\n")).toMatch(/buffered rather than streamed/);
	});

	it("flags a row with no residency reading", () => {
		const run = makeRun({ cases: [makeCase({ numCtx: 8192, residency: null })] });
		expect(collectWarnings(run).join("\n")).toMatch(/did not list the model/);
	});
});
