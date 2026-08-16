// The Ollama client. Talks to an injected transport rather than to Obsidian or
// the network directly, so every path below — including the streaming path and
// its fallback — is exercised in tests with a fake transport.

import type { MiseSettings } from "../settings/settings";
import {
	CHAT_PATH,
	NdjsonDecoder,
	SHOW_PATH,
	TAGS_PATH,
	type ConnectionReport,
	type StreamEvent,
	type TruncationReport,
	buildChatRequest,
	chunkText,
	detectTruncation,
	endpointUrl,
	estimatePromptTokens,
	formatLatency,
	hitReplyCap,
	readContextLength,
	readModelNames,
} from "./protocol";
import type {
	HttpResponse,
	OllamaChatMessage,
	OllamaChatResponse,
	OllamaShowResponse,
	OllamaTagsResponse,
	OllamaTransport,
} from "./types";

/** Ollama answered, but not with success. Retrying without streaming won't help. */
export class OllamaHttpError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
	) {
		super(`Ollama returned HTTP ${status}: ${summarize(body)}`);
		this.name = "OllamaHttpError";
	}
}

/** Ollama reported an error inside an otherwise well-formed response. */
export class OllamaApiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OllamaApiError";
	}
}

/**
 * The stream stopped before the reply was finished — either the connection was
 * cut mid-frame, or it ended without the `done: true` frame that says the model
 * reached the end of its answer.
 *
 * This is an error on purpose. Both shapes otherwise return partial text as a
 * clean success: the content is short, `streamed` is true, and nothing in the
 * result distinguishes "the model stopped here" from "the bytes stopped here".
 * A half answer presented as a whole one is worse than a visible failure.
 */
export class OllamaStreamIncompleteError extends Error {
	constructor(
		message: string,
		/** Whatever text did arrive, so a caller can keep it on screen. */
		readonly partialContent: string = "",
	) {
		super(message);
		this.name = "OllamaStreamIncompleteError";
	}
}

