// The streaming half of the transport, kept in its own module because it does
// not need `obsidian` — which means it can be unit-tested against a mocked
// global `fetch`, and reused verbatim by the live smoke test.
//
// Why `fetch` here at all, when the rest of the plugin deliberately uses
// Obsidian's `requestUrl`: see the long comment at the top of `transport.ts`.

import { OllamaHttpError } from "./client";
import type { HttpRequest } from "./types";

/**
 * Read an NDJSON body incrementally, yielding decoded text in whatever sized
 * pieces the network delivers. Splitting on line boundaries is `NdjsonDecoder`'s
 * job, not ours — chunks routinely arrive split mid-line.
 */
export async function* streamViaFetch(req: HttpRequest): AsyncIterable<string> {
	const response = await fetch(req.url, {
		method: req.method,
		body: req.body,
		headers: {
			"Content-Type": "application/json",
			Accept: "application/x-ndjson",
		},
		signal: req.signal,
	});

	if (!response.ok) {
		throw new OllamaHttpError(response.status, await safeText(response));
	}
	if (!response.body) {
		// Some environments (older Electron builds, some proxies) resolve without
		// a readable body. Treat that as "streaming is unavailable here" so the
		// client's buffered retry takes over rather than silently returning "".
		throw new TypeError("Streaming response had no readable body.");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			// stream: true keeps a multi-byte character split across a chunk
			// boundary intact instead of emitting a replacement character.
			const text = decoder.decode(value, { stream: true });
			if (text !== "") yield text;
		}
		const tail = decoder.decode();
		if (tail !== "") yield tail;
	} finally {
		// Cancelling matters on the abort path: without it an abandoned
		// generation keeps the socket open until GC.
		await reader.cancel().catch(() => undefined);
	}
}

async function safeText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}
