import { describe, expect, it } from "vitest";

import manifest from "../manifest.json";
import pkg from "../package.json";
import versions from "../versions.json";

// The plugin version lives in three files that no build step reconciles.
// `src/ping.ts` reads the manifest, so the running plugin can't disagree with
// it — but a release published from a stale package.json or an unmapped
// versions.json entry is a silent, user-visible break. Catch it here instead.
describe("release metadata", () => {
	it("keeps package.json in step with the manifest", () => {
		expect(pkg.version).toBe(manifest.version);
	});

	it("maps the current version to a minimum app version", () => {
		expect(versions).toHaveProperty(manifest.version);
	});

	it("maps it to the same minAppVersion the manifest declares", () => {
		const mapped = (versions as Record<string, string>)[manifest.version];
		expect(mapped).toBe(manifest.minAppVersion);
	});
});
