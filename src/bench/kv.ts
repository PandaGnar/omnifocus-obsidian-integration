// KV-cache arithmetic: what the cache *would* cost if it were stored in full,
// so the measured growth has something to be compared against.
//
// This is the module that settles the plan's first unverified claim. Gemma 4
// interleaves 512-token local sliding-window attention with global attention
// 4:1, which should make the KV cache far cheaper than linear scaling in
// `num_ctx` — but only if the runtime actually trims the local layers. Both a
// trimmed and an untrimmed cache grow linearly in `num_ctx`, so a growth curve
// on its own cannot tell them apart. What distinguishes them is the *slope*
// compared with the model's own geometry: an untrimmed f16 cache costs
//
//     2 (K and V) × layers × kv_heads × head_dim × 2 bytes  per token
//
// and a trimmed one costs a fraction of that. So we read the geometry from
// `/api/show` and report the ratio of measured to theoretical.
//
// Everything here is pure arithmetic over the metadata `/api/show` returns.

import type { OllamaShowResponse } from "../ollama/types";

/** Bytes per element of the KV cache, by cache type. f16 is Ollama's default. */
export const F16_BYTES_PER_ELEMENT = 2;

export interface KvGeometry {
	layers: number;
	kvHeads: number;
	headDim: number;
	/** Bytes one token occupies in an untrimmed f16 KV cache, across all layers. */
	fullKvBytesPerToken: number;
}

/**
 * `model_info` keys are architecture-prefixed (`gemma4.block_count`,
 * `llama.block_count`, …), so match on the suffix rather than guessing the
 * architecture — the same approach `readContextLength` takes.
 */
function readSuffixed(
	info: Record<string, unknown> | undefined,
	suffix: string,
): number | null {
	if (!info) return null;
	for (const [key, value] of Object.entries(info)) {
		if (key === suffix || key.endsWith(`.${suffix}`)) {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
		}
	}
	return null;
}

/**
 * Derive KV geometry from `/api/show`. Returns null when the server did not
 * report enough to compute it — in which case the report says so instead of
 * inventing a denominator.
 *
 * `key_length` is used for the head dimension when present (Gemma reports it,
 * and it differs from embedding_length / head_count on this family); otherwise
 * we fall back to the usual embedding_length / head_count.
 */
export function readKvGeometry(show: OllamaShowResponse | null | undefined): KvGeometry | null {
	const info = show?.model_info;
	const layers = readSuffixed(info, "block_count");
	const kvHeads =
		readSuffixed(info, "attention.head_count_kv") ?? readSuffixed(info, "attention.head_count");
	if (layers === null || kvHeads === null) return null;

	const keyLength = readSuffixed(info, "attention.key_length");
	const embedding = readSuffixed(info, "embedding_length");
	const heads = readSuffixed(info, "attention.head_count");
	const headDim =
		keyLength ?? (embedding !== null && heads !== null ? embedding / heads : null);
	if (headDim === null || headDim <= 0) return null;

	return {
		layers,
		kvHeads,
		headDim,
		// ×2 for K and V, ×2 bytes for f16.
		fullKvBytesPerToken: 2 * layers * kvHeads * headDim * F16_BYTES_PER_ELEMENT,
	};
}

export interface KvGrowthPoint {
	numCtx: number;
	/** Total resident bytes reported by `/api/ps` at this `num_ctx`. */
	sizeBytes: number;
}

export type KvVerdict =
	| "linear"
	| "sub-linear"
	| "inconclusive"
	| "insufficient-data"
	| "no-geometry";

export interface KvScalingAssessment {
	verdict: KvVerdict;
	/** Measured extra resident bytes per extra context token, or null. */
	measuredBytesPerToken: number | null;
	/** What an untrimmed f16 cache would cost per token, or null if unknown. */
	theoreticalBytesPerToken: number | null;
	/** measured ÷ theoretical, or null. */
	ratio: number | null;
	/** The two points the slope was taken between, smallest and largest. */
	fromNumCtx: number | null;
	toNumCtx: number | null;
	/** Plain-English reading, including what the number does *not* prove. */
	explanation: string;
}

