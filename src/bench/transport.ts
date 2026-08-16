// The benchmark runs outside Obsidian, so there is no `requestUrl()` to call —
// but there is no renderer origin either, which is the only reason `requestUrl`
// exists in the plugin. Buffered requests therefore go through `fetch` here,
// and streaming reuses `streamViaFetch` verbatim: the exact code path the
// plugin streams with, so the timings are the plugin's timings.
//
// This is a shell around the existing transport seam, not a second client.

import { streamViaFetch } from "../ollama/fetch-stream";
import type { HttpRequest, HttpResponse, OllamaTransport } from "../ollama/types";

export function createFetchTransport(): OllamaTransport {
	return {
		async request(req: HttpRequest): Promise<HttpResponse> {
			const response = await fetch(req.url, {
				method: req.method,
				body: req.body,
				headers: {
					Accept: "application/json",
					...(req.body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				signal: req.signal,
			});
			return { status: response.status, text: await response.text() };
		},
		stream: streamViaFetch,
	};
}
