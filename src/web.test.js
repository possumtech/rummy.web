// Per-turn <search> cap. Path pattern guards the log-namespace
// migration — the pre-migration `search://` glob silently never
// matched, so the cap was dead for weeks.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import RummyWeb from "./web.js";

function captureHandlers() {
	const handlers = {};
	const completedListeners = { act: [], ask: [] };
	const makeEvent = (channel) => ({
		on: (fn) => completedListeners[channel].push(fn),
	});
	const core = {
		hooks: {
			tools: {
				ensureTool: () => {},
				onHandle: (scheme, fn) => {
					handlers[scheme] = fn;
				},
				onView: () => {},
			},
			act: { completed: makeEvent("act") },
			ask: { completed: makeEvent("ask") },
		},
		registerScheme: () => {},
		on: () => {},
		filter: () => {},
	};
	new RummyWeb(core);
	handlers._fireCompleted = (channel, payload) => {
		for (const fn of completedListeners[channel]) fn(payload);
	};
	return handlers;
}

function captureHandler() {
	const h = captureHandlers().search;
	if (!h) throw new Error("search handler not registered");
	return h;
}

function makeRummy({ priorSearches = [] } = {}) {
	const emitted = [];
	const queries = [];
	const upserted = [];
	return {
		runId: 1,
		loopId: 1,
		sequence: 5,
		signal: new AbortController().signal,
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
		it("emits one log entry with (URL, title, snippet, tokens) listing; lands each fetched page as an archived <https> entry", async () => {
			const handler = captureHandler();
			const setCalls = [];
			const rummy = {
				runId: 1,
				loopId: 1,
				sequence: 5,
				signal: new AbortController().signal,
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
					content: "content A",
				},
				{
					url: "https://b.example/page",
					engine: "brave",
					title: "Page B",
					content: "content B",
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
				2,
				"search lands one archived entry per successfully fetched URL",
			);
			for (const w of pageWrites) {
				assert.equal(w.visibility, "archived");
				assert.equal(w.state, "resolved");
				assert.ok(w.body.length > 0, "archived entry carries the fetched body");
			}
			assert.ok(
				pageWrites.some((w) => w.path === "https://a.example/page"),
				"first result archived under its URL",
			);
			assert.ok(
				pageWrites.some((w) => w.path === "https://b.example/page"),
				"second result archived under its URL",
			);

			const logWrite = setCalls.find((c) => c.path === "log://turn_5/search/q");
			assert.ok(logWrite, "search wrote its log entry");
			assert.ok(
				logWrite.body.includes("* https://a.example/page"),
				"first result prefixed with markdown bullet (* URL …)",
			);
			assert.ok(logWrite.body.includes("Page A"), "title listed");
			assert.ok(logWrite.body.includes("content A"), "SearXNG content listed");
			assert.ok(
				logWrite.body.includes("* https://b.example/page"),
				"second result prefixed with markdown bullet",
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

		it("drops unreachable results from the listing", async () => {
			const handler = captureHandler();
			const setCalls = [];
			const rummy = {
				runId: 1,
				loopId: 1,
				sequence: 5,
				signal: new AbortController().signal,
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
				{ url: "https://ok.example/page", title: "OK", content: "" },
				{ url: "https://gone.example/404", title: "Gone", content: "" },
				{ url: "https://timeout.example/page", title: "Slow", content: "" },
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
				logWrite.body.includes('1 results for "q"'),
				"header reports the valid count only — no filter-noise the model doesn't need",
			);
			assert.ok(logWrite.body.includes("https://ok.example/page"));
			assert.ok(!logWrite.body.includes("https://gone.example/404"));
			assert.ok(!logWrite.body.includes("https://timeout.example/page"));

			const pageWrites = setCalls.filter((c) => c.path?.startsWith("https://"));
			assert.deepEqual(
				pageWrites.map((w) => w.path),
				["https://ok.example/page"],
				"only successfully-fetched URLs land as archived entries",
			);
			assert.equal(pageWrites[0].visibility, "archived");
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

// Per-URL cache: an http/https entry younger than CACHE_TTL_MS is served
// from its existing archived body — same rule for both <get> and search.
describe("RummyWeb — http/https cache (10 min TTL)", () => {
	function archivedEntry(url, body, attrs = {}) {
		return {
			path: url,
			body,
			attributes: { title: "cached title", ...attrs },
			tokens: Math.ceil(body.length / 4),
		};
	}

	it("search: fresh URL is served from existing entry (no refetch)", async () => {
		const handler = captureHandler();
		const setCalls = [];
		const fresh = archivedEntry("https://a.example/page", "cached body A", {
			fetched_at: Date.now() - 60_000, // 1 min ago — fresh
		});
		const rummy = {
			runId: 1,
			loopId: 1,
			sequence: 5,
			signal: new AbortController().signal,
			entries: { set: async () => {} },
			getEntries: async (path) => {
				if (path === "https://a.example/page") return [fresh];
				if (path.startsWith("log://")) return [];
				return [];
			},
			set: async (payload) => setCalls.push(payload),
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};

		const WebFetcher = (await import("./WebFetcher.js")).default;
		const origSearch = WebFetcher.prototype.search;
		const origFetchAll = WebFetcher.prototype.fetchAll;
		const fetchAllCalls = [];
		WebFetcher.prototype.search = async () => [
			{ url: "https://a.example/page", title: "A", snippet: "" },
			{ url: "https://b.example/page", title: "B", snippet: "" },
		];
		WebFetcher.prototype.fetchAll = async (urls) => {
			fetchAllCalls.push(urls);
			return [
				{
					status: "fulfilled",
					value: { title: "B", content: "fresh body B", excerpt: null },
				},
			];
		};

		try {
			await handler(
				{ attributes: { path: "q" }, resultPath: "log://turn_5/search/q" },
				rummy,
			);
		} finally {
			WebFetcher.prototype.search = origSearch;
			WebFetcher.prototype.fetchAll = origFetchAll;
		}

		// fetchAll should be called only with stale/missing URL (b), not a
		assert.deepEqual(
			fetchAllCalls,
			[["https://b.example/page"]],
			"cached URL is omitted from the network round-trip",
		);
		// The cached URL doesn't trigger a rummy.set (already exists)
		const aWrites = setCalls.filter((c) => c.path === "https://a.example/page");
		assert.equal(aWrites.length, 0, "cached entry isn't rewritten");
		// b WAS fetched and lands fresh
		const bWrites = setCalls.filter((c) => c.path === "https://b.example/page");
		assert.equal(bWrites.length, 1);
		assert.ok(bWrites[0].attributes.fetched_at, "new fetch stamps fetched_at");
		// Both URLs appear in the listing
		const log = setCalls.find((c) => c.path === "log://turn_5/search/q");
		assert.ok(log.body.includes("https://a.example/page"));
		assert.ok(log.body.includes("https://b.example/page"));
	});

	it("search: stale URL is refetched and upserted", async () => {
		const handler = captureHandler();
		const setCalls = [];
		const stale = archivedEntry("https://a.example/page", "old cached", {
			fetched_at: Date.now() - 11 * 60_000, // 11 min ago — stale
		});
		const rummy = {
			runId: 1,
			loopId: 1,
			sequence: 5,
			signal: new AbortController().signal,
			entries: { set: async () => {} },
			getEntries: async (path) => {
				if (path === "https://a.example/page") return [stale];
				if (path.startsWith("log://")) return [];
				return [];
			},
			set: async (payload) => setCalls.push(payload),
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};

		const WebFetcher = (await import("./WebFetcher.js")).default;
		const origSearch = WebFetcher.prototype.search;
		const origFetchAll = WebFetcher.prototype.fetchAll;
		const fetchAllCalls = [];
		WebFetcher.prototype.search = async () => [
			{ url: "https://a.example/page", title: "A", snippet: "" },
		];
		WebFetcher.prototype.fetchAll = async (urls) => {
			fetchAllCalls.push(urls);
			return [
				{
					status: "fulfilled",
					value: { title: "A", content: "fresh body A", excerpt: null },
				},
			];
		};

		try {
			await handler(
				{ attributes: { path: "q" }, resultPath: "log://turn_5/search/q" },
				rummy,
			);
		} finally {
			WebFetcher.prototype.search = origSearch;
			WebFetcher.prototype.fetchAll = origFetchAll;
		}

		assert.deepEqual(
			fetchAllCalls,
			[["https://a.example/page"]],
			"stale URL IS refetched",
		);
		const aWrites = setCalls.filter((c) => c.path === "https://a.example/page");
		assert.equal(aWrites.length, 1);
		assert.ok(aWrites[0].body.includes("fresh body A"));
		assert.ok(
			aWrites[0].attributes.fetched_at,
			"refetch stamps a new fetched_at",
		);
	});

	it("<get>: fresh URL → no refetch (core get plugin handles promote)", async () => {
		const handlers = captureHandlers();
		const handleGet = handlers.get;
		const setCalls = [];
		const fetchCalls = [];
		const fresh = archivedEntry("https://a.example/page", "cached body", {
			fetched_at: Date.now() - 30_000,
		});
		const rummy = {
			runId: 1,
			loopId: 1,
			sequence: 5,
			signal: new AbortController().signal,
			entries: { set: async () => {} },
			getEntries: async (path) => {
				if (path === "https://a.example/page") return [fresh];
				return [];
			},
			set: async (payload) => setCalls.push(payload),
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};

		const WebFetcher = (await import("./WebFetcher.js")).default;
		const origFetch = WebFetcher.prototype.fetch;
		WebFetcher.prototype.fetch = async (url) => {
			fetchCalls.push(url);
			return { url, title: "A", content: "shouldn't see this" };
		};

		try {
			await handleGet(
				{ attributes: { path: "https://a.example/page" } },
				rummy,
			);
		} finally {
			WebFetcher.prototype.fetch = origFetch;
		}
		assert.deepEqual(fetchCalls, [], "fresh entry skips network");
		assert.equal(setCalls.length, 0, "fresh entry isn't rewritten");
	});

	it("<get>: stale URL → refetches and upserts with new fetched_at", async () => {
		const handlers = captureHandlers();
		const handleGet = handlers.get;
		const setCalls = [];
		const fetchCalls = [];
		const stale = archivedEntry("https://a.example/page", "old", {
			fetched_at: Date.now() - 11 * 60_000,
		});
		const rummy = {
			runId: 1,
			loopId: 1,
			sequence: 5,
			signal: new AbortController().signal,
			entries: { set: async () => {} },
			getEntries: async (path) => {
				if (path === "https://a.example/page") return [stale];
				return [];
			},
			set: async (payload) => setCalls.push(payload),
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};

		const WebFetcher = (await import("./WebFetcher.js")).default;
		const origFetch = WebFetcher.prototype.fetch;
		WebFetcher.prototype.fetch = async (url) => {
			fetchCalls.push(url);
			return { url, title: "A", content: "fresh body" };
		};

		try {
			await handleGet(
				{ attributes: { path: "https://a.example/page" } },
				rummy,
			);
		} finally {
			WebFetcher.prototype.fetch = origFetch;
		}
		assert.deepEqual(
			fetchCalls,
			["https://a.example/page"],
			"stale entry IS refetched",
		);
		assert.equal(setCalls.length, 1);
		assert.ok(setCalls[0].body.includes("fresh body"));
		assert.ok(setCalls[0].attributes.fetched_at);
	});

	it("<get>: missing entry → fetches as before, stamps fetched_at", async () => {
		const handlers = captureHandlers();
		const handleGet = handlers.get;
		const setCalls = [];
		const rummy = {
			runId: 1,
			loopId: 1,
			sequence: 5,
			signal: new AbortController().signal,
			entries: { set: async () => {} },
			getEntries: async () => [],
			set: async (payload) => setCalls.push(payload),
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};
		const WebFetcher = (await import("./WebFetcher.js")).default;
		const origFetch = WebFetcher.prototype.fetch;
		WebFetcher.prototype.fetch = async (url) => ({
			url,
			title: "X",
			content: "first time",
		});
		try {
			await handleGet({ attributes: { path: "https://x.example/p" } }, rummy);
		} finally {
			WebFetcher.prototype.fetch = origFetch;
		}
		assert.equal(setCalls.length, 1);
		assert.ok(
			typeof setCalls[0].attributes.fetched_at === "number",
			"first fetch stamps fetched_at as a number",
		);
	});
});

// rummy.signal abort handling: an in-flight search/get must not stall
// shutdown behind page.goto's own timeout. The plugin closes the run's
// BrowserContext when the signal aborts — collapses in-flight gotos
// promptly, leaves the browser warm for other runs.
describe("RummyWeb — abort signal closes the run's context", () => {
	it("aborting mid-search calls fetcher.closeContext(runId) before search resolves", async () => {
		const handler = captureHandler();
		const controller = new AbortController();
		const rummy = {
			runId: 42,
			loopId: 1,
			sequence: 5,
			signal: controller.signal,
			entries: { set: async () => {} },
			getEntries: async () => [],
			set: async () => {},
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};

		const WebFetcher = (await import("./WebFetcher.js")).default;
		const orig = {
			search: WebFetcher.prototype.search,
			fetchAll: WebFetcher.prototype.fetchAll,
			closeContext: WebFetcher.prototype.closeContext,
		};
		const closeCalls = [];
		// Defer search so we can abort while it's in flight.
		let releaseSearch;
		const searchPromise = new Promise((r) => {
			releaseSearch = r;
		});
		WebFetcher.prototype.search = () => searchPromise;
		WebFetcher.prototype.fetchAll = async () => [];
		WebFetcher.prototype.closeContext = (id) => closeCalls.push(id);

		try {
			const handlerPromise = handler(
				{ attributes: { path: "q" }, resultPath: "log://turn_5/search/q" },
				rummy,
			);
			// Yield once so the handler reaches `await fetcher.search(...)`
			// and has a chance to register the abort listener.
			await Promise.resolve();
			controller.abort();
			assert.deepEqual(
				closeCalls,
				[42],
				"abort fires closeContext exactly once with the run's id",
			);
			releaseSearch([]);
			await handlerPromise;
		} finally {
			WebFetcher.prototype.search = orig.search;
			WebFetcher.prototype.fetchAll = orig.fetchAll;
			WebFetcher.prototype.closeContext = orig.closeContext;
		}
	});

	it("pre-aborted signal closes the run's context synchronously on entry", async () => {
		const handler = captureHandler();
		const controller = new AbortController();
		controller.abort();
		const rummy = {
			runId: 7,
			loopId: 1,
			sequence: 5,
			signal: controller.signal,
			entries: { set: async () => {} },
			getEntries: async () => [],
			set: async () => {},
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};

		const WebFetcher = (await import("./WebFetcher.js")).default;
		const orig = {
			search: WebFetcher.prototype.search,
			fetchAll: WebFetcher.prototype.fetchAll,
			closeContext: WebFetcher.prototype.closeContext,
		};
		const closeCalls = [];
		WebFetcher.prototype.search = async () => [];
		WebFetcher.prototype.fetchAll = async () => [];
		WebFetcher.prototype.closeContext = (id) => closeCalls.push(id);

		try {
			await handler(
				{ attributes: { path: "q" }, resultPath: "log://turn_5/search/q" },
				rummy,
			);
		} finally {
			WebFetcher.prototype.search = orig.search;
			WebFetcher.prototype.fetchAll = orig.fetchAll;
			WebFetcher.prototype.closeContext = orig.closeContext;
		}
		assert.deepEqual(closeCalls, [7]);
	});

	it("disarm removes the listener; aborting after success is a no-op", async () => {
		const handler = captureHandler();
		const controller = new AbortController();
		const rummy = {
			runId: 1,
			loopId: 1,
			sequence: 5,
			signal: controller.signal,
			entries: { set: async () => {} },
			getEntries: async () => [],
			set: async () => {},
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};

		const WebFetcher = (await import("./WebFetcher.js")).default;
		const orig = {
			search: WebFetcher.prototype.search,
			fetchAll: WebFetcher.prototype.fetchAll,
			closeContext: WebFetcher.prototype.closeContext,
		};
		const closeCalls = [];
		WebFetcher.prototype.search = async () => [];
		WebFetcher.prototype.fetchAll = async () => [];
		WebFetcher.prototype.closeContext = (id) => closeCalls.push(id);

		try {
			await handler(
				{ attributes: { path: "q" }, resultPath: "log://turn_5/search/q" },
				rummy,
			);
			controller.abort();
		} finally {
			WebFetcher.prototype.search = orig.search;
			WebFetcher.prototype.fetchAll = orig.fetchAll;
			WebFetcher.prototype.closeContext = orig.closeContext;
		}
		assert.equal(
			closeCalls.length,
			0,
			"abort after handler completion does not fire closeContext",
		);
	});

	it("<get>: aborting mid-fetch calls closeContext(runId) before fetch resolves", async () => {
		const handlers = captureHandlers();
		const handleGet = handlers.get;
		const controller = new AbortController();
		const rummy = {
			runId: 99,
			loopId: 1,
			sequence: 5,
			signal: controller.signal,
			entries: { set: async () => {} },
			getEntries: async () => [],
			set: async () => {},
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};

		const WebFetcher = (await import("./WebFetcher.js")).default;
		const orig = {
			fetch: WebFetcher.prototype.fetch,
			closeContext: WebFetcher.prototype.closeContext,
		};
		const closeCalls = [];
		let releaseFetch;
		const fetchPromise = new Promise((r) => {
			releaseFetch = r;
		});
		WebFetcher.prototype.fetch = () => fetchPromise;
		WebFetcher.prototype.closeContext = (id) => closeCalls.push(id);

		try {
			const handlerPromise = handleGet(
				{ attributes: { path: "https://x.example/p" } },
				rummy,
			);
			await Promise.resolve();
			controller.abort();
			assert.deepEqual(closeCalls, [99]);
			releaseFetch({
				url: "https://x.example/p",
				title: "X",
				content: "body",
			});
			await handlerPromise;
		} finally {
			WebFetcher.prototype.fetch = orig.fetch;
			WebFetcher.prototype.closeContext = orig.closeContext;
		}
	});
});

// Run-end cleanup: when act.completed/ask.completed fires, the plugin
// must close the run's BrowserContext so the next run starts fresh
// (no cross-run cookie / cache leak).
describe("RummyWeb — run-end context cleanup", () => {
	it("act.completed triggers closeContext for the completed run", async () => {
		const handlers = captureHandlers();
		// Force the fetcher to exist (it's lazy) so closeContext is reachable.
		const handleGet = handlers.get;
		const controller = new AbortController();
		const rummy = {
			runId: 200,
			loopId: 1,
			sequence: 5,
			signal: controller.signal,
			entries: { set: async () => {} },
			getEntries: async () => [],
			set: async () => {},
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};
		const WebFetcher = (await import("./WebFetcher.js")).default;
		const orig = {
			fetch: WebFetcher.prototype.fetch,
			closeContext: WebFetcher.prototype.closeContext,
		};
		const closeCalls = [];
		WebFetcher.prototype.fetch = async () => ({
			url: "https://x.example/p",
			title: "X",
			content: "body",
		});
		WebFetcher.prototype.closeContext = (id) => closeCalls.push(id);

		try {
			await handleGet({ attributes: { path: "https://x.example/p" } }, rummy);
			handlers._fireCompleted("act", { runId: 200 });
			assert.deepEqual(closeCalls, [200]);
		} finally {
			WebFetcher.prototype.fetch = orig.fetch;
			WebFetcher.prototype.closeContext = orig.closeContext;
		}
	});

	it("completed event without a runId throws (contract violation)", async () => {
		const handlers = captureHandlers();
		assert.throws(
			() => handlers._fireCompleted("ask", { run: "alias-only" }),
			/missing runId/,
			"plugin treats a missing-runId completed event as a hook contract bug",
		);
	});
});

// SearXNG metadata flows from `search` results through both the
// search-log listing and the per-URL archive attributes.
describe("RummyWeb — SearXNG-shape rendering and refresh", () => {
	it("search log entry renders date + content; archives SearXNG fields alongside Readability ones", async () => {
		const handler = captureHandler();
		const setCalls = [];
		const rummy = {
			runId: 1,
			loopId: 1,
			sequence: 5,
			signal: new AbortController().signal,
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
			{
				url: "https://a.example/page",
				title: "Page A",
				content: "Content A.",
				publishedDate: "2024-08-12T10:00:00",
				engine: "brave",
				engines: ["brave"],
				score: 1.0,
			},
		];
		WebFetcher.prototype.fetchAll = async () => [
			{
				status: "fulfilled",
				value: {
					title: "Readability Title",
					content: "x".repeat(400),
					excerpt: null,
					byline: null,
					siteName: "example.com",
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

		const log = setCalls.find((c) => c.path === "log://turn_5/search/q");
		assert.ok(log, "search wrote its log entry");
		assert.ok(
			log.body.includes("2024-08-12"),
			"date line shows publishedDate (sliced to YYYY-MM-DD)",
		);
		assert.ok(log.body.includes("Content A."), "SearXNG content listed");
		assert.ok(
			log.body.includes("Page A"),
			"SearXNG title wins over Readability title",
		);

		const archived = setCalls.find((c) => c.path === "https://a.example/page");
		assert.ok(archived, "result archived under its URL");
		assert.equal(archived.attributes.title, "Page A");
		assert.equal(archived.attributes.content, "Content A.");
		assert.equal(archived.attributes.publishedDate, "2024-08-12T10:00:00");
		assert.equal(archived.attributes.engine, "brave");
		assert.equal(
			archived.attributes.siteName,
			"example.com",
			"Readability-side fields persisted alongside SearXNG-side ones",
		);
	});

	it("<get> stale-refresh preserves SearXNG-side attributes the new fetch can't know", async () => {
		const handlers = captureHandlers();
		const handleGet = handlers.get;
		const setCalls = [];
		const stale = {
			path: "https://a.example/page",
			body: "old body",
			attributes: {
				title: "Old Title",
				content: "SearXNG content",
				publishedDate: "2024-08-12T10:00:00",
				engine: "brave",
				excerpt: "old excerpt",
				fetched_at: Date.now() - 11 * 60_000,
			},
			tokens: 10,
		};
		const rummy = {
			runId: 1,
			loopId: 1,
			sequence: 5,
			signal: new AbortController().signal,
			entries: { set: async () => {} },
			getEntries: async (path) =>
				path === "https://a.example/page" ? [stale] : [],
			set: async (payload) => setCalls.push(payload),
			getAttributes: async () => null,
			hooks: { error: { log: { emit: async () => {} } } },
		};

		const WebFetcher = (await import("./WebFetcher.js")).default;
		const origFetch = WebFetcher.prototype.fetch;
		WebFetcher.prototype.fetch = async () => ({
			url: "https://a.example/page",
			title: "Refreshed Title",
			content: "refreshed body",
			excerpt: "fresh excerpt",
			byline: null,
			siteName: "example.com",
		});

		try {
			await handleGet(
				{ attributes: { path: "https://a.example/page" } },
				rummy,
			);
		} finally {
			WebFetcher.prototype.fetch = origFetch;
		}

		assert.equal(setCalls.length, 1, "stale entry refreshed once");
		const refreshed = setCalls[0];
		assert.ok(
			refreshed.body.includes("refreshed body"),
			"body comes from the new fetch",
		);
		assert.equal(refreshed.attributes.title, "Refreshed Title");
		assert.equal(refreshed.attributes.excerpt, "fresh excerpt");
		// SearXNG fields the refresh fetch had no way to know — must persist.
		assert.equal(
			refreshed.attributes.content,
			"SearXNG content",
			"SearXNG content preserved across refresh",
		);
		assert.equal(refreshed.attributes.publishedDate, "2024-08-12T10:00:00");
		assert.equal(refreshed.attributes.engine, "brave");
		assert.ok(
			refreshed.attributes.fetched_at > Date.now() - 1000,
			"fetched_at stamped fresh",
		);
	});

	it("metadata line is omitted when no date and no Readability publisher", async () => {
		const handler = captureHandler();
		const setCalls = [];
		const rummy = {
			runId: 1,
			loopId: 1,
			sequence: 5,
			signal: new AbortController().signal,
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
			{
				url: "https://bare.example/page",
				title: "Bare",
				content: "",
				publishedDate: null,
				engine: "duckduckgo",
			},
		];
		WebFetcher.prototype.fetchAll = async () => [
			{
				status: "fulfilled",
				value: {
					title: "Bare",
					content: "x",
					excerpt: null,
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

		const log = setCalls.find((c) => c.path === "log://turn_5/search/q");
		const lines = log.body.split("\n");
		const bullet = lines.findIndex((l) => l.startsWith("* "));
		assert.ok(bullet >= 0, "result bullet present");
		const next = lines[bullet + 1];
		assert.ok(
			next === undefined || next === "" || next.startsWith("* "),
			`expected no metadata indent line after bare bullet, got: ${JSON.stringify(next)}`,
		);
	});
});
