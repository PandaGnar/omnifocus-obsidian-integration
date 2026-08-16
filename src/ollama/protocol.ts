// Pure protocol logic: URL building, request-body construction, NDJSON stream
// decoding, truncation detection and report formatting. No `obsidian` import,
// no network, no timers — every function here is directly unit-testable.

import type {
	OllamaChatMessage,
	OllamaChatRequest,
	OllamaChatResponse,
	OllamaShowResponse,
	OllamaTagsModel,
	OllamaTagsResponse,
} from "./types";

/**
 * We speak `/api/chat`, never `/v1/chat/completions`. The OpenAI-compat shim
 * has a Gemma 4 streaming bug where the text arrives in `reasoning` and
 * `content` stays empty (ollama#15368). The native endpoint is unaffected.
 */
export const CHAT_PATH = "/api/chat";
export const TAGS_PATH = "/api/tags";
export const SHOW_PATH = "/api/show";

/** Trailing segments a user is likely to paste in and not mean. */
const REDUNDANT_SUFFIXES = ["/api/chat", "/api/tags", "/api/show", "/api", "/v1"];

/**
 * Normalise a user-typed base URL into something `endpointUrl` can extend:
 * add a scheme if missing, drop trailing slashes, and strip an API path the
 * user pasted from Ollama's docs (otherwise we'd build `/api/api/chat`).
 */
export function normalizeBaseUrl(raw: string): string {
	let url = raw.trim();
	if (url === "") return "";
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
	url = url.replace(/\/+$/, "");
	for (const suffix of REDUNDANT_SUFFIXES) {
		if (url.toLowerCase().endsWith(suffix)) {
			url = url.slice(0, -suffix.length).replace(/\/+$/, "");
			break;
		}
	}
	return url;
}

/** Join a normalised base URL with an absolute API path. */
export function endpointUrl(baseUrl: string, path: string): string {
	const base = normalizeBaseUrl(baseUrl);
	if (base === "") throw new Error("Ollama base URL is empty.");
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface BuildChatRequestParams {
	model: string;
	messages: OllamaChatMessage[];
	stream: boolean;
	numCtx: number;
	numPredict: number;
	keepAlive: string | number;
}

/**
 * Build an `/api/chat` body.
 *
 * `num_ctx` is always sent explicitly. Four official Ollama sources currently
 * disagree about the server-side default (`envconfig` auto-sizes by VRAM,
 * `context-length.mdx` gives tiers, the FAQ says 4096, `modelfile.mdx` says
 * 2048), and an under-sized context silently drops the *oldest* tokens — which
 * for this plugin is exactly the stable goal docs at the top of the prompt.
 * `num_predict` is sent because Ollama's default is unbounded, and
 * `keep_alive` because a model unload throws away the prompt cache.
 */
export function buildChatRequest(params: BuildChatRequestParams): OllamaChatRequest {
	const model = params.model.trim();
	if (model === "") throw new Error("No Ollama model is configured.");
	if (params.messages.length === 0) {
		throw new Error("Refusing to send a chat request with no messages.");
	}
	return {
		model,
		messages: params.messages,
		stream: params.stream,
		keep_alive: params.keepAlive,
		options: {
			num_ctx: params.numCtx,
			num_predict: params.numPredict,
		},
	};
}

// ---------------------------------------------------------------------------
// NDJSON stream decoding
// ---------------------------------------------------------------------------

export interface NdjsonSplit {
	lines: string[];
	/** Whatever followed the last newline — an incomplete line, kept for next time. */
	rest: string;
}

/**
 * Split a buffer into complete lines plus a remainder. Chunk boundaries from
 * the network land wherever they like, including mid-token and mid-line, so
 * the remainder has to survive to the next chunk.
 */
export function splitNdjson(buffer: string): NdjsonSplit {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	const lines: string[] = [];
	for (const part of parts) {
		// Tolerate CRLF: some proxies rewrite line endings.
		const line = part.endsWith("\r") ? part.slice(0, -1) : part;
		if (line.trim() !== "") lines.push(line);
	}
	return { lines, rest };
}

export type StreamEvent =
	| { kind: "chunk"; value: OllamaChatResponse }
	| { kind: "error"; message: string };

/** True when `value` is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode one NDJSON line. Returns null for lines we should ignore (blank, or
 * an SSE-style `data:` prefix if a proxy ever adds one) and an `error` event
 * for both Ollama-reported errors and unparseable JSON.
 */
export function parseStreamLine(rawLine: string): StreamEvent | null {
	let line = rawLine.trim();
	if (line === "") return null;
	if (line.startsWith("data:")) line = line.slice(5).trim();
	if (line === "" || line === "[DONE]") return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return {
			kind: "error",
			message: `Ollama sent a line that is not JSON: ${truncateForMessage(line)}`,
		};
	}
	if (!isRecord(parsed)) {
		return {
			kind: "error",
			message: `Expected a JSON object from Ollama, got ${typeof parsed}.`,
		};
	}
	if (typeof parsed["error"] === "string") {
		return { kind: "error", message: parsed["error"] };
	}
	// The shape is validated by the fields we actually read (`message.content`,
	// `done`, the counters); anything else passes through untouched.
	return { kind: "chunk", value: parsed as OllamaChatResponse };
}