function summarize(body: string): string {
	const text = body.trim();
	if (text === "") return "(empty body)";
	return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/**
 * Turn a decoder error event into the right exception. A line cut off in
 * transit is a transport failure the buffered route can recover; a line Ollama
 * sent us on purpose is an API error that would repeat.
 */
function streamEventError(
	event: Extract<StreamEvent, { kind: "error" }>,
	partialContent: string,
): Error {
	return event.truncated === true
		? new OllamaStreamIncompleteError(event.message, partialContent)
		: new OllamaApiError(event.message);
}

/**
 * Read `aborted` through a call rather than inline. The flag flips while we are
 * awaiting, and an inline `signal?.aborted === true` lets the compiler cache the
 * first read's narrowing and treat the second check as dead code.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** The rejection a cancelled request produces, preferring the signal's reason. */
function abortError(signal: AbortSignal | undefined): Error {
	const reason: unknown = signal?.reason;
	if (reason instanceof Error) return reason;
	const error = new Error("The chat request was cancelled.");
	error.name = "AbortError";
	return error;
}

export type StreamFailure = "aborted" | "unreachable" | "http" | "api" | "unknown";

/**
 * Why a streaming attempt failed.
 *
 * The distinction matters: a user cancelling must never trigger the
 * non-streaming retry, and neither should an HTTP or API-level error, because
 * the server clearly answered and would answer the same way again — retrying
 * would only make the user wait twice for the same "model not found".
 *
 * What *is* retried is `unreachable` and `unknown`, and the inclusion of
 * `unknown` is deliberate rather than an oversight. We cannot enumerate the
 * error shapes a CORS rejection takes across Electron versions — that is the
 * one thing no test here can pin down, and the buffered fallback exists
 * precisely for the case we failed to anticipate. Retrying only the shapes we
 * recognise would disable the fallback exactly when it is needed. Safety comes
 * from the `content === ""` gate at the call site, not from this classifier:
 * nothing is ever retried after a token has reached the screen, so the worst
 * outcome of a wrong guess here is one wasted prefill, never duplicated text.
 */
export function classifyStreamFailure(error: unknown): StreamFailure {
	if (error instanceof OllamaHttpError) return "http";
	if (error instanceof OllamaApiError) return "api";
	// A stream that stopped early is a transport failure, not the server
	// answering: the buffered route may well deliver the whole reply.
	if (error instanceof OllamaStreamIncompleteError) return "unreachable";
	if (typeof error === "object" && error !== null && "name" in error) {
		const name = String((error as { name: unknown }).name);
		if (name === "AbortError" || name === "TimeoutError") return "aborted";
	}
	if (error instanceof TypeError) return "unreachable";
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	if (
		message.includes("failed to fetch") ||
		message.includes("networkerror") ||
		message.includes("load failed") ||
		message.includes("cors") ||
		message.includes("econnrefused")
	) {
		return "unreachable";
	}
	return "unknown";
}

export interface ChatHandlers {
	/** Called once per decoded token batch, in arrival order. */
	onToken?: (text: string) => void;
	/** Called once if the streaming path was abandoned for the buffered one. */
	onStreamingUnavailable?: (reason: string) => void;
}

export interface ChatResult {
	content: string;
	/** False when the answer arrived in one buffered piece rather than streamed. */
	streamed: boolean;
	latencyMs: number;
	truncation: TruncationReport;
	final: OllamaChatResponse | null;
}

/** Nanoseconds, as Ollama reports durations. */
const NS_PER_SECOND = 1_000_000_000;

/**
 * One-line-per-fact summary of a completed chat: how it was delivered, how
 * fast, and whether the prompt survived intact. Pure, so the wording is tested
 * rather than eyeballed in a notice.
 */
export function formatChatSummary(result: ChatResult): string {
	const lines = [
		`${result.streamed ? "Streamed" : "Buffered (no streaming)"} in ${formatLatency(
			result.latencyMs,
		)}.`,
	];
	const evalCount = result.final?.eval_count;
	const evalDuration = result.final?.eval_duration;
	if (
		typeof evalCount === "number" &&
		typeof evalDuration === "number" &&
		evalDuration > 0
	) {
		const perSecond = evalCount / (evalDuration / NS_PER_SECOND);
		lines.push(`${evalCount} tokens at ${perSecond.toFixed(1)} tok/s.`);
	}
	// The reply hit num_predict rather than ending on its own. Said out loud
	// because we are the ones who imposed the cap.
	if (hitReplyCap(result.final)) {
		lines.push(
			"Reply was cut off at the num_predict cap, not finished by the model. " +
				"Raise num_predict in settings for a longer answer.",
		);
	}
	if (result.truncation.status !== "ok") lines.push(result.truncation.message);
	return lines.join("\n");
}

export interface OllamaClientDeps {
	transport: OllamaTransport;
	getSettings: () => MiseSettings;
	/** Injected so latency assertions in tests are not wall-clock dependent. */
	now?: () => number;
}

function parseJson<T>(response: HttpResponse, what: string): T {
	if (response.status < 200 || response.status >= 300) {
		throw new OllamaHttpError(response.status, response.text);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(response.text);
	} catch {
		throw new OllamaApiError(
			`${what} returned a body that is not JSON: ${summarize(response.text)}`,
		);
	}
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		const error = (parsed as Record<string, unknown>)["error"];
		if (typeof error === "string") throw new OllamaApiError(error);
	}
	// Callers read only fields declared optional on their response types, so a
	// server that omits one degrades the report instead of throwing here.
	return parsed as T;
}

export class OllamaClient {
	private readonly transport: OllamaTransport;
	private readonly getSettings: () => MiseSettings;
	private readonly now: () => number;

	constructor(deps: OllamaClientDeps) {
		this.transport = deps.transport;
		this.getSettings = deps.getSettings;
		this.now = deps.now ?? Date.now;
	}

	/** `/api/tags` — installed models, for the settings dropdown. */
	async listModels(signal?: AbortSignal): Promise<string[]> {
		const settings = this.getSettings();
		const response = await this.transport.request({
			url: endpointUrl(settings.baseUrl, TAGS_PATH),
			method: "GET",
			signal,
		});
		return readModelNames(parseJson<OllamaTagsResponse>(response, TAGS_PATH));
	}

	/** `/api/show` — model metadata, including its true maximum context. */
	async show(model: string, signal?: AbortSignal): Promise<OllamaShowResponse> {
		const settings = this.getSettings();
		const response = await this.transport.request({
			url: endpointUrl(settings.baseUrl, SHOW_PATH),
			method: "POST",
			body: JSON.stringify({ model }),
			signal,
		});
		return parseJson<OllamaShowResponse>(response, SHOW_PATH);
	}

