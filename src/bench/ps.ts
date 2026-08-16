// Where the model is actually running, and how big it got.
//
// `ollama ps` prints NAME / ID / SIZE / PROCESSOR / UNTIL. We read the same
// facts from `/api/ps` instead of shelling out — it is the endpoint the CLI
// table is rendered from, it needs no `ollama` binary on PATH, and it goes
// through the transport we already have. This module is the rendering half:
// pure functions from the JSON to the two things the benchmark cares about.
//
// Why the benchmark cares:
//
//   - SIZE at 8K vs 32K num_ctx is the measurement that settles whether Ollama
//     implements the sliding-window KV-cache trim for this architecture. If
//     resident size grows in proportion to num_ctx, the trim is not active and
//     a large num_ctx is not affordable.
//   - PROCESSOR catches a silent CPU fallback. On a CPU-only backend prefix
//     cache reuse is reported broken outright (ollama#14780), which invalidates
//     the prompt-cache result on the same page — so it has to be visible.

/** One entry of `/api/ps`. Every field optional: older builds omit some. */
export interface OllamaPsModel {
	name?: string;
	model?: string;
	/** Total resident bytes: weights plus KV cache, across CPU and GPU. */
	size?: number;
	/** Of those bytes, how many live in VRAM. */
	size_vram?: number;
	expires_at?: string;
}

export interface OllamaPsResponse {
	models?: OllamaPsModel[];
}

export interface ModelResidency {
	name: string;
	/** Total resident bytes, or null when the server did not report it. */
	sizeBytes: number | null;
	/** Resident bytes in VRAM, or null. */
	sizeVramBytes: number | null;
	/** The PROCESSOR column, verbatim in `ollama ps`'s own wording. */
	processor: string;
	/** 0..100, or null when it cannot be computed. 100 means fully on GPU. */
	gpuPercent: number | null;
}

/**
 * Reproduce the PROCESSOR column exactly as the CLI computes it: 100% CPU when
 * nothing is in VRAM, 100% GPU when all of it is, otherwise the CPU/GPU split
 * rounded to whole percent. `Unknown` covers the shapes that cannot be a split
 * (no size reported, or more in VRAM than resident in total).
 */
export function describeProcessor(
	sizeBytes: number | null,
	sizeVramBytes: number | null,
): string {
	if (sizeBytes === null || sizeVramBytes === null || sizeBytes <= 0) return "unknown";
	if (sizeVramBytes <= 0) return "100% CPU";
	if (sizeVramBytes >= sizeBytes) return "100% GPU";
	const cpuPercent = Math.round(((sizeBytes - sizeVramBytes) / sizeBytes) * 100);
	return `${cpuPercent}%/${100 - cpuPercent}% CPU/GPU`;
}

/** 0..100, matching `describeProcessor`'s rounding, or null when unknown. */
export function gpuPercent(
	sizeBytes: number | null,
	sizeVramBytes: number | null,
): number | null {
	if (sizeBytes === null || sizeVramBytes === null || sizeBytes <= 0) return null;
	if (sizeVramBytes <= 0) return 0;
	if (sizeVramBytes >= sizeBytes) return 100;
	return 100 - Math.round(((sizeBytes - sizeVramBytes) / sizeBytes) * 100);
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Ollama answers `/api/tags` with bare names and `/api/ps` with whatever the
 * request used, so `gemma4:e4b` and `gemma4:e4b:latest` and a plain `gemma4`
 * can all refer to the same load. Compare on the name with an implicit
 * `:latest` normalised away rather than requiring an exact string match.
 */
export function matchesModel(a: string, b: string): boolean {
	const strip = (name: string): string => {
		const trimmed = name.trim().toLowerCase();
		return trimmed.endsWith(":latest") ? trimmed.slice(0, -":latest".length) : trimmed;
	};
	return strip(a) !== "" && strip(a) === strip(b);
}

/**
 * Pull the named model's residency out of an `/api/ps` body.
 *
 * Returns null when the model is not loaded — which is itself a result worth
 * printing, not an error: it means the run finished and the model was already
 * unloaded, so the memory column cannot be trusted for that row.
 */
export function readResidency(
	ps: OllamaPsResponse | null | undefined,
	model: string,
): ModelResidency | null {
	const models = ps?.models ?? [];
	for (const entry of models) {
		const candidates = [entry.name, entry.model].filter(
			(value): value is string => typeof value === "string",
		);
		if (!candidates.some((candidate) => matchesModel(candidate, model))) continue;
		const sizeBytes = finiteOrNull(entry.size);
		const sizeVramBytes = finiteOrNull(entry.size_vram);
		return {
			name: candidates[0] ?? model,
			sizeBytes,
			sizeVramBytes,
			processor: describeProcessor(sizeBytes, sizeVramBytes),
			gpuPercent: gpuPercent(sizeBytes, sizeVramBytes),
		};
	}
	return null;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Decimal-unit byte formatting, matching what `ollama ps` prints in its SIZE
 * column, so a number in our table can be compared with the CLI's by eye.
 */
export function formatBytes(bytes: number | null): string {
	if (bytes === null) return "n/a";
	if (bytes < 1000) return `${Math.round(bytes)} B`;
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
		value /= 1000;
		unit += 1;
	}
	return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
