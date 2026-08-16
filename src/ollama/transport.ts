import { requestUrl } from "obsidian";

import { streamViaFetch } from "./fetch-stream";
import type { HttpRequest, HttpResponse, OllamaTransport } from "./types";

/*
 * THE TRADEOFF, stated once, here.
 *
 * Obsidian ships `requestUrl()`, which performs the request outside the
 * renderer and is therefore not subject to the browser origin policy. That
 * matters because Obsidian's renderer origin is `app://obsidian.md` and Ollama
 * enforces CORS on its HTTP API: a plain `fetch` can be rejected at preflight,
 * and the only user-side fix is setting `OLLAMA_ORIGINS` and restarting the
 * server — on macOS via `launchctl setenv`. We do not want a plugin whose
 * README opens with that.
 *
 * But `requestUrl()` resolves a single Promise with the complete body. It has
 * no reader, no events, no partial delivery — it cannot stream, and no wrapper
 * makes it stream. Obsidian offers no third API that both bypasses CORS and
 * yields incremental bytes.
 *
 * So the honest split is:
 *
 *   - `request()` uses `requestUrl` for everything that does not need
 *     incremental output: `/api/tags`, `/api/show`, and non-streaming
 *     `/api/chat`. These always work, with no server configuration at all.
 *   - `stream()` uses `fetch` with a `ReadableStream` reader, because that is
 *     the only way to get tokens as they are generated.
 *
 * The consequence is real and is not hidden: the streaming path depends on
 * Ollama accepting our origin. When it does not, `fetch` rejects at the
 * transport level, `classifyStreamFailure` reports `unreachable`, and
 * `OllamaClient.chat` retries the identical request through `requestUrl` with
 * `stream: false`. The user gets their answer either way; the only thing lost
 * is token-by-token display, and the UI says so rather than pretending.
 * Setting `OLLAMA_ORIGINS=app://obsidian.md` restores streaming — the one
 * piece of server configuration in the plugin, and it is optional.
 */

/** `requestUrl` for buffered calls; `fetch` for the streaming one. */
export function createObsidianTransport(): OllamaTransport {
	return {
		async request(req: HttpRequest): Promise<HttpResponse> {
			// `throw: false` keeps 4xx/5xx as data so callers can surface
			// Ollama's own error text instead of an opaque Obsidian exception.
			// requestUrl accepts no AbortSignal: the calls routed here are either
			// short (tags/show) or the buffered retry of an already-cancellable
			// request, so there is nothing long-running left un-cancellable.
			const response = await requestUrl({
				url: req.url,
				method: req.method,
				body: req.body,
				contentType: req.body === undefined ? undefined : "application/json",
				headers: { Accept: "application/json" },
				throw: false,
			});
			return { status: response.status, text: response.text };
		},

		stream(req: HttpRequest): AsyncIterable<string> {
			return streamViaFetch(req);
		},
	};
}
