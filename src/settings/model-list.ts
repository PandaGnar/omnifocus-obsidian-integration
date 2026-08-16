// The model dropdown's state, lifted out of the settings tab.
//
// It lives here rather than in `tab.ts` because the awkward parts — a load
// resolving after the user has moved on, two different code paths both wanting
// to set the list — are exactly the parts worth testing, and `tab.ts` cannot be
// loaded without Obsidian and a DOM. Nothing in this file imports either.

/** Shown when the server answered but has no models installed. */
export const NO_MODELS_OPTION = "(none found)";

/**
 * What the dropdown should offer. A configured-but-not-installed model stays
 * selectable rather than being silently swapped for something else — the user
 * is told it is missing by the connection report, not by having their choice
 * changed underneath them.
 */
export function modelDropdownOptions(models: string[], current: string): string[] {
	const options = [...models];
	if (current !== "" && !options.includes(current)) options.unshift(current);
	if (options.length === 0) options.push(current === "" ? NO_MODELS_OPTION : current);
	return options;
}

/** Schedules `run` after `ms`. Injected so tests need no real timers. */
export type Schedule = (run: () => void, ms: number) => void;

const defaultSchedule: Schedule = (run, ms) => {
	setTimeout(run, ms);
};

export interface Debounced {
	/** Arm the callback, replacing any previously armed one. */
	call(): void;
	/** Drop anything armed. */
	cancel(): void;
}

/**
 * Run `fn` once the calls stop coming for `delayMs`.
 *
 * Superseded runs are dropped by token comparison rather than by cancelling a
 * timer handle, which keeps this free of the `number`-vs-`Timeout` difference
 * between the browser and Node and leaves nothing to clean up on unload.
 */
export function debounce(
	fn: () => void,
	delayMs: number,
	schedule: Schedule = defaultSchedule,
): Debounced {
	let latest = 0;
	return {
		call(): void {
			latest += 1;
			const token = latest;
			schedule(() => {
				if (token === latest) fn();
			}, delayMs);
		},
		cancel(): void {
			latest += 1;
		},
	};
}

export interface ModelListDeps {
	/** Fetch installed model names. */
	list: () => Promise<string[]>;
	/** The list changed; repaint. Called with a copy, never the internal array. */
	onChange: (models: string[]) => void;
	/** A load failed. Separate from `onChange` so the view need not know about errors. */
	onError: (error: unknown) => void;
}

/**
 * The cached model list and the rules for refreshing it.
 *
 * Two properties this exists to guarantee:
 *
 *  - **At most one load in flight.** Repeat requests fold into the running one
 *    instead of stacking up, so holding down a key in the base-URL field cannot
 *    fan out into a request per character.
 *  - **A result that arrived too late is discarded.** If the base URL changed
 *    while a load was in flight, that load is answering about a server the user
 *    has already left, and adopting its answer would show models from the wrong
 *    host. The stale result is dropped and a fresh load takes its place.
 *
 * Note what is *not* here: any re-render of the settings tab. Callers get an
 * `onChange` and repaint the dropdown alone. Rebuilding the whole tab from a
 * resolving load is what destroyed the text field the user was typing in.
 */
export class ModelListState {
	private models: string[] = [];
	private loaded = false;
	private loading = false;
	/** An in-flight load's answer is no longer wanted. */
	private stale = false;
	/** ...and something has asked for a fresh one to replace it. */
	private refetchWanted = false;

	constructor(private readonly deps: ModelListDeps) {}

	/** The list as last known. Empty before the first successful load. */
	current(): string[] {
		return [...this.models];
	}

	isLoaded(): boolean {
		return this.loaded;
	}

	/** Load if we have never loaded. Cheap to call on every `display()`. */
	ensureLoaded(): void {
		if (this.loaded || this.loading) return;
		void this.load();
	}

	/** Throw away what we have and fetch again: the host changed, or the user asked. */
	refresh(): void {
		this.loaded = false;
		this.stale = true;
		this.refetchWanted = true;
		if (!this.loading) void this.load();
	}

	/**
	 * Take a list obtained some other way — Test connection already called
	 * `/api/tags` and there is no reason to call it twice. Routing it through
	 * here is what keeps the two paths consistent: previously this assignment
	 * bypassed the dropdown entirely, so a tab whose first load failed went on
	 * showing "(none found)" after a successful test until it was reopened.
	 */
	adopt(models: string[]): void {
		this.stale = true;
		this.refetchWanted = false;
		this.models = [...models];
		this.loaded = true;
		this.deps.onChange(this.current());
	}

	private async load(): Promise<void> {
		this.loading = true;
		try {
			for (;;) {
				this.stale = false;
				this.refetchWanted = false;
				try {
					const next = await this.deps.list();
					if (!this.stale) {
						this.models = next;
						this.loaded = true;
						this.deps.onChange(this.current());
					}
				} catch (error) {
					if (!this.stale) {
						this.models = [];
						this.loaded = true;
						this.deps.onError(error);
						this.deps.onChange(this.current());
					}
				}
				// Went stale mid-flight and something wants the current answer:
				// go round again rather than leaving the list unloaded with no
				// load running.
				if (!(this.stale && this.refetchWanted)) return;
			}
		} finally {
			this.loading = false;
		}
	}
}
