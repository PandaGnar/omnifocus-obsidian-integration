import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../settings/settings";
import {
	CONTEXT_HEADROOM_TOKENS,
	DEFAULT_CONTEXT_SIZES,
	DEFAULT_NUM_PREDICT,
	DEFAULT_OUTPUT_PATH,
	parseBenchArgs,
	promptTargetTokens,
} from "./args";

function options(argv: string[], env: Record<string, string | undefined> = {}) {
	const parsed = parseBenchArgs(argv, env);
	if (parsed.kind !== "options") {
		throw new Error(`expected options, got ${parsed.kind}: ${JSON.stringify(parsed)}`);
	}
	return parsed.options;
}

function error(argv: string[]): string {
	const parsed = parseBenchArgs(argv);
	if (parsed.kind !== "error") {
		throw new Error(`expected an error, got ${parsed.kind}`);
	}
	return parsed.message;
}

describe("parseBenchArgs defaults", () => {
	it("uses the plan's four context sizes", () => {
		expect(options([]).contextSizes).toEqual(DEFAULT_CONTEXT_SIZES);
		expect(DEFAULT_CONTEXT_SIZES).toEqual([2048, 8192, 16384, 32768]);
	});

	it("defaults to the plugin's own base URL, model and keep_alive", () => {
		const parsed = options([]);
		expect(parsed.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
		expect(parsed.model).toBe(DEFAULT_SETTINGS.model);
		expect(parsed.keepAlive).toBe(DEFAULT_SETTINGS.keepAlive);
		expect(parsed.numPredict).toBe(DEFAULT_NUM_PREDICT);
		expect(parsed.outPath).toBe(DEFAULT_OUTPUT_PATH);
		expect(parsed.jsonPath).toBeNull();
	});

	it("honours OLLAMA_HOST and MISE_BENCH_MODEL from the environment", () => {
		const parsed = options([], {
			OLLAMA_HOST: "http://10.0.0.4:11434",
			MISE_BENCH_MODEL: "some-model:tag",
		});
		expect(parsed.baseUrl).toBe("http://10.0.0.4:11434");
		expect(parsed.model).toBe("some-model:tag");
	});

	it("lets a flag beat the environment", () => {
		expect(
			options(["--url", "http://127.0.0.1:9999"], { OLLAMA_HOST: "http://10.0.0.4:11434" })
				.baseUrl,
		).toBe("http://127.0.0.1:9999");
	});
});

describe("parseBenchArgs flags", () => {
	it("normalises a base URL the way the client does", () => {
		expect(options(["--url", "localhost:11434/api"]).baseUrl).toBe("http://localhost:11434");
	});

	it("sorts and de-duplicates sizes so a repeat cannot look like a second sample", () => {
		expect(options(["--sizes", "32768,2048,8192,2048"]).contextSizes).toEqual([
			2048, 8192, 32768,
		]);
	});

	it("accepts --no-write and --json", () => {
		const parsed = options(["--no-write", "--json", "bench.json"]);
		expect(parsed.outPath).toBeNull();
		expect(parsed.jsonPath).toBe("bench.json");
	});

	it("accepts a negative keep_alive without reading it as a flag", () => {
		expect(options(["--keep-alive", "-1"]).keepAlive).toBe("-1");
	});

	it("returns help for -h and --help", () => {
		expect(parseBenchArgs(["-h"]).kind).toBe("help");
		expect(parseBenchArgs(["--help"]).kind).toBe("help");
	});
});

describe("parseBenchArgs rejections", () => {
	it("rejects an unusable URL", () => {
		expect(error(["--url", "::::"])).toMatch(/not a usable URL/);
	});

	it("rejects a flag given no value", () => {
		expect(error(["--model"])).toMatch(/needs a model name/);
		expect(error(["--sizes", "--no-write"])).toMatch(/comma-separated/);
	});

	it("rejects non-numeric and out-of-range sizes", () => {
		expect(error(["--sizes", "2048,big"])).toMatch(/not a positive integer/);
		expect(error(["--sizes", "1000000"])).toMatch(/outside the supported range/);
	});

	it("rejects a keep_alive Ollama would not understand", () => {
		expect(error(["--keep-alive", "forever"])).toMatch(/duration like 30m/);
	});

	it("rejects an unknown argument instead of ignoring it", () => {
		expect(error(["--turbo"])).toMatch(/Unrecognised argument/);
	});

	it("rejects a context size with no room left for a prompt", () => {
		// 512 of headroom + 128 reply tokens does not fit in a 512-token window.
		expect(error(["--sizes", "512"])).toMatch(/leaves no room for a prompt/);
	});
});

describe("promptTargetTokens", () => {
	it("reserves the reply and the headroom out of the window", () => {
		expect(promptTargetTokens(32768, 128)).toBe(32768 - 128 - CONTEXT_HEADROOM_TOKENS);
		expect(promptTargetTokens(2048, 128)).toBe(2048 - 128 - CONTEXT_HEADROOM_TOKENS);
	});

	it("never goes negative", () => {
		expect(promptTargetTokens(100, 128)).toBe(0);
	});
});
