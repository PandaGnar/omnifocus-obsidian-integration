import { describe, expect, it } from "vitest";

import {
	CHAT_PATH,
	NdjsonDecoder,
	TAGS_PATH,
	assessPromptBudget,
	buildChatRequest,
	chunkText,
	detectTruncation,
	endpointUrl,
	estimatePromptTokens,
	formatConnectionReport,
	formatLatency,
	hitReplyCap,
	normalizeBaseUrl,
	parseStreamLine,
	readContextLength,
	readModelNames,
	splitNdjson,
} from "./protocol";
import type { OllamaChatMessage } from "./types";

describe("normalizeBaseUrl", () => {
	it("adds a scheme when the user typed a bare host", () => {
		expect(normalizeBaseUrl("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
	});

	it("keeps an explicit https scheme", () => {
		expect(normalizeBaseUrl("https://ollama.lan:11434")).toBe(
			"https://ollama.lan:11434",
		);
	});

	it("strips trailing slashes", () => {
		expect(normalizeBaseUrl("http://127.0.0.1:11434///")).toBe(
			"http://127.0.0.1:11434",
		);
	});

	it("strips an API path pasted from the docs", () => {
		expect(normalizeBaseUrl("http://127.0.0.1:11434/api/chat")).toBe(
			"http://127.0.0.1:11434",
		);
		expect(normalizeBaseUrl("http://127.0.0.1:11434/api")).toBe(
			"http://127.0.0.1:11434",
		);
		expect(normalizeBaseUrl("http://127.0.0.1:11434/v1")).toBe(
			"http://127.0.0.1:11434",
		);
	});

	it("returns empty for blank input rather than inventing a host", () => {
		expect(normalizeBaseUrl("   ")).toBe("");
	});

	it("keeps a host that is itself named like an API path", () => {
		// `http://api` is a plausible compose/container hostname. Stripping the
		// suffix off the whole string ate the host and produced `http:`, which
		// then built the malformed `http:/api/tags`.
		expect(normalizeBaseUrl("http://api")).toBe("http://api");
		expect(normalizeBaseUrl("http://v1")).toBe("http://v1");
		expect(normalizeBaseUrl("api")).toBe("http://api");
		expect(endpointUrl("http://api", TAGS_PATH)).toBe("http://api/api/tags");
	});

	it("strips a trailing slash from such a host without eating it", () => {
		expect(normalizeBaseUrl("http://api/")).toBe("http://api");
		expect(normalizeBaseUrl("http://api///")).toBe("http://api");
	});

	it("still strips a real /v1 or /api suffix from the path", () => {
		expect(normalizeBaseUrl("http://api/v1")).toBe("http://api");
		expect(normalizeBaseUrl("http://api:11434/v1")).toBe("http://api:11434");
		expect(normalizeBaseUrl("http://box/ollama/api")).toBe("http://box/ollama");
	});

	it("refuses input that is not a URL at all", () => {
		expect(normalizeBaseUrl("http://")).toBe("");
	});
});

describe("endpointUrl", () => {
	it("never doubles the api segment", () => {
		expect(endpointUrl("http://127.0.0.1:11434/api/", CHAT_PATH)).toBe(
			"http://127.0.0.1:11434/api/chat",
		);
	});

	it("refuses an empty base URL", () => {
		expect(() => endpointUrl("", CHAT_PATH)).toThrow(/empty/i);
	});
});

describe("buildChatRequest", () => {
	const messages: OllamaChatMessage[] = [{ role: "user", content: "hello" }];

	it("always sends num_ctx, num_predict and keep_alive", () => {
		const body = buildChatRequest({
			model: "gemma4:e4b",
			messages,
			stream: true,
			numCtx: 32768,
			numPredict: 2048,
			keepAlive: "30m",
		});
		expect(body.options.num_ctx).toBe(32768);
		expect(body.options.num_predict).toBe(2048);
		expect(body.keep_alive).toBe("30m");
		expect(body.stream).toBe(true);
	});

	it("sends a pinned seed and temperature when a caller asks for them", () => {
		// The benchmark pins both so its decode column measures the same
		// generation on every run instead of whatever the sampler picked.
		const body = buildChatRequest({
			model: "gemma4:e4b",
			messages,
			stream: true,
			numCtx: 8192,
			numPredict: 128,
			keepAlive: "30m",
			seed: 1,
			temperature: 0,
		});
		expect(body.options.seed).toBe(1);
		expect(body.options.temperature).toBe(0);
	});

	it("omits them entirely when no caller pinned them", () => {
		const body = buildChatRequest({
			model: "gemma4:e4b",
			messages,
			stream: true,
			numCtx: 8192,
			numPredict: 128,
			keepAlive: "30m",
		});
		// Absent, not defaulted: `options` is part of what the plugin sends on
		// every turn, and a seed we invented would be a behaviour change.
		expect("seed" in body.options).toBe(false);
		expect("temperature" in body.options).toBe(false);
	});

	it("keeps message order, which the prompt cache depends on", () => {
		const ordered: OllamaChatMessage[] = [
			{ role: "system", content: "stable" },
			{ role: "user", content: "question" },
		];
		const body = buildChatRequest({
			model: "gemma4:e4b",
			messages: ordered,
			stream: false,
			numCtx: 8192,
			numPredict: 256,
			keepAlive: "-1",
		});
		expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
	});

	it("refuses an unconfigured model", () => {
		expect(() =>
			buildChatRequest({
				model: "  ",
				messages,
				stream: true,
				numCtx: 8192,
				numPredict: 256,
				keepAlive: "30m",
			}),
		).toThrow(/model/i);
	});

	it("refuses an empty message list", () => {
		expect(() =>
			buildChatRequest({
				model: "gemma4:e4b",
				messages: [],
				stream: true,
				numCtx: 8192,
				numPredict: 256,
				keepAlive: "30m",
			}),
		).toThrow(/no messages/i);
	});
});

describe("splitNdjson", () => {
	it("holds back an incomplete trailing line", () => {
		expect(splitNdjson('{"a":1}\n{"b":')).toEqual({
			lines: ['{"a":1}'],
			rest: '{"b":',
		});
	});

	it("returns no lines when nothing is terminated", () => {
		expect(splitNdjson('{"a"')).toEqual({ lines: [], rest: '{"a"' });
	});

	it("tolerates CRLF", () => {
		expect(splitNdjson('{"a":1}\r\n{"b":2}\r\n').lines).toEqual([
			'{"a":1}',
			'{"b":2}',
		]);
	});

	it("drops blank lines", () => {
		expect(splitNdjson('{"a":1}\n\n\n{"b":2}\n').lines).toEqual([
			'{"a":1}',
			'{"b":2}',
		]);
	});
});

describe("parseStreamLine", () => {
	it("surfaces an Ollama error frame as an error event", () => {
		expect(parseStreamLine('{"error":"model not found"}')).toEqual({
			kind: "error",
			message: "model not found",
		});
	});

	it("reports unparseable JSON instead of throwing", () => {
		const event = parseStreamLine("<html>502</html>");
		expect(event?.kind).toBe("error");
	});

	it("ignores blank lines and SSE sentinels", () => {
		expect(parseStreamLine("   ")).toBeNull();
		expect(parseStreamLine("data: [DONE]")).toBeNull();
	});

	it("rejects a JSON array, which is not a chat frame", () => {
		expect(parseStreamLine("[1,2,3]")?.kind).toBe("error");
	});
});

describe("NdjsonDecoder", () => {
	const frames = [
		'{"message":{"role":"assistant","content":"Hel"},"done":false}',
		'{"message":{"role":"assistant","content":"lo w"},"done":false}',
		'{"message":{"role":"assistant","content":"orld"},"done":true,"prompt_eval_count":11}',
	];

	/** Feed a byte stream in chunks of `size` and collect the assembled text. */
	function decodeInChunks(payload: string, size: number): string {
		const decoder = new NdjsonDecoder();
		let text = "";
		let done = false;
		for (let i = 0; i < payload.length; i += size) {
			for (const event of decoder.push(payload.slice(i, i + size))) {
				if (event.kind === "error") throw new Error(event.message);
				text += chunkText(event.value);
				if (event.value.done === true) done = true;
			}
		}
		for (const event of decoder.flush()) {
			if (event.kind === "error") throw new Error(event.message);
			text += chunkText(event.value);
			if (event.value.done === true) done = true;
		}
		expect(done).toBe(true);
		return text;
	}

	it("reassembles the reply whatever size the chunks arrive in", () => {
		const payload = `${frames.join("\n")}\n`;
		// Chunk size 1 splits every single frame mid-line, repeatedly.
		for (const size of [1, 3, 7, 17, 64, payload.length]) {
			expect(decodeInChunks(payload, size)).toBe("Hello world");
		}
	});

	it("emits nothing until a line is terminated", () => {
		const decoder = new NdjsonDecoder();
		expect(decoder.push('{"message":{"content":"partial"}')).toEqual([]);
		const events = decoder.push("}\n");
		expect(events).toHaveLength(1);
		expect(events[0]?.kind === "chunk" && chunkText(events[0].value)).toBe(
			"partial",
		);
	});

	it("recovers a final line the server never terminated", () => {
		const decoder = new NdjsonDecoder();
		expect(decoder.push('{"message":{"content":"tail"},"done":true}')).toEqual([]);
		const flushed = decoder.flush();
		expect(flushed).toHaveLength(1);
		expect(flushed[0]?.kind === "chunk" && chunkText(flushed[0].value)).toBe("tail");
	});

	it("reports a line cut off in transit as truncated, not as bad JSON", () => {
		// The connection died mid-frame. Calling this "Ollama sent a line that is
		// not JSON" blames the server for a network failure, and — because the
		// client does not retry API errors — throws away the buffered fallback
		// that would have recovered the reply.
		const decoder = new NdjsonDecoder();
		decoder.push('{"message":{"content":"half a fra');
		const flushed = decoder.flush();
		expect(flushed).toHaveLength(1);
		expect(flushed[0]?.kind).toBe("error");
		expect(flushed[0]?.kind === "error" && flushed[0].truncated).toBe(true);
		expect(flushed[0]?.kind === "error" && flushed[0].message).toMatch(/ended mid-response/i);
	});

	it("still blames Ollama for a complete line that is a real error", () => {
		// This one parsed. The server said it, so it is an API error and must
		// not be retried.
		const decoder = new NdjsonDecoder();
		decoder.push('{"error":"model requires more system memory"}');
		const flushed = decoder.flush();
		expect(flushed[0]?.kind === "error" && flushed[0].truncated).toBeUndefined();
		expect(flushed[0]?.kind === "error" && flushed[0].message).toBe(
			"model requires more system memory",
		);
	});

	it("does not re-emit anything after a flush", () => {
		const decoder = new NdjsonDecoder();
		decoder.push('{"message":{"content":"x"}}');
		expect(decoder.flush()).toHaveLength(1);
		expect(decoder.flush()).toHaveLength(0);
	});

	it("keeps a multi-byte character split across chunks intact", () => {
		// The decoder works on text, so the transport's TextDecoder handles the
		// byte split; what matters here is that the JSON survives line splitting.
		const payload = '{"message":{"content":"café ☕"},"done":true}\n';
		expect(decodeInChunks(payload, 5)).toBe("café ☕");
	});
});

describe("estimatePromptTokens", () => {
	it("grows with content", () => {
		const small = estimatePromptTokens([{ role: "user", content: "hi" }]);
		const large = estimatePromptTokens([{ role: "user", content: "x".repeat(4000) }]);
		expect(large).toBeGreaterThan(small);
		expect(large).toBeGreaterThan(900);
	});

	it("charges per-message framing overhead", () => {
		const one = estimatePromptTokens([{ role: "user", content: "" }]);
		const two = estimatePromptTokens([
			{ role: "user", content: "" },
			{ role: "assistant", content: "" },
		]);
		expect(two).toBe(one * 2);
		expect(one).toBeGreaterThan(0);
	});
});

describe("assessPromptBudget", () => {
	it("passes a prompt with room for the reply", () => {
		expect(
			assessPromptBudget({
				estimatedPromptTokens: 6000,
				numCtx: 32768,
				numPredict: 2048,
			}).status,
		).toBe("ok");
	});

	it("flags a prompt that fits but leaves no room to answer", () => {
		const budget = assessPromptBudget({
			estimatedPromptTokens: 31_500,
			numCtx: 32768,
			numPredict: 2048,
		});
		expect(budget.status).toBe("tight");
		expect(budget.headroomTokens).toBe(1268);
	});

	it("flags a prompt larger than the window", () => {
		const budget = assessPromptBudget({
			estimatedPromptTokens: 40_000,
			numCtx: 32768,
			numPredict: 2048,
		});
		expect(budget.status).toBe("over");
		expect(budget.message).toMatch(/oldest/i);
	});
});

describe("hitReplyCap", () => {
	it("recognises a reply stopped by num_predict", () => {
		expect(hitReplyCap({ done: true, done_reason: "length" })).toBe(true);
	});

	it("does not flag a reply the model finished on its own", () => {
		expect(hitReplyCap({ done: true, done_reason: "stop" })).toBe(false);
		expect(hitReplyCap({ done: true })).toBe(false);
		expect(hitReplyCap(null)).toBe(false);
	});
});

describe("detectTruncation", () => {
	it("reports truncation when prompt_eval_count is pinned at num_ctx", () => {
		const report = detectTruncation({
			promptEvalCount: 32768,
			numCtx: 32768,
			estimatedPromptTokens: 41_000,
		});
		expect(report.status).toBe("truncated");
		expect(report.estimatedDroppedTokens).toBe(41_000 - 32_768);
		expect(report.message).toMatch(/truncated/i);
	});

	it("reports truncation when the count exceeds num_ctx", () => {
		expect(detectTruncation({ promptEvalCount: 40_000, numCtx: 32768 }).status).toBe(
			"truncated",
		);
	});

	it("passes a prompt that fit", () => {
		const report = detectTruncation({
			promptEvalCount: 6123,
			numCtx: 32768,
			estimatedPromptTokens: 6000,
		});
		expect(report.status).toBe("ok");
		expect(report.estimatedDroppedTokens).toBeNull();
	});

	it("does not cry truncation on a prompt-cache hit", () => {
		// A prefix cache hit makes prompt_eval_count far smaller than what we
		// sent. That is a fast path, not a dropped prompt.
		expect(
			detectTruncation({
				promptEvalCount: 40,
				numCtx: 32768,
				estimatedPromptTokens: 20_000,
			}).status,
		).toBe("ok");
	});

	it("says unknown when the server reported no count", () => {
		expect(detectTruncation({ promptEvalCount: undefined, numCtx: 32768 }).status).toBe(
			"unknown",
		);
		expect(detectTruncation({ promptEvalCount: null, numCtx: 32768 }).status).toBe(
			"unknown",
		);
	});
});

describe("readModelNames", () => {
	it("sorts and de-duplicates", () => {
		expect(
			readModelNames({
				models: [
					{ name: "gemma4:e4b" },
					{ name: "qwen3-embedding:0.6b" },
					{ name: "gemma4:e2b" },
					{ name: "gemma4:e4b" },
				],
			}),
		).toEqual(["gemma4:e2b", "gemma4:e4b", "qwen3-embedding:0.6b"]);
	});

	it("survives a response with no models field", () => {
		expect(readModelNames({})).toEqual([]);
	});
});

describe("readContextLength", () => {
	it("finds the architecture-prefixed key", () => {
		expect(
			readContextLength({
				model_info: { "general.architecture": "gemma4", "gemma4.context_length": 131072 },
			}),
		).toBe(131072);
	});

	it("returns null when the field is absent", () => {
		expect(readContextLength({ model_info: { "general.architecture": "gemma4" } })).toBeNull();
		expect(readContextLength({})).toBeNull();
	});
});

describe("formatLatency", () => {
	it("uses milliseconds under a second", () => {
		expect(formatLatency(812.4)).toBe("812 ms");
	});

	it("uses seconds above one", () => {
		expect(formatLatency(1240)).toBe("1.24 s");
	});

	it("does not invent a number for nonsense", () => {
		expect(formatLatency(Number.NaN)).toBe("unknown");
	});
});

describe("formatConnectionReport", () => {
	const base = {
		ok: true,
		latencyMs: 42,
		baseUrl: "http://127.0.0.1:11434",
		models: ["gemma4:e2b", "gemma4:e4b"],
		selectedModel: "gemma4:e4b",
		configuredNumCtx: 32768,
	};

	it("reports the model and the latency", () => {
		const text = formatConnectionReport(base);
		expect(text).toContain("42 ms");
		expect(text).toContain("gemma4:e4b");
		expect(text).toContain("2 models installed");
	});

	it("tells the user how to install a missing model", () => {
		expect(
			formatConnectionReport({ ...base, selectedModel: "gemma4:12b" }),
		).toContain("ollama pull gemma4:12b");
	});

	it("warns when num_ctx exceeds what the model supports", () => {
		expect(
			formatConnectionReport({ ...base, modelContextLength: 8192 }),
		).toMatch(/Lower num_ctx/);
	});

	it("reports the failure rather than a bare false", () => {
		expect(
			formatConnectionReport({ ...base, ok: false, error: "connection refused" }),
		).toContain("connection refused");
	});
});
