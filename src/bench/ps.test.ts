import { describe, expect, it } from "vitest";

import {
	describeProcessor,
	formatBytes,
	gpuPercent,
	matchesModel,
	readResidency,
	type OllamaPsResponse,
} from "./ps";

/** Recorded shape of `/api/ps` with one model fully resident in VRAM. */
const PS_GPU: OllamaPsResponse = {
	models: [
		{
			name: "gemma4:e4b",
			model: "gemma4:e4b",
			size: 11_453_246_464,
			size_vram: 11_453_246_464,
			expires_at: "2026-08-16T18:30:00Z",
		},
	],
};

/** Partially offloaded: some of the model spilled to system memory. */
const PS_SPLIT: OllamaPsResponse = {
	models: [
		{ name: "gemma4:e4b", model: "gemma4:e4b", size: 10_000_000_000, size_vram: 7_000_000_000 },
	],
};

describe("describeProcessor", () => {
	it("matches the CLI's wording for the three clean cases", () => {
		expect(describeProcessor(10_000, 0)).toBe("100% CPU");
		expect(describeProcessor(10_000, 10_000)).toBe("100% GPU");
		expect(describeProcessor(10_000, 3_000)).toBe("70%/30% CPU/GPU");
	});

	it("reports unknown rather than guessing when the numbers make no sense", () => {
		expect(describeProcessor(null, 5)).toBe("unknown");
		expect(describeProcessor(0, 0)).toBe("unknown");
		expect(describeProcessor(10, null)).toBe("unknown");
	});

	it("treats more-in-VRAM-than-resident as fully on GPU rather than a negative split", () => {
		expect(describeProcessor(1000, 1200)).toBe("100% GPU");
	});
});

describe("gpuPercent", () => {
	it("agrees with the processor string", () => {
		expect(gpuPercent(10_000, 0)).toBe(0);
		expect(gpuPercent(10_000, 10_000)).toBe(100);
		expect(gpuPercent(10_000, 3_000)).toBe(30);
		expect(gpuPercent(null, null)).toBeNull();
	});
});

describe("matchesModel", () => {
	it("ignores an implicit :latest and case", () => {
		expect(matchesModel("gemma4:e4b", "gemma4:e4b")).toBe(true);
		expect(matchesModel("gemma4:e4b:latest", "gemma4:e4b")).toBe(true);
		expect(matchesModel("Gemma4:E4B", "gemma4:e4b")).toBe(true);
	});

	it("does not match a different tag", () => {
		expect(matchesModel("gemma4:e2b", "gemma4:e4b")).toBe(false);
		expect(matchesModel("", "gemma4:e4b")).toBe(false);
	});
});

describe("readResidency", () => {
	it("reads size, VRAM and processor for a fully-offloaded model", () => {
		const residency = readResidency(PS_GPU, "gemma4:e4b");
		expect(residency).not.toBeNull();
		expect(residency?.sizeBytes).toBe(11_453_246_464);
		expect(residency?.sizeVramBytes).toBe(11_453_246_464);
		expect(residency?.processor).toBe("100% GPU");
		expect(residency?.gpuPercent).toBe(100);
	});

	it("surfaces a partial offload rather than rounding it to GPU", () => {
		const residency = readResidency(PS_SPLIT, "gemma4:e4b");
		expect(residency?.processor).toBe("30%/70% CPU/GPU");
		expect(residency?.gpuPercent).toBe(70);
	});

	it("returns null when the model is not loaded", () => {
		expect(readResidency(PS_GPU, "gemma4:e2b")).toBeNull();
		expect(readResidency({ models: [] }, "gemma4:e4b")).toBeNull();
		expect(readResidency(null, "gemma4:e4b")).toBeNull();
	});

	it("degrades to nulls when the server omitted the sizes", () => {
		const residency = readResidency({ models: [{ name: "gemma4:e4b" }] }, "gemma4:e4b");
		expect(residency?.sizeBytes).toBeNull();
		expect(residency?.processor).toBe("unknown");
	});
});

describe("formatBytes", () => {
	it("uses decimal units, as ollama ps does", () => {
		expect(formatBytes(11_453_246_464)).toBe("11.5 GB");
		expect(formatBytes(1_500_000)).toBe("1.5 MB");
		expect(formatBytes(999)).toBe("999 B");
	});

	it("renders a missing size as n/a", () => {
		expect(formatBytes(null)).toBe("n/a");
	});
});