/**
 * A ratio at or above this reads as "the whole cache is being kept": within
 * measurement noise of the untrimmed f16 figure. Resident size also includes
 * weights and compute buffers, which do not grow with `num_ctx`, so the slope
 * is the only part of it that is being compared here.
 */
export const LINEAR_RATIO_THRESHOLD = 0.7;

/** At or below this, materially less than the full cache is being stored. */
export const SUBLINEAR_RATIO_THRESHOLD = 0.45;

/**
 * Compare measured resident-size growth against the untrimmed f16 cost.
 *
 * The deliberate limitation, stated in the output rather than hidden: a
 * sub-linear ratio is consistent with sliding-window trimming *and* with KV
 * quantisation, and this measurement cannot separate them. Checking
 * `OLLAMA_KV_CACHE_TYPE` on the server is what separates them, so the
 * explanation says to do that.
 */
export function assessKvScaling(
	points: readonly KvGrowthPoint[],
	geometry: KvGeometry | null,
): KvScalingAssessment {
	const sorted = [...points].sort((a, b) => a.numCtx - b.numCtx);
	const first = sorted[0];
	const last = sorted[sorted.length - 1];
	const theoretical = geometry?.fullKvBytesPerToken ?? null;

	if (sorted.length < 2 || first === undefined || last === undefined || last.numCtx === first.numCtx) {
		return {
			verdict: "insufficient-data",
			measuredBytesPerToken: null,
			theoreticalBytesPerToken: theoretical,
			ratio: null,
			fromNumCtx: first?.numCtx ?? null,
			toNumCtx: last?.numCtx ?? null,
			explanation:
				"Needs resident-size readings at two different context sizes. Run at least " +
				"two sizes (8192 and 32768 are the interesting pair) with the model loaded.",
		};
	}

	const measured = (last.sizeBytes - first.sizeBytes) / (last.numCtx - first.numCtx);
	const base = {
		measuredBytesPerToken: measured,
		theoreticalBytesPerToken: theoretical,
		fromNumCtx: first.numCtx,
		toNumCtx: last.numCtx,
	};

	if (theoretical === null || theoretical <= 0) {
		return {
			...base,
			verdict: "no-geometry",
			ratio: null,
			explanation:
				"/api/show did not report enough model geometry (block_count, head_count_kv, " +
				"key_length) to say what an untrimmed cache would cost, so the measured slope " +
				"below has nothing to be compared against. The slope itself is still real.",
		};
	}

	const ratio = measured / theoretical;
	if (ratio >= LINEAR_RATIO_THRESHOLD) {
		return {
			...base,
			verdict: "linear",
			ratio,
			explanation:
				"Resident memory grows at close to the cost of storing the whole KV cache in " +
				"f16. No sliding-window trim is visible: a large num_ctx is paid for in full, " +
				"so keep num_ctx close to what the context pack actually needs.",
		};
	}
	if (ratio <= SUBLINEAR_RATIO_THRESHOLD) {
		return {
			...base,
			verdict: "sub-linear",
			ratio,
			explanation:
				"Resident memory grows well below the untrimmed f16 cost, so something is " +
				"storing less than the full cache. That is consistent with sliding-window " +
				"trimming, and equally consistent with KV cache quantisation — this " +
				"measurement cannot tell them apart. Check OLLAMA_KV_CACHE_TYPE on the server " +
				"before crediting the trim.",
		};
	}
	return {
		...base,
		verdict: "inconclusive",
		ratio,
		explanation:
			"Growth sits between the untrimmed cost and a clearly trimmed one. Re-run with " +
			"the model freshly loaded and nothing else on the GPU; resident size includes " +
			"weights and compute buffers, and a busy device blurs the slope.",
	};
}
