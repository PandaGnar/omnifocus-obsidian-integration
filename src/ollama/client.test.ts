import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type MiseSettings } from "../settings/settings";
import {
	OllamaApiError,
	OllamaClient,
	OllamaHttpError,
	OllamaStreamIncompleteError,
	classifyStreamFailure,
	formatChatSummary,
} from "./client";
import type { HttpRequest, HttpResponse, OllamaTransport } from "./types";

interface RecordedRequest {
	url: string;
	method: string;
	body: unknown;
}

interface FakeTransportOptions {
	/** Text pieces the streaming path yields, in order. */
	streamChunks?: string[];
	/** Thrown from `stream()` before anything is yielded. */
	streamError?: unknown;
	/** Thrown after `streamThrowAfter` chunks have been yielded. */
	streamThrowAfter?: number;
	requestResponse?: HttpResponse;
	/** Runs inside `request()` before it resolves — lets a test cancel mid-flight. */
	onRequest?: () => void;
}

function fakeTransport(options: FakeTransportOptions): {
	transport: OllamaTransport;
	requests: RecordedRequest[];
	streams: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	const streams: RecordedRequest[] = [];
	const transport: OllamaTransport = {
		async request(req: HttpRequest): Promise<HttpResponse> {
			requests.push({
				url: req.url,
				method: req.method,
				body: req.body === undefined ? undefined : JSON.parse(req.body),
			});
			// Mirrors `requestUrl`: the signal is not consulted, so the call
			// completes even if the caller has given up on it.
			options.onRequest?.();
			return (
				options.requestResponse ?? { status: 200, text: JSON.stringify({ models: [] }) }
			);
		},
		async *stream(req: HttpRequest): AsyncIterable<string> {
			streams.push({
				url: req.url,
				method: req.method,
				body: req.body === undefined ? undefined : JSON.parse(req.body),
			});
			if (options.streamError) throw options.streamError;
			let emitted = 0;
			for (const chunk of options.streamChunks ?? []) {
				if (options.streamThrowAfter !== undefined && emitted === options.streamThrowAfter) {
					throw new TypeError("Failed to fetch");
				}
				yield chunk;
				emitted += 1;
			}
		},
	};
	return { transport, requests, streams };
}

function settings(overrides: Partial<MiseSettings> = {}): MiseSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

/** A monotonic fake clock so latency assertions are exact. */
function fakeClock(steps: number[]): () => number {
	let i = 0;
	return () => steps[Math.min(i++, steps.length - 1)] ?? 0;
}

const STREAM_FRAMES = [
	'{"model":"gemma4:e4b","message":{"role":"assistant","content":"Hel"},"done":false}\n',
	'{"model":"gemma4:e4b","message":{"role":"assistant","content":"lo"},"done":false}\n',
	'{"model":"gemma4:e4b","message":{"role":"assistant","content":"!"},"done":true,' +
		'"prompt_eval_count":12,"eval_count":3,"eval_duration":1000000000}\n',
];

describe("classifyStreamFailure", () => {
	it("treats a user cancel as aborted, never as a network problem", () => {
		const error = new Error("The user aborted a request.");
		error.name = "AbortError";
		expect(classifyStreamFailure(error)).toBe("aborted");
	});

	it("treats a fetch TypeError as unreachable", () => {
		expect(classifyStreamFailure(new TypeError("Failed to fetch"))).toBe("unreachable");
	});

	it("recognises a CORS rejection by message", () => {
		expect(classifyStreamFailure(new Error("blocked by CORS policy"))).toBe(
			"unreachable",
		);
	});

	it("keeps an HTTP error distinct, because retrying will not help", () => {
		expect(classifyStreamFailure(new OllamaHttpError(404, "model not found"))).toBe(
			"http",
		);
	});

	it("keeps an Ollama error frame distinct — the server answered", () => {
		expect(classifyStreamFailure(new OllamaApiError("out of memory"))).toBe("api");
	});

	it("treats a stream that stopped early as transport, not as the server answering", () => {
		expect(
			classifyStreamFailure(new OllamaStreamIncompleteError("cut off", "partial")),
		).toBe("unreachable");
	});
});

