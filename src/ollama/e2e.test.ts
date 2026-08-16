// Live smoke test against a real Ollama server. Skipped unless OLLAMA_E2E=1,
// so the default suite stays hermetic and offline.
//
//   OLLAMA_E2E=1 npm test
//   OLLAMA_E2E=1 OLLAMA_E2E_MODEL=gemma4:e2b OLLAMA_E2E_URL=http://127.0.0.1:11434 npm test
//
// This uses `fetch` directly, exactly as `transport.ts` does for streaming, so
// a pass here is real evidence that the streaming path works — it is the same
// code path minus Obsidian's renderer origin, which is the one thing a test
// outside the app cannot reproduce.

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../settings/settings";
import { OllamaClient } from "./client";
import { streamViaFetch } from "./fetch-stream";

const live = process.env["OLLAMA_E2E"] === "1";
const baseUrl = process.env["OLLAMA_E2E_URL"] ?? DEFAULT_SETTINGS.baseUrl;
const model = process.env["OLLAMA_E2E_MODEL"] ?? DEFAULT_SETTINGS.model;

describe.skipIf(!live)("live Ollama", () => {
	const client = new OllamaClient({
		transport: {
			async request(req) {
				const response = await fetch(req.url, {
					method: req.method,
					body: req.body,
					headers: { "Content-Type": "application/json" },
					signal: req.signal,
				});
				return { status: response.status, text: await response.text() };
			},
			stream: streamViaFetch,
		},
		getSettings: () => ({ ...DEFAULT_SETTINGS, baseUrl, model }),
	});

	it("lists installed models", async () => {
		const models = await client.listModels();
		expect(models.length).toBeGreaterThan(0);
		expect(models).toContain(model);
	}, 30_000);

	it("streams a reply and reports a prompt_eval_count", async () => {
		const tokens: string[] = [];
		const result = await client.chat(
			[{ role: "user", content: "Reply with exactly: ok" }],
			{ onToken: (text) => tokens.push(text) },
		);
		expect(result.streamed).toBe(true);
		// More than one frame is what distinguishes streaming from buffering.
		expect(tokens.length).toBeGreaterThan(1);
		expect(result.content.trim().length).toBeGreaterThan(0);
		expect(result.truncation.status).toBe("ok");
		expect(result.final?.prompt_eval_count).toBeGreaterThan(0);
	}, 120_000);

	it("stops generating when the signal is aborted", async () => {
		const controller = new AbortController();
		const promise = client.chat(
			[{ role: "user", content: "Count slowly from 1 to 500, one number per line." }],
			{ onToken: () => controller.abort() },
			controller.signal,
		);
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });
	}, 120_000);
});