	/**
	 * Reach the server, list its models, and — if the selected model is
	 * installed — read its context length so we can flag a `num_ctx` the model
	 * cannot honour. `/api/show` failing is not fatal to the report.
	 */
	async testConnection(signal?: AbortSignal): Promise<ConnectionReport> {
		const settings = this.getSettings();
		const started = this.now();
		try {
			const models = await this.listModels(signal);
			const latencyMs = this.now() - started;
			let modelContextLength: number | null = null;
			if (settings.model !== "" && models.includes(settings.model)) {
				try {
					modelContextLength = readContextLength(
						await this.show(settings.model, signal),
					);
				} catch {
					// Older Ollama builds omit model_info from /api/show. The
					// connection is still proven by /api/tags above.
					modelContextLength = null;
				}
			}
			return {
				ok: true,
				latencyMs,
				baseUrl: settings.baseUrl,
				models,
				selectedModel: settings.model,
				modelContextLength,
				configuredNumCtx: settings.numCtx,
			};
		} catch (error) {
			return {
				ok: false,
				latencyMs: this.now() - started,
				baseUrl: settings.baseUrl,
				models: [],
				selectedModel: settings.model,
				configuredNumCtx: settings.numCtx,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * `/api/chat`. Streams by default and falls back to a single buffered
	 * request when the streaming transport cannot get off the ground — see
	 * `transport.ts` for why those are two different code paths.
	 */
	async chat(
		messages: OllamaChatMessage[],
		handlers: ChatHandlers = {},
		signal?: AbortSignal,
	): Promise<ChatResult> {
		const settings = this.getSettings();
		const estimatedPromptTokens = estimatePromptTokens(messages);
		const started = this.now();

		let content = "";
		let final: OllamaChatResponse | null = null;

		const streamBody = JSON.stringify(
			buildChatRequest({
				model: settings.model,
				messages,
				stream: true,
				numCtx: settings.numCtx,
				numPredict: settings.numPredict,
				keepAlive: settings.keepAlive,
			}),
		);

		try {
			const decoder = new NdjsonDecoder();
			const url = endpointUrl(settings.baseUrl, CHAT_PATH);
			const consume = (event: StreamEvent): void => {
				if (event.kind === "error") throw streamEventError(event, content);
				const text = chunkText(event.value);
				content += text;
				if (text !== "") handlers.onToken?.(text);
				if (event.value.done === true) final = event.value;
			};

			for await (const piece of this.transport.stream({
				url,
				method: "POST",
				body: streamBody,
				signal,
			})) {
				for (const event of decoder.push(piece)) consume(event);
			}
			for (const event of decoder.flush()) consume(event);

			// No `done: true` frame means the bytes ran out before the model
			// finished. Returning here would hand back a half answer that looks
			// exactly like a complete one — same shape, same `streamed: true`,
			// and a truncation report that speaks only about the prompt.
			if (final === null) {
				throw new OllamaStreamIncompleteError(
					"Ollama's reply ended before the model finished it (no completion frame arrived).",
					content,
				);
			}

			return this.finishChat({
				content,
				streamed: true,
				started,
				final,
				estimatedPromptTokens,
				numCtx: settings.numCtx,
			});
		} catch (error) {
			// A cancel that landed during the streaming attempt must not turn
			// into a buffered generation the user can no longer stop.
			if (isAborted(signal)) throw abortError(signal);
			const failure = classifyStreamFailure(error);
			const recoverable =
				settings.fallbackToNonStreaming &&
				(failure === "unreachable" || failure === "unknown") &&
				content === "";
			if (!recoverable) throw error;
			handlers.onStreamingUnavailable?.(
				error instanceof Error ? error.message : String(error),
			);
		}

		// Buffered retry over the CORS-exempt transport. No tokens arrive until
		// generation finishes, so the caller is told the answer was not streamed.
		const response = await this.transport.request({
			url: endpointUrl(settings.baseUrl, CHAT_PATH),
			method: "POST",
			body: JSON.stringify(
				buildChatRequest({
					model: settings.model,
					messages,
					stream: false,
					numCtx: settings.numCtx,
					numPredict: settings.numPredict,
					keepAlive: settings.keepAlive,
				}),
			),
			signal,
		});
		// `requestUrl` takes no signal, so the HTTP request above ran to
		// completion regardless. What we can still honour is the user's intent:
		// a cancel that landed while it was in flight discards the reply instead
		// of rendering it into a modal the user has already dismissed.
		if (isAborted(signal)) throw abortError(signal);
		const parsed = parseJson<OllamaChatResponse>(response, CHAT_PATH);
		const buffered = chunkText(parsed);
		if (buffered !== "") handlers.onToken?.(buffered);
		return this.finishChat({
			content: buffered,
			streamed: false,
			started,
			final: parsed,
			estimatedPromptTokens,
			numCtx: settings.numCtx,
		});
	}

	private finishChat(params: {
		content: string;
		streamed: boolean;
		started: number;
		final: OllamaChatResponse | null;
		estimatedPromptTokens: number;
		numCtx: number;
	}): ChatResult {
		return {
			content: params.content,
			streamed: params.streamed,
			latencyMs: this.now() - params.started,
			truncation: detectTruncation({
				promptEvalCount: params.final?.prompt_eval_count,
				numCtx: params.numCtx,
				estimatedPromptTokens: params.estimatedPromptTokens,
			}),
			final: params.final,
		};
	}
}
