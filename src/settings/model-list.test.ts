import { describe, expect, it, vi } from "vitest";

import {
	ModelListState,
	NO_MODELS_OPTION,
	type Schedule,
	debounce,
	modelDropdownOptions,
} from "./model-list";

/** Collects scheduled callbacks so a test can decide when time passes. */
function manualSchedule(): { schedule: Schedule; runAll: () => void; pending: () => number } {
	let queue: (() => void)[] = [];
	return {
		schedule: (run) => {
			queue.push(run);
		},
		runAll: () => {
			const due = queue;
			queue = [];
			for (const run of due) run();
		},
		pending: () => queue.length,
	};
}

/** A promise plus the handles to settle it later. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let queued microtasks run, so an awaited `list()` result lands. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("modelDropdownOptions", () => {
	it("keeps a configured model that is not installed", () => {
		expect(modelDropdownOptions(["a", "b"], "gemma4:e4b")).toEqual([
			"gemma4:e4b",
			"a",
			"b",
		]);
	});

	it("does not duplicate a configured model that is installed", () => {
		expect(modelDropdownOptions(["a", "b"], "b")).toEqual(["a", "b"]);
	});

	it("says so when the server has nothing installed", () => {
		expect(modelDropdownOptions([], "")).toEqual([NO_MODELS_OPTION]);
	});
});

describe("debounce", () => {
	it("runs once for a burst of calls", () => {
		const clock = manualSchedule();
		const fn = vi.fn();
		const debounced = debounce(fn, 600, clock.schedule);

		// Typing "127.0.0.1:11434" one character at a time.
		for (let i = 0; i < 15; i += 1) debounced.call();
		clock.runAll();

		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("runs again for a burst that comes after the first settled", () => {
		const clock = manualSchedule();
		const fn = vi.fn();
		const debounced = debounce(fn, 600, clock.schedule);

		debounced.call();
		clock.runAll();
		debounced.call();
		clock.runAll();

		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("drops a pending run when cancelled", () => {
		const clock = manualSchedule();
		const fn = vi.fn();
		const debounced = debounce(fn, 600, clock.schedule);

		debounced.call();
		debounced.cancel();
		clock.runAll();

		expect(fn).not.toHaveBeenCalled();
	});
});

describe("ModelListState", () => {
	it("loads once however many times it is asked", async () => {
		const list = vi.fn(async () => ["a"]);
		const state = new ModelListState({ list, onChange: () => {}, onError: () => {} });

		state.ensureLoaded();
		state.ensureLoaded();
		state.ensureLoaded();
		await settle();
		state.ensureLoaded();
		await settle();

		expect(list).toHaveBeenCalledTimes(1);
		expect(state.current()).toEqual(["a"]);
	});

	it("repaints through onChange instead of expecting a full re-render", async () => {
		const onChange = vi.fn();
		const state = new ModelListState({
			list: async () => ["a", "b"],
			onChange,
			onError: () => {},
		});

		state.ensureLoaded();
		await settle();

		expect(onChange).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
	});

	it("discards a load that resolves after the host changed, and fetches again", async () => {
		// The user retyped the base URL while the first request was in flight.
		// Its answer describes a server they have already left.
		const first = deferred<string[]>();
		const second = deferred<string[]>();
		const list = vi
			.fn<() => Promise<string[]>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const onChange = vi.fn();
		const state = new ModelListState({ list, onChange, onError: () => {} });

		state.ensureLoaded();
		state.refresh();
		first.resolve(["stale-host-model"]);
		await settle();

		expect(onChange).not.toHaveBeenCalled();
		expect(list).toHaveBeenCalledTimes(2);

		second.resolve(["current-host-model"]);
		await settle();

		expect(state.current()).toEqual(["current-host-model"]);
		expect(onChange).toHaveBeenCalledExactlyOnceWith(["current-host-model"]);
	});

	it("does not stack up concurrent requests when refreshed mid-flight", async () => {
		const first = deferred<string[]>();
		const list = vi.fn<() => Promise<string[]>>().mockReturnValue(first.promise);
		const state = new ModelListState({ list, onChange: () => {}, onError: () => {} });

		state.ensureLoaded();
		state.refresh();
		state.refresh();
		state.refresh();

		// One in flight; the refreshes fold into a single re-run afterwards.
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("reports a failure and settles, rather than retrying forever", async () => {
		const onError = vi.fn();
		const onChange = vi.fn();
		const state = new ModelListState({
			list: async () => {
				throw new Error("connection refused");
			},
			onChange,
			onError,
		});

		state.ensureLoaded();
		await settle();

		expect(onError).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalledExactlyOnceWith([]);
		expect(state.isLoaded()).toBe(true);
	});

	it("adopts a list from Test connection and repaints the dropdown with it", async () => {
		// Previously this assignment bypassed the dropdown: a tab whose first
		// load failed kept showing "(none found)" after a successful test.
		const onChange = vi.fn();
		const state = new ModelListState({
			list: async () => {
				throw new Error("connection refused");
			},
			onChange,
			onError: () => {},
		});

		state.ensureLoaded();
		await settle();
		onChange.mockClear();

		state.adopt(["gemma4:e4b"]);

		expect(onChange).toHaveBeenCalledExactlyOnceWith(["gemma4:e4b"]);
		expect(state.current()).toEqual(["gemma4:e4b"]);
	});

	it("does not refetch after adopting a list", async () => {
		const pending = deferred<string[]>();
		const list = vi.fn<() => Promise<string[]>>().mockReturnValue(pending.promise);
		const onChange = vi.fn();
		const state = new ModelListState({ list, onChange, onError: () => {} });

		state.ensureLoaded();
		state.adopt(["from-test-connection"]);
		pending.resolve(["from-the-late-load"]);
		await settle();

		// The in-flight answer is dropped, but nothing goes back to the server:
		// Test connection just called /api/tags on our behalf.
		expect(list).toHaveBeenCalledTimes(1);
		expect(state.current()).toEqual(["from-test-connection"]);
	});
});
