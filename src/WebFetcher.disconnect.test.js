// Recovery contract: when chromium disconnects (OOM, segfault, CDP
// sidecar teardown), the next operation must relaunch instead of holding
// a dead Browser handle. Mocks the playwright module so we can fire the
// 'disconnected' event without crashing a real browser.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import WebFetcher from "./WebFetcher.js";

function makeBrowserStub({ launches, disconnectListeners }) {
	const listeners = [];
	const ctxStub = {
		newPage: async () => ({
			goto: async () => ({
				status: () => 200,
				headers: () => ({ "content-type": "text/html" }),
			}),
			evaluate: async () => "",
			addScriptTag: async () => {},
			content: async () => "<html></html>",
			close: async () => {},
		}),
		close: async () => {},
	};
	const browser = {
		on(event, fn) {
			if (event === "disconnected") {
				listeners.push(fn);
				disconnectListeners.push(fn);
			}
		},
		newContext: async () => ctxStub,
		close: async () => {
			for (const fn of listeners) fn();
		},
	};
	launches.push(browser);
	return browser;
}

describe("WebFetcher — disconnect recovery", () => {
	it("clears state on disconnect; next fetch relaunches chromium", async (t) => {
		const launches = [];
		const disconnectListeners = [];

		t.mock.module("playwright", {
			namedExports: {
				chromium: {
					launch: async () =>
						makeBrowserStub({ launches, disconnectListeners }),
					connect: async () =>
						makeBrowserStub({ launches, disconnectListeners }),
				},
				devices: { "Pixel 5": {} },
			},
		});

		const fetcher = new WebFetcher();

		try {
			await fetcher.fetch("https://a.example/", { runId: 1, timeout: 1000 });
			assert.equal(launches.length, 1, "first fetch triggers initial launch");
			assert.equal(
				disconnectListeners.length,
				1,
				"disconnect listener registered against the live browser",
			);

			// Simulate chromium dying out from under us — no fetcher.close(),
			// no orderly teardown. Just the event Playwright fires when the
			// underlying process exits.
			disconnectListeners[0]();

			await fetcher.fetch("https://a.example/", { runId: 1, timeout: 1000 });
			assert.equal(
				launches.length,
				2,
				"post-disconnect fetch relaunches chromium (singleton was cleared)",
			);
			assert.equal(
				disconnectListeners.length,
				2,
				"the relaunched browser also gets a disconnect listener",
			);
		} finally {
			await fetcher.close();
		}
	});

	it("identity guard: stale disconnect from a previous browser doesn't clear a newer one", async (t) => {
		const launches = [];
		const disconnectListeners = [];

		t.mock.module("playwright", {
			namedExports: {
				chromium: {
					launch: async () =>
						makeBrowserStub({ launches, disconnectListeners }),
					connect: async () =>
						makeBrowserStub({ launches, disconnectListeners }),
				},
				devices: { "Pixel 5": {} },
			},
		});

		const fetcher = new WebFetcher();

		try {
			// First launch.
			await fetcher.fetch("https://a.example/", { runId: 1, timeout: 1000 });
			const staleDisconnect = disconnectListeners[0];

			// Force a relaunch by firing disconnect, then doing another fetch.
			staleDisconnect();
			await fetcher.fetch("https://a.example/", { runId: 1, timeout: 1000 });
			assert.equal(launches.length, 2, "second launch happened");

			// Now fire the STALE listener again. The handler's identity
			// guard (this.#browser === browser) should make this a no-op
			// against the new singleton.
			staleDisconnect();

			// Another fetch must reuse the second browser (no third launch).
			await fetcher.fetch("https://a.example/", { runId: 1, timeout: 1000 });
			assert.equal(
				launches.length,
				2,
				"stale disconnect did not nuke the live browser; no third launch",
			);
		} finally {
			await fetcher.close();
		}
	});
});