describe("OllamaClient.listModels", () => {
	it("calls /api/tags and returns sorted names", async () => {
		const { transport, requests } = fakeTransport({
			requestResponse: {
				status: 200,
				text: JSON.stringify({ models: [{ name: "b" }, { name: "a" }] }),
			},
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		expect(await client.listModels()).toEqual(["a", "b"]);
		expect(requests[0]?.url).toBe("http://127.0.0.1:11434/api/tags");
		expect(requests[0]?.method).toBe("GET");
	});

	it("raises the server's own error text on a 500", async () => {
		const { transport } = fakeTransport({
			requestResponse: { status: 500, text: "boom" },
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		await expect(client.listModels()).rejects.toBeInstanceOf(OllamaHttpError);
	});

	it("raises an API error when the body carries one", async () => {
		const { transport } = fakeTransport({
			requestResponse: { status: 200, text: JSON.stringify({ error: "no such host" }) },
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		await expect(client.listModels()).rejects.toBeInstanceOf(OllamaApiError);
	});
});

describe("OllamaClient.testConnection", () => {
	it("reports latency from the injected clock", async () => {
		const { transport } = fakeTransport({
			requestResponse: {
				status: 200,
				text: JSON.stringify({ models: [{ name: "gemma4:e4b" }] }),
			},
		});
		const client = new OllamaClient({
			transport,
			getSettings: () => settings({ model: "gemma4:e4b" }),
			now: fakeClock([1000, 1042]),
		});
		const report = await client.testConnection();
		expect(report.ok).toBe(true);
		expect(report.latencyMs).toBe(42);
		expect(report.models).toEqual(["gemma4:e4b"]);
	});

	it("returns a failed report rather than throwing", async () => {
		const { transport } = fakeTransport({
			requestResponse: { status: 502, text: "bad gateway" },
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		const report = await client.testConnection();
		expect(report.ok).toBe(false);
		expect(report.error).toMatch(/502/);
	});
});

describe("OllamaClient.chat streaming", () => {
	it("sends num_ctx, num_predict and keep_alive on the chat request", async () => {
		const { transport, streams } = fakeTransport({ streamChunks: STREAM_FRAMES });
		const client = new OllamaClient({
			transport,
			getSettings: () => settings({ numCtx: 16384, numPredict: 512, keepAlive: "-1" }),
		});
		await client.chat([{ role: "user", content: "hi" }]);
		const body = streams[0]?.body as {
			options: { num_ctx: number; num_predict: number };
			keep_alive: string;
			stream: boolean;
		};
		expect(streams[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
		expect(body.options.num_ctx).toBe(16384);
		expect(body.options.num_predict).toBe(512);
		expect(body.keep_alive).toBe("-1");
		expect(body.stream).toBe(true);
	});

	it("emits tokens in order and assembles the full reply", async () => {
		const { transport } = fakeTransport({ streamChunks: STREAM_FRAMES });
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		const tokens: string[] = [];
		const result = await client.chat([{ role: "user", content: "hi" }], {
			onToken: (t) => tokens.push(t),
		});
		expect(tokens).toEqual(["Hel", "lo", "!"]);
		expect(result.content).toBe("Hello!");
		expect(result.streamed).toBe(true);
		expect(result.truncation.status).toBe("ok");
	});

	it("reassembles frames split across chunk boundaries", async () => {
		// Deliver the same payload one character at a time.
		const chars = STREAM_FRAMES.join("").split("");
		const { transport } = fakeTransport({ streamChunks: chars });
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		const result = await client.chat([{ role: "user", content: "hi" }]);
		expect(result.content).toBe("Hello!");
	});

	it("flags a truncated prompt from the final frame", async () => {
		const { transport } = fakeTransport({
			streamChunks: [
				'{"message":{"content":"x"},"done":true,"prompt_eval_count":8192}\n',
			],
		});
		const client = new OllamaClient({
			transport,
			getSettings: () => settings({ numCtx: 8192 }),
		});
		const result = await client.chat([{ role: "user", content: "y".repeat(40_000) }]);
		expect(result.truncation.status).toBe("truncated");
		expect(result.truncation.message).toMatch(/8192/);
	});

	it("fails a stream that ends without its done frame, rather than returning half an answer", async () => {
		// Two content frames and then the connection simply stops. Every field
		// that would betray it is absent: no counters, no done, nothing.
		const { transport } = fakeTransport({
			streamChunks: [
				'{"message":{"content":"Half an "},"done":false}\n',
				'{"message":{"content":"answer"},"done":false}\n',
			],
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
			OllamaStreamIncompleteError,
		);
	});

	it("keeps the partial text on an incomplete stream, so the caller can show it", async () => {
		const { transport } = fakeTransport({
			streamChunks: ['{"message":{"content":"Half an answer"},"done":false}\n'],
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		const error = await client
			.chat([{ role: "user", content: "hi" }])
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OllamaStreamIncompleteError);
		expect((error as OllamaStreamIncompleteError).partialContent).toBe("Half an answer");
	});

	it("says when the reply was cut off by the num_predict cap", async () => {
		const { transport } = fakeTransport({
			streamChunks: [
				'{"message":{"content":"a long answer"},"done":true,"done_reason":"length",' +
					'"prompt_eval_count":12}\n',
			],
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		const result = await client.chat([{ role: "user", content: "hi" }]);
		expect(result.truncation.status).toBe("ok");
		expect(formatChatSummary(result)).toContain("num_predict cap");
	});

	it("surfaces an error frame mid-stream", async () => {
		const { transport } = fakeTransport({
			streamChunks: ['{"error":"model requires more system memory"}\n'],
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
			/system memory/,
		);
	});
});

describe("OllamaClient.chat fallback", () => {
	const bufferedReply = JSON.stringify({
		message: { role: "assistant", content: "Hello from the buffered path" },
		done: true,
		prompt_eval_count: 12,
	});

	it("retries without streaming when the stream transport cannot connect", async () => {
		const { transport, requests, streams } = fakeTransport({
			streamError: new TypeError("Failed to fetch"),
			requestResponse: { status: 200, text: bufferedReply },
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		const unavailable = vi.fn();
		const result = await client.chat(
			[{ role: "user", content: "hi" }],
			{ onStreamingUnavailable: unavailable },
		);
		expect(streams).toHaveLength(1);
		expect(requests).toHaveLength(1);
		expect((requests[0]?.body as { stream: boolean }).stream).toBe(false);
		expect(result.streamed).toBe(false);
		expect(result.content).toBe("Hello from the buffered path");
		expect(unavailable).toHaveBeenCalledOnce();
	});

	it("does not retry when the user cancelled", async () => {
		const abort = new Error("aborted");
		abort.name = "AbortError";
		const { transport, requests } = fakeTransport({
			streamError: abort,
			requestResponse: { status: 200, text: bufferedReply },
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
			/aborted/,
		);
		expect(requests).toHaveLength(0);
	});

	it("does not retry an HTTP error the server would repeat", async () => {
		const { transport, requests } = fakeTransport({
			streamError: new OllamaHttpError(404, "model 'gemma4:e4b' not found"),
			requestResponse: { status: 200, text: bufferedReply },
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
			OllamaHttpError,
		);
		expect(requests).toHaveLength(0);
	});

	it("does not retry once tokens have already been shown, to avoid duplicates", async () => {
		const { transport, requests } = fakeTransport({
			streamChunks: STREAM_FRAMES,
			streamThrowAfter: 1,
			requestResponse: { status: 200, text: bufferedReply },
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
			/Failed to fetch/,
		);
		expect(requests).toHaveLength(0);
	});

	it("falls back when the connection is cut mid-line, which is not an API error", async () => {
		// The stream dies partway through a frame. The tail is unparseable, but
		// that is a dropped connection — not Ollama sending us something bad —
		// so the buffered route is still worth trying.
		const { transport, requests } = fakeTransport({
			streamChunks: ['{"message":{"cont'],
			requestResponse: { status: 200, text: bufferedReply },
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		const result = await client.chat([{ role: "user", content: "hi" }]);
		expect(requests).toHaveLength(1);
		expect(result.streamed).toBe(false);
		expect(result.content).toBe("Hello from the buffered path");
	});

	it("does not start a buffered retry once the request has been cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const { transport, requests } = fakeTransport({
			streamError: new TypeError("Failed to fetch"),
			requestResponse: { status: 200, text: bufferedReply },
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		await expect(
			client.chat([{ role: "user", content: "hi" }], {}, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		// The whole point: no generation was started on a request the user
		// already gave up on.
		expect(requests).toHaveLength(0);
	});

	it("discards a buffered reply that finished after the user cancelled", async () => {
		const controller = new AbortController();
		const { transport, requests } = fakeTransport({
			streamError: new TypeError("Failed to fetch"),
			requestResponse: { status: 200, text: bufferedReply },
			// `requestUrl` cannot be aborted, so the call still completes — the
			// cancel lands while it is in flight.
			onRequest: () => controller.abort(),
		});
		const client = new OllamaClient({ transport, getSettings: () => settings() });
		const onToken = vi.fn();
		await expect(
			client.chat([{ role: "user", content: "hi" }], { onToken }, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(requests).toHaveLength(1);
		// The reply exists on the wire but must not reach a UI that asked to stop.
		expect(onToken).not.toHaveBeenCalled();
	});

	it("honours the setting that disables the fallback", async () => {
		const { transport, requests } = fakeTransport({
			streamError: new TypeError("Failed to fetch"),
			requestResponse: { status: 200, text: bufferedReply },
		});
		const client = new OllamaClient({
			transport,
			getSettings: () => settings({ fallbackToNonStreaming: false }),
		});
		await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
			/Failed to fetch/,
		);
		expect(requests).toHaveLength(0);
	});
});

describe("formatChatSummary", () => {
	it("reports throughput and says it streamed", () => {
		const text = formatChatSummary({
			content: "hi",
			streamed: true,
			latencyMs: 1500,
			truncation: {
				status: "ok",
				promptEvalCount: 10,
				numCtx: 32768,
				estimatedPromptTokens: 10,
				estimatedDroppedTokens: null,
				message: "fine",
			},
			final: { eval_count: 30, eval_duration: 3_000_000_000 },
		});
		expect(text).toContain("Streamed in 1.50 s");
		expect(text).toContain("30 tokens at 10.0 tok/s");
	});

	it("says so when the answer was not streamed, and surfaces truncation", () => {
		const text = formatChatSummary({
			content: "hi",
			streamed: false,
			latencyMs: 200,
			truncation: {
				status: "truncated",
				promptEvalCount: 8192,
				numCtx: 8192,
				estimatedPromptTokens: 10_000,
				estimatedDroppedTokens: 1808,
				message: "Prompt was truncated",
			},
			final: null,
		});
		expect(text).toContain("Buffered (no streaming)");
		expect(text).toContain("Prompt was truncated");
	});
});
