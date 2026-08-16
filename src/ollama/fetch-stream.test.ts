import { afterEach, describe, expect, it, vi } from "vitest";

import { OllamaHttpError } from "./client";
import { streamViaFetch } from "./fetch-stream";

const encoder = new TextEncoder();

/** A Response whose body delivers `chunks` as separate reads. */
function streamingResponse(chunks: Uint8Array[], init: ResponseInit = {}): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	return new Response(body, { status: 200, ...init });
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
	const out: string[] = [];
	for await (const piece of iterable) out.push(piece);
	return out;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamViaFetch", () => {
	it("yields text as the body arrives, not all at the end", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				streamingResponse([encoder.encode('{"a":1}\n'), encoder.encode('{"b":2}\n')]),
			),
		);
		expect(await collect(streamViaFetch({ url: "http://x/api/chat", method: "POST" }))).toEqual(
			['{"a":1}\n', '{"b":2}\n'],
		);
	});

	it("reassembles a multi-byte character split across two reads", async () => {
		// "é" is 0xC3 0xA9; deliver the two bytes in separate chunks.
		const bytes = encoder.encode("café");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				streamingResponse([bytes.slice(0, bytes.length - 1), bytes.slice(-1)]),
			),
		);
		const pieces = await collect(streamViaFetch({ url: "http://x", method: "POST" }));
		expect(pieces.join("")).toBe("café");
		expect(pieces.join("")).not.toContain("�");
	});

	it("raises an HTTP error carrying the server's body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("model not found", { status: 404 })),
		);
		await expect(
			collect(streamViaFetch({ url: "http://x", method: "POST" })),
		).rejects.toBeInstanceOf(OllamaHttpError);
	});

	it("treats a body-less response as streaming being unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response),
		);
		await expect(
			collect(streamViaFetch({ url: "http://x", method: "POST" })),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("sends the body and the signal through to fetch", async () => {
		const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
			streamingResponse([encoder.encode("{}\n")]),
		);
		vi.stubGlobal("fetch", spy);
		const controller = new AbortController();
		await collect(
			streamViaFetch({
				url: "http://x/api/chat",
				method: "POST",
				body: '{"stream":true}',
				signal: controller.signal,
			}),
		);
		const init = spy.mock.calls[0]?.[1] as RequestInit;
		expect(init.body).toBe('{"stream":true}');
		expect(init.signal).toBe(controller.signal);
	});
});
