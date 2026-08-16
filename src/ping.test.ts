import { describe, expect, it } from "vitest";

import manifest from "../manifest.json";
import { PLUGIN_ID, PLUGIN_VERSION, formatPingMessage } from "./ping";

describe("formatPingMessage", () => {
	it("reports the manifest version", () => {
		expect(formatPingMessage(new Date(2026, 7, 16, 9, 5))).toContain(
			manifest.version,
		);
	});

	it("zero-pads the local clock", () => {
		expect(formatPingMessage(new Date(2026, 7, 16, 9, 5))).toBe(
			`Mise Assistant ${PLUGIN_VERSION} — loaded (09:05)`,
		);
	});

	it("uses 24-hour time", () => {
		expect(formatPingMessage(new Date(2026, 7, 16, 23, 59))).toContain(
			"(23:59)",
		);
	});
});

describe("manifest constants", () => {
	it("matches the id the dev build installs into the vault", () => {
		expect(PLUGIN_ID).toBe("mise-assistant");
	});
});
