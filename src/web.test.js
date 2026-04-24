// Per-turn <search> cap. Path pattern guards the log-namespace
// migration — the pre-migration `search://` glob silently never
// matched, so the cap was dead for weeks.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import RummyWeb from "./web.js";

function captureHandler() {
	let searchHandler = null;
	const core = {
		hooks: {
			tools: {
				ensureTool: () => {},
				onHandle: (scheme, fn) => {
					if (scheme === "search") searchHandler = fn;
				},
				onView: () => {},
			},
		},
		registerScheme: () => {},
		on: () => {},
		filter: () => {},
	};
	new RummyWeb(core);
	if (!searchHandler) throw new Error("search handler not registered");
	return searchHandler;
}

function makeRummy({ priorSearches = [] } = {}) {
	const emitted = [];
	const queries = [];
	const upserted = [];
	return {
		runId: 1,
		loopId: 1,
		sequence: 5,
		entries: {
			set: async (payload) => upserted.push(payload),
		},
		getEntries: async (pattern, bodyFilter) => {
			queries.push({ pattern, bodyFilter });
			return priorSearches;
		},
		set: async (payload) => upserted.push(payload),
		getAttributes: async () => null,
		hooks: {
			error: {
				log: {
					emit: async (payload) => emitted.push(payload),
				},
			},
		},
		_emitted: emitted,
		_queries: queries,
		_upserted: upserted,
	};
}