function truncateForMessage(text: string): string {
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * Stateful NDJSON decoder. Feed it whatever the network hands you; it emits
 * only complete, parsed lines and holds the partial tail until it completes.
 */
export class NdjsonDecoder {
	private buffer = "";

	push(chunk: string): StreamEvent[] {
		this.buffer += chunk;
		const { lines, rest } = splitNdjson(this.buffer);
		this.buffer = rest;
		return collectEvents(lines);
	}

	/** Emit a final unterminated line, if the server ended without a newline. */
	flush(): StreamEvent[] {
		const tail = this.buffer;
		this.buffer = "";
		return collectEvents([tail]);
	}
}

function collectEvents(lines: string[]): StreamEvent[] {
	const events: StreamEvent[] = [];
	for (const line of lines) {
		const event = parseStreamLine(line);
		if (event) events.push(event);
	}
	return events;
}

/** Pull the text out of a chat frame; frames without text are common. */
export function chunkText(chunk: OllamaChatResponse): string {
	return chunk.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Token accounting and truncation detection
// ---------------------------------------------------------------------------

/** Per-message framing (role markers, turn delimiters) we can't see from here. */
const MESSAGE_OVERHEAD_TOKENS = 4;
const CHARS_PER_TOKEN = 4;

/**
 * Rough token count. Ollama exposes no tokeniser over HTTP, so this is the
 * usual chars/4 heuristic — good to roughly ±20% on English prose, and used
 * only for warnings, never to decide what to send. The authoritative number is
 * `prompt_eval_count` on the response.
 */
export function estimateTokens(text: string): number {
	if (text === "") return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimatePromptTokens(messages: OllamaChatMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
	}
	return total;
}

export type BudgetStatus = "ok" | "tight" | "over";

export interface PromptBudget {
	status: BudgetStatus;
	estimatedPromptTokens: number;
	/** Tokens left for the reply once the prompt is in: `num_ctx - prompt`. */
	headroomTokens: number;
	numCtx: number;
	numPredict: number;
	message: string;
}

/**
 * Pre-flight check, run before a request goes out. The prompt and the reply
 * share `num_ctx`, so a prompt that leaves less than `num_predict` of room is
 * already in trouble even though it fits.
 */
export function assessPromptBudget(params: {
	estimatedPromptTokens: number;
	numCtx: number;
	numPredict: number;
}): PromptBudget {
	const { estimatedPromptTokens, numCtx, numPredict } = params;
	const headroomTokens = numCtx - estimatedPromptTokens;
	if (headroomTokens <= 0) {
		return {
			status: "over",
			estimatedPromptTokens,
			headroomTokens,
			numCtx,
			numPredict,
			message:
				`Prompt is about ${estimatedPromptTokens} tokens but num_ctx is ${numCtx}. ` +
				"Ollama will silently drop the oldest tokens. Raise num_ctx or send less.",
		};
	}
	if (headroomTokens < numPredict) {
		return {
			status: "tight",
			estimatedPromptTokens,
			headroomTokens,
			numCtx,
			numPredict,
			message:
				`Prompt is about ${estimatedPromptTokens} tokens, leaving ${headroomTokens} of ` +
				`${numCtx} for a reply capped at ${numPredict}. The reply may be cut short.`,
		};
	}
	return {
		status: "ok",
		estimatedPromptTokens,
		headroomTokens,
		numCtx,
		numPredict,
		message: `Prompt is about ${estimatedPromptTokens} tokens; ${headroomTokens} of ${numCtx} free.`,
	};
}

export type TruncationStatus = "ok" | "truncated" | "unknown";

export interface TruncationReport {
	status: TruncationStatus;
	promptEvalCount: number | null;
	numCtx: number;
	estimatedPromptTokens: number | null;
	/** Best guess at how many tokens fell off the front, when we can tell. */
	estimatedDroppedTokens: number | null;
	message: string;
}

/**
 * Post-hoc truncation check against the final chat frame.
 *
 * When a prompt exceeds `num_ctx` the runtime keeps the newest tokens and
 * discards the oldest with no error and no warning — decapitating exactly the
 * stable goal docs we deliberately put at the top. The tell is
 * `prompt_eval_count` coming back pinned at the context window.
 *
 * Note the asymmetry: `prompt_eval_count` counts tokens the server actually
 * *evaluated*, so a prompt-cache prefix hit makes it far smaller than what we
 * sent. A low count is therefore not evidence of anything, which is why only
 * the pinned-at-`num_ctx` case is treated as conclusive.
 */
export function detectTruncation(params: {
	promptEvalCount: number | null | undefined;
	numCtx: number;
	estimatedPromptTokens?: number | null;
}): TruncationReport {
	const { numCtx } = params;
	const estimated =
		typeof params.estimatedPromptTokens === "number" &&
		Number.isFinite(params.estimatedPromptTokens)
			? params.estimatedPromptTokens
			: null;
	const count =
		typeof params.promptEvalCount === "number" &&
		Number.isFinite(params.promptEvalCount)
			? params.promptEvalCount
			: null;

	if (count === null) {
		return {
			status: "unknown",
			promptEvalCount: null,
			numCtx,
			estimatedPromptTokens: estimated,
			estimatedDroppedTokens: null,
			message:
				"Ollama returned no prompt_eval_count, so truncation could not be checked.",
		};
	}

	if (count >= numCtx) {
		const dropped = estimated !== null ? Math.max(estimated - numCtx, 0) : null;
		const droppedNote =
			dropped !== null && dropped > 0
				? ` About ${dropped} tokens were dropped from the start of the prompt.`
				: "";
		return {
			status: "truncated",
			promptEvalCount: count,
			numCtx,
			estimatedPromptTokens: estimated,
			estimatedDroppedTokens: dropped,
			message:
				`Prompt was truncated: Ollama evaluated ${count} tokens against a ` +
				`num_ctx of ${numCtx}.${droppedNote} The oldest content was discarded silently.`,
		};
	}

	return {
		status: "ok",
		promptEvalCount: count,
		numCtx,
		estimatedPromptTokens: estimated,
		estimatedDroppedTokens: null,
		message: `Prompt fit: ${count} of ${numCtx} context tokens evaluated.`,
	};
}

// ---------------------------------------------------------------------------
// Response readers and formatting
// ---------------------------------------------------------------------------

/** Model names from `/api/tags`, de-duplicated and sorted for a stable dropdown. */
export function readModelNames(tags: OllamaTagsResponse): string[] {
	const models: OllamaTagsModel[] = tags.models ?? [];
	const names = new Set<string>();
	for (const model of models) {
		const name = typeof model?.name === "string" ? model.name.trim() : "";
		if (name !== "") names.add(name);
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The model's own maximum context, from `/api/show`. The key is
 * architecture-prefixed (`gemma4.context_length`, `llama.context_length`, ...)
 * so match on the suffix rather than guessing the architecture.
 */
export function readContextLength(show: OllamaShowResponse): number | null {
	const info = show.model_info;
	if (!info) return null;
	for (const [key, value] of Object.entries(info)) {
		if (key === "context_length" || key.endsWith(".context_length")) {
			if (typeof value === "number" && Number.isFinite(value)) return value;
		}
	}
	return null;
}

/** Human-readable elapsed time: milliseconds under a second, seconds above. */
export function formatLatency(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "unknown";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

export interface ConnectionReport {
	ok: boolean;
	latencyMs: number;
	baseUrl: string;
	models: string[];
	selectedModel: string;
	/** Present when `/api/show` answered for the selected model. */
	modelContextLength?: number | null;
	configuredNumCtx: number;
	error?: string;
}

/** One-line-per-fact summary for the Test connection button and the notice. */
export function formatConnectionReport(report: ConnectionReport): string {
	if (!report.ok) {
		return `Could not reach Ollama at ${report.baseUrl}: ${report.error ?? "unknown error"}`;
	}
	const lines = [
		`Connected to ${report.baseUrl} in ${formatLatency(report.latencyMs)}.`,
		`${report.models.length} model${report.models.length === 1 ? "" : "s"} installed.`,
	];
	if (report.selectedModel === "") {
		lines.push("No model selected yet — pick one below.");
	} else if (!report.models.includes(report.selectedModel)) {
		lines.push(
			`Selected model "${report.selectedModel}" is not installed. Run: ollama pull ${report.selectedModel}`,
		);
	} else {
		lines.push(`Selected model: ${report.selectedModel}.`);
	}
	const max = report.modelContextLength;
	if (typeof max === "number") {
		lines.push(
			max < report.configuredNumCtx
				? `Model context is ${max} tokens but num_ctx is set to ${report.configuredNumCtx}. Lower num_ctx.`
				: `Model context ${max} tokens; num_ctx ${report.configuredNumCtx}.`,
		);
	}
	return lines.join("\n");
}
