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

	describe("search returns candidates as a single log entry (@plugins_handler_outcomes)", () => {
		it("emits one log entry with (URL, title, snippet, tokens) listing; creates no <https> entries", async () => {
			const handler = captureHandler();
			const setCalls = [];
			const rummy = {
				runId: 1,
				loopId: 1,
				sequence: 5,
				entries: { set: async () => {} },
				getEntries: async (pattern) => {
					if (pattern.startsWith("log://")) return [];
					return [];
				},
				set: async (payload) => setCalls.push(payload),
				getAttributes: async () => null,
				hooks: { error: { log: { emit: async () => {} } } },
			};

			const WebFetcher = (await import("./WebFetcher.js")).default;
			const origSearch = WebFetcher.prototype.search;
			const origFetchAll = WebFetcher.prototype.fetchAll;
			WebFetcher.prototype.search = async () => [
				{
					url: "https://a.example/page",
					engine: "brave",
					title: "Page A",
					snippet: "snippet A",
				},
				{
					url: "https://b.example/page",
					engine: "brave",
					title: "Page B",
					snippet: "snippet B",
				},
			];
			WebFetcher.prototype.fetchAll = async () => [
				{
					status: "fulfilled",
					value: {
						title: "Page A",
						content: "x".repeat(400),
						excerpt: null,
						byline: null,
						siteName: null,
					},
				},
				{
					status: "fulfilled",
					value: {
						title: "Page B",
						content: "y".repeat(800),
						excerpt: null,
						byline: null,
						siteName: null,
					},
				},
			];

			try {
				await handler(
					{
						attributes: { path: "the query" },
						resultPath: "log://turn_5/search/q",
					},
					rummy,
				);
			} finally {
				WebFetcher.prototype.search = origSearch;
				WebFetcher.prototype.fetchAll = origFetchAll;
			}

			const pageWrites = setCalls.filter((c) => c.path?.startsWith("https://"));
			assert.strictEqual(
				pageWrites.length,
				0,
				"search creates no <https> data entries — fetching is <get>'s job",
			);

			const logWrite = setCalls.find((c) => c.path === "log://turn_5/search/q");
			assert.ok(logWrite, "search wrote its log entry");
			assert.ok(
				logWrite.body.includes("https://a.example/page"),
				"first URL listed",
			);
			assert.ok(logWrite.body.includes("Page A"), "title listed");
			assert.ok(logWrite.body.includes("snippet A"), "snippet listed");
			assert.ok(
				logWrite.body.includes("https://b.example/page"),
				"second URL listed",
			);
			assert.ok(
				/\(\d+ tokens\)/.test(logWrite.body),
				"each result lists its token count",
			);
			assert.ok(
				logWrite.body.includes('2 results for "the query"'),
				"header names result count and query",
			);
		});

		it("drops unreachable results from the listing and reports the count", async () => {
			const handler = captureHandler();
			const setCalls = [];
			const rummy = {
				runId: 1,
				loopId: 1,
				sequence: 5,
				entries: { set: async () => {} },
				getEntries: async () => [],
				set: async (payload) => setCalls.push(payload),
				getAttributes: async () => null,
				hooks: { error: { log: { emit: async () => {} } } },
			};

			const WebFetcher = (await import("./WebFetcher.js")).default;
			const origSearch = WebFetcher.prototype.search;
			const origFetchAll = WebFetcher.prototype.fetchAll;
			WebFetcher.prototype.search = async () => [
				{ url: "https://ok.example/page", title: "OK", snippet: "" },
				{ url: "https://gone.example/404", title: "Gone", snippet: "" },
				{ url: "https://timeout.example/page", title: "Slow", snippet: "" },
			];
			WebFetcher.prototype.fetchAll = async () => [
				{
					status: "fulfilled",
					value: { title: "OK", content: "alive", excerpt: null },
				},
				{
					status: "fulfilled",
					value: {
						title: null,
						content: null,
						error: "HTTP 404",
					},
				},
				{
					status: "rejected",
					reason: new Error("timeout"),
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

			const logWrite = setCalls.find((c) => c.path === "log://turn_5/search/q");
			assert.ok(logWrite);
			assert.ok(
				logWrite.body.includes(
					'1 of 3 results for "q" (2 unreachable)',
				),
				"header reports valid/total count and unreachable count",
			);
			assert.ok(logWrite.body.includes("https://ok.example/page"));
			assert.ok(!logWrite.body.includes("https://gone.example/404"));
			assert.ok(!logWrite.body.includes("https://timeout.example/page"));
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
