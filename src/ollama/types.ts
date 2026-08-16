// Wire types for Ollama's native API, plus the transport seam the client is
// written against. Deliberately free of any `obsidian` import: everything in
// this folder except `transport.ts` must be loadable in a plain Node test.
//
// These mirror `/api/tags`, `/api/chat` and `/api/show` as of Ollama 0.12.
// Fields Ollama may omit are optional here rather than asserted, because a
// missing timing field should degrade a report, not throw.

export type OllamaRole = "system" | "user" | "assistant";

export interface OllamaChatMessage {
	role: OllamaRole;
	content: string;
}

/**
 * Per-request runtime options. `num_ctx` and `num_predict` are required here
 * on purpose — see `buildChatRequest` for why we never let the server pick.
 */
export interface OllamaRequestOptions {
	num_ctx: number;
	num_predict: number;
}

export interface OllamaChatRequest {
	model: string;
	messages: OllamaChatMessage[];
	stream: boolean;
	/** Seconds as a number, a duration string like `30m`, or `-1` for forever. */
	keep_alive: string | number;
	options: OllamaRequestOptions;
}

/**
 * One `/api/chat` frame. In streaming mode every frame carries a partial
 * `message.content`; only the final frame (`done: true`) carries the counters.
 */
export interface OllamaChatResponse {
	model?: string;
	created_at?: string;
	message?: { role?: string; content?: string };
	done?: boolean;
	done_reason?: string;
	total_duration?: number;
	load_duration?: number;
	prompt_eval_count?: number;
	prompt_eval_duration?: number;
	eval_count?: number;
	eval_duration?: number;
}

export interface OllamaModelDetails {
	family?: string;
	parameter_size?: string;
	quantization_level?: string;
}

export interface OllamaTagsModel {
	name: string;
	model?: string;
	size?: number;
	modified_at?: string;
	details?: OllamaModelDetails;
}

export interface OllamaTagsResponse {
	models?: OllamaTagsModel[];
}

export interface OllamaShowResponse {
	details?: OllamaModelDetails;
	capabilities?: string[];
	/**
	 * Architecture-prefixed metadata, e.g. `gemma4.context_length`. The prefix
	 * varies per model, so read it by key suffix rather than by exact name.
	 */
	model_info?: Record<string, unknown>;
}

export interface HttpRequest {
	url: string;
	method: "GET" | "POST";
	body?: string;
	signal?: AbortSignal;
}

export interface HttpResponse {
	status: number;
	text: string;
}

/**
 * The two ways this plugin can reach Ollama, kept apart because they have
 * genuinely different properties — see `transport.ts` for the tradeoff.
 *
 * `request` is CORS-exempt but buffers the whole body; `stream` yields decoded
 * text as it arrives but is subject to the browser origin policy.
 */
export interface OllamaTransport {
	request(req: HttpRequest): Promise<HttpResponse>;
	stream(req: HttpRequest): AsyncIterable<string>;
}
