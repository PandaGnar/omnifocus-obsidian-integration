import { describe, expect, it } from "vitest";

import type { OllamaShowResponse } from "../ollama/types";
import {
	LINEAR_RATIO_THRESHOLD,
	SUBLINEAR_RATIO_THRESHOLD,
	assessKvScaling,
	readKvGeometry,
	type KvGeometry,
} from "./kv";

/**
 * `/api/show` shape: architecture-prefixed keys, as Ollama actually returns.
 *
 * `embedding_length / head_count` deliberately does *not* equal `key_length`
 * here (2560 / 8 = 320 against a key_length of 256), and `head_count` does not
 * equal `head_count_kv`. The earlier fixture had the first pair coincide, which
 * made substituting that field look free — when substituting it is precisely
 * the mistake that inverts the verdict. These numbers have to disagree for the
 * tests below to be able to tell the difference.
 */
const SHOW: OllamaShowResponse = {
	details: { family: "gemma4", parameter_size: "4.5B" },
	model_info: {
		"general.architecture": "gemma4",
		"gemma4.block_count": 30,
		"gemma4.embedding_length": 2560,
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

	it("refuses to substitute embedding_length / head_count for a missing key_length", () => {
		// Head dimension is decoupled from hidden ÷ heads on this family, so the
		// textbook identity is wrong here by 320 against 256 — and wrong silently,
		// because the only symptom is a verdict word that looks like a real one.
		const info = { ...SHOW.model_info };
		delete info["gemma4.attention.key_length"];
		expect(readKvGeometry({ model_info: info })).toBeNull();
	});

	it("refuses to substitute head_count for a missing head_count_kv", () => {
		// That substitution throws away what GQA is: at this model's 4:1 ratio it
		// inflates the denominator fourfold and deflates the ratio by the same
		// factor, which is enough to turn an untrimmed cache into "sub-linear".
		const info = { ...SHOW.model_info };
		delete info["gemma4.attention.head_count_kv"];
		expect(readKvGeometry({ model_info: info })).toBeNull();
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

	it("names the quantisation ambiguity in the inconclusive band too", () => {
		// An untrimmed q8_0 cache costs about half the f16 figure, which lands
		// here rather than in sub-linear. This is the verdict where a reader most
		// needs to be told that quantisation would explain what they are seeing.
		const assessment = assessKvScaling(pointsWithSlope(FULL_KV_BYTES_PER_TOKEN * 0.5), GEOMETRY);
		expect(assessment.verdict).toBe("inconclusive");
		expect(assessment.explanation).toMatch(/OLLAMA_KV_CACHE_TYPE/);
	});

	it("degrades a partial metadata mismatch to no-geometry rather than a wrong verdict", () => {
		// The failure this pins down: with head_count substituted for
		// head_count_kv, this slope — exactly the untrimmed f16 cost — comes back
		// as a confident "sub-linear", and nothing in the report says why.
		const info = { ...SHOW.model_info };
		delete info["gemma4.attention.head_count_kv"];
		const assessment = assessKvScaling(
			pointsWithSlope(FULL_KV_BYTES_PER_TOKEN),
			readKvGeometry({ model_info: info }),
		);
		expect(assessment.verdict).toBe("no-geometry");
		expect(assessment.ratio).toBeNull();
		expect(assessment.theoreticalBytesPerToken).toBeNull();
		expect(assessment.measuredBytesPerToken).toBeCloseTo(FULL_KV_BYTES_PER_TOKEN, 6);
	});

	it("takes the slope between the smallest and largest context, whatever the input order", () => {
		const points = pointsWithSlope(FULL_KV_BYTES_PER_TOKEN);
		const forwards = assessKvScaling(points, GEOMETRY);
		const backwards = assessKvScaling([...points].reverse(), GEOMETRY);
		expect(backwards).toEqual(forwards);
		expect(backwards.measuredBytesPerToken).toBeGreaterThan(0);
	});
});
