import { describe, expect, it } from "vitest";

import type { OllamaShowResponse } from "../ollama/types";
import {
	LINEAR_RATIO_THRESHOLD,
	SUBLINEAR_RATIO_THRESHOLD,
	assessKvScaling,
	readKvGeometry,
	type KvGeometry,
} from "./kv";

/** `/api/show` shape: architecture-prefixed keys, as Ollama actually returns. */
const SHOW: OllamaShowResponse = {
	details: { family: "gemma4", parameter_size: "4.5B" },
	model_info: {
		"general.architecture": "gemma4",
		"gemma4.block_count": 30,
		"gemma4.embedding_length": 2048,
		"gemma4.attention.head_count": 8,
		"gemma4.attention.head_count_kv": 4,
		"gemma4.attention.key_length": 256,
		"gemma4.context_length": 131072,
	},
};

// 2 (K and V) × 30 layers × 4 KV heads × 256 head dim × 2 bytes (f16).
const FULL_KV_BYTES_PER_TOKEN = 2 * 30 * 4 * 256 * 2;

describe("readKvGeometry", () => {
	it("reads geometry through the architecture prefix", () => {
		const geometry = readKvGeometry(SHOW);
		expect(geometry).toEqual<KvGeometry>({
			layers: 30,
			kvHeads: 4,
			headDim: 256,
			fullKvBytesPerToken: FULL_KV_BYTES_PER_TOKEN,
		});
	});

	it("falls back to embedding_length / head_count when key_length is absent", () => {
		const info = { ...SHOW.model_info };
		delete info["gemma4.attention.key_length"];
		const geometry = readKvGeometry({ model_info: info });
		// 2048 / 8 = 256.
		expect(geometry?.headDim).toBe(256);
	});

	it("falls back to head_count when head_count_kv is absent", () => {
		const info = { ...SHOW.model_info };
		delete info["gemma4.attention.head_count_kv"];
		expect(readKvGeometry({ model_info: info })?.kvHeads).toBe(8);
	});

	it("returns null rather than a made-up denominator when metadata is missing", () => {
		expect(readKvGeometry({})).toBeNull();
		expect(readKvGeometry(null)).toBeNull();
		expect(readKvGeometry({ model_info: { "gemma4.block_count": 30 } })).toBeNull();
	});
});

const GEOMETRY = readKvGeometry(SHOW);

function pointsWithSlope(bytesPerToken: number) {
	return [
		{ numCtx: 8192, sizeBytes: 5_000_000_000 },
		{ numCtx: 32768, sizeBytes: 5_000_000_000 + (32768 - 8192) * bytesPerToken },
	];
}

describe("assessKvScaling", () => {
	it("calls growth at the untrimmed f16 cost linear", () => {
		const assessment = assessKvScaling(pointsWithSlope(FULL_KV_BYTES_PER_TOKEN), GEOMETRY);
		expect(assessment.verdict).toBe("linear");
		expect(assessment.measuredBytesPerToken).toBeCloseTo(FULL_KV_BYTES_PER_TOKEN, 6);
		expect(assessment.ratio).toBeCloseTo(1, 6);
		expect(assessment.fromNumCtx).toBe(8192);
		expect(assessment.toNumCtx).toBe(32768);
		expect(assessment.explanation).toMatch(/No sliding-window trim is visible/);
	});

	it("calls growth well under that cost sub-linear, and names the ambiguity", () => {
		const assessment = assessKvScaling(pointsWithSlope(FULL_KV_BYTES_PER_TOKEN * 0.2), GEOMETRY);
		expect(assessment.verdict).toBe("sub-linear");
		expect(assessment.ratio).toBeCloseTo(0.2, 6);
		// A sub-linear slope is equally consistent with KV quantisation, and the
		// report has to say so rather than crediting the trim.
		expect(assessment.explanation).toMatch(/OLLAMA_KV_CACHE_TYPE/);
	});

	it("refuses to call the middle either way", () => {
		const middle = (LINEAR_RATIO_THRESHOLD + SUBLINEAR_RATIO_THRESHOLD) / 2;
		const assessment = assessKvScaling(pointsWithSlope(FULL_KV_BYTES_PER_TOKEN * middle), GEOMETRY);
		expect(assessment.verdict).toBe("inconclusive");
	});

	it("does not invent a verdict from a single point", () => {
		const assessment = assessKvScaling([{ numCtx: 8192, sizeBytes: 5_000_000_000 }], GEOMETRY);
		expect(assessment.verdict).toBe("insufficient-data");
		expect(assessment.measuredBytesPerToken).toBeNull();
		expect(assessment.ratio).toBeNull();
	});

	it("reports the slope but no verdict when the model geometry is unknown", () => {
		const assessment = assessKvScaling(pointsWithSlope(FULL_KV_BYTES_PER_TOKEN), null);
		expect(assessment.verdict).toBe("no-geometry");
		expect(assessment.measuredBytesPerToken).toBeCloseTo(FULL_KV_BYTES_PER_TOKEN, 6);
		expect(assessment.ratio).toBeNull();
	});

	it("takes the slope between the smallest and largest context, whatever the input order", () => {
		const points = pointsWithSlope(FULL_KV_BYTES_PER_TOKEN);
		const forwards = assessKvScaling(points, GEOMETRY);
		const backwards = assessKvScaling([...points].reverse(), GEOMETRY);
		expect(backwards).toEqual(forwards);
		expect(backwards.measuredBytesPerToken).toBeGreaterThan(0);
	});
});
