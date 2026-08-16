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
		// Nothing in the placeholder may look like a timing or a rate.
		expect(document).not.toMatch(/\d+(\.\d+)?\s?(ms|tok\/s)\b/);
		expect(document).not.toMatch(/\d+(\.\d+)?\s(GB|MB)\b/);
	});
});

describe("the committed docs/benchmarks.md", () => {
	it("is exactly what renderNotRunDocument produces", () => {
		// If this fails, either the renderer changed and the committed placeholder
		// was not regenerated, or someone hand-edited numbers into it.
		expect(readFileSync(BENCHMARKS_PATH, "utf8")).toBe(renderNotRunDocument());
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
		expect(row).toContain("1.16 s"); // saved
		expect(row).toContain("100%"); // prefix reused
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

	it("records the environment, including the two tuning variables", () => {
		expect(document).toContain("OLLAMA_FLASH_ATTENTION: unset");
		expect(document).toContain("OLLAMA_KV_CACHE_TYPE: unset");
		expect(document).toContain("ollama 0.12.9");
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