describe("RummyWeb — one <search> per turn (@budget_enforcement)", () => {
	it("gate queries the log-namespace path (regression: not the pre-migration search:// scheme)", async () => {
		const handler = captureHandler();
		const rummy = makeRummy({ priorSearches: [{ path: "already_searched" }] });
		await handler(
			{
				attributes: { path: "second query" },
				resultPath: "log://turn_5/search/second%20query",
			},
			rummy,
		);
		const gate = rummy._queries[0];
		assert.ok(gate, "gate's getEntries call fired");
		assert.strictEqual(
			gate.pattern,
			"log://turn_5/search/*",
			"gate pattern matches the unified log namespace",
		);
	});

	it("refuses the second search with an error through hooks.error.log (strike)", async () => {
		const handler = captureHandler();
		const rummy = makeRummy({
			priorSearches: [{ path: "log://turn_5/search/first%20query" }],
		});
		await handler(
			{
				attributes: { path: "second query" },
				resultPath: "log://turn_5/search/second%20query",
			},
			rummy,
		);
		assert.strictEqual(
			rummy._emitted.length,
			1,
			"exactly one error emitted for the refused second search",
		);
		const err = rummy._emitted[0];
		assert.strictEqual(err.status, 429, "429 rate-limit status");
		assert.ok(
			err.message.includes("Only one <search> per turn"),
			`message states the rule; got: ${err.message}`,
		);
		assert.ok(
			err.message.includes("second query"),
			"message names the dropped query so the model can retry next turn",
		);
	});

	// Materialization regression: an earlier <get> that promoted a URL
	// was silently demoted by any later search that happened to return
	// the same URL. Model then saw the page it had just promoted as
	// unreadable and re-emitted the same search — the exact failure
	// mode diagnosed in rummy_dev.db::test:demo (T3 promoted wateratlas
	// → T4 search re-demoted it → T6 model "doesn't see the content").
	describe("result writes preserve existing visibility (@fidelity_semantics)", () => {
		it("URL already at visible stays visible after re-appearing in search results", async () => {
			const handler = captureHandler();
			const alreadyPromoted = "https://example.com/page";
			const getEntriesCalls = [];
			const setCalls = [];
			const rummy = {
				runId: 1,
				loopId: 1,
				sequence: 5,
				entries: { set: async () => {} },
				getEntries: async (pattern) => {
					getEntriesCalls.push(pattern);
					if (pattern.startsWith("log://")) return []; // no prior search
					if (pattern === alreadyPromoted) {
						return [{ path: alreadyPromoted, visibility: "visible" }];
					}
					return [];
				},
				set: async (payload) => setCalls.push(payload),
				getAttributes: async () => null,
				hooks: { error: { log: { emit: async () => {} } } },
			};
			// Stub WebFetcher so we don't hit network. Monkey-patch the
			// plugin's private fetcher by triggering the lazy init then
			// replacing its methods. Simpler: mock via the module boundary.
			const web = await import("./web.js");
			const _originalFetch = web.default.prototype;
			// Replace WebFetcher via the plugin instance captured above.
			// captureHandler returned the bound handler; we need to reach
			// the plugin. Easier: test the branch directly by feeding an
			// existing-visible URL through and asserting setCalls captures
			// visibility="visible".

			// Drive the handler with a mock fetcher patch.
			const WebFetcher = (await import("./WebFetcher.js")).default;
			const origSearch = WebFetcher.prototype.search;
			const origFetchAll = WebFetcher.prototype.fetchAll;
			WebFetcher.prototype.search = async () => [
				{ url: alreadyPromoted, engine: "brave", title: "T", snippet: "S" },
			];
			WebFetcher.prototype.fetchAll = async () => [
				{
					status: "fulfilled",
					value: {
						title: "Title",
						content: "fresh body",
						excerpt: "E",
						byline: null,
						siteName: null,
					},
				},
			];

			try {
				await handler(
					{
						attributes: { path: "q" },
						resultPath: "log://turn_5/search/q",
					},
					rummy,
				);
			} finally {
				WebFetcher.prototype.search = origSearch;
				WebFetcher.prototype.fetchAll = origFetchAll;
			}

			const pageSet = setCalls.find((c) => c.path === alreadyPromoted);
			assert.ok(pageSet, "search re-set the result URL");
			assert.strictEqual(
				pageSet.visibility,
				"visible",
				"already-visible URL must not be demoted by a subsequent search",
			);
		});

		it("URL NOT previously present gets the default summarized visibility", async () => {
			const handler = captureHandler();
			const newUrl = "https://example.com/newpage";
			const setCalls = [];
			const rummy = {
				runId: 1,
				loopId: 1,
				sequence: 5,
				entries: { set: async () => {} },
				getEntries: async (pattern) => {
					if (pattern.startsWith("log://")) return [];
					return []; // URL not previously in DB
				},
				set: async (payload) => setCalls.push(payload),
				getAttributes: async () => null,
				hooks: { error: { log: { emit: async () => {} } } },
			};

			const WebFetcher = (await import("./WebFetcher.js")).default;
			const origSearch = WebFetcher.prototype.search;
			const origFetchAll = WebFetcher.prototype.fetchAll;
			WebFetcher.prototype.search = async () => [
				{ url: newUrl, engine: "brave", title: "T", snippet: "S" },
			];
			WebFetcher.prototype.fetchAll = async () => [
				{
					status: "fulfilled",
					value: {
						title: "Title",
						content: "new body",
						excerpt: "E",
						byline: null,
						siteName: null,
					},
				},
			];

			try {
				await handler(
					{ attributes: { path: "q" }, resultPath: "log://turn_5/search/q" },
					rummy,
				);
			} finally {
				WebFetcher.prototype.search = origSearch;
				WebFetcher.prototype.fetchAll = origFetchAll;
			}

			const pageSet = setCalls.find((c) => c.path === newUrl);
			assert.ok(pageSet);
			assert.strictEqual(pageSet.visibility, "summarized");
		});
	});

	it("no prior searches → gate passes (doesn't short-circuit)", async () => {
		const handler = captureHandler();
		const rummy = makeRummy({ priorSearches: [] });
		// Fetcher will throw past the gate; we only care that no 429 fired.
		await handler(
			{
				attributes: { path: "first query" },
				resultPath: "log://turn_5/search/first%20query",
			},
			rummy,
		).catch(() => {});
		assert.strictEqual(
			rummy._emitted.length,
			0,
			"no error emitted when no prior searches this turn",
		);
	});
});
