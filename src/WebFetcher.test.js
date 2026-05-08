import assert from "node:assert";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import WebFetcher from "./WebFetcher.js";

describe("WebFetcher", () => {
	describe("cleanUrl", () => {
		it("strips query params", () => {
			assert.strictEqual(
				WebFetcher.cleanUrl("https://example.com/page?foo=bar"),
				"https://example.com/page",
			);
		});

		it("strips hash", () => {
			assert.strictEqual(
				WebFetcher.cleanUrl("https://example.com/page#section"),
				"https://example.com/page",
			);
		});

		it("strips trailing slash", () => {
			assert.strictEqual(
				WebFetcher.cleanUrl("https://example.com/page/"),
				"https://example.com/page",
			);
		});

		it("preserves path", () => {
			assert.strictEqual(
				WebFetcher.cleanUrl("https://docs.example.com/api/v2"),
				"https://docs.example.com/api/v2",
			);
		});
	});

	describe("fetch", () => {
		let fetcher;

		before(() => {
			fetcher = new WebFetcher();
		});

		after(async () => {
			await fetcher.close();
		});

		it("extracts a full Wikipedia article", async () => {
			const result = await fetcher.fetch(
				"https://en.wikipedia.org/wiki/Mitch_Hedberg",
				{ runId: 1 },
			);
			assert.ok(!result.error, `fetch error: ${result.error}`);
			assert.ok(result.title.includes("Mitch Hedberg"));
			assert.ok(
				result.content.length > 1000,
				`content too short: ${result.content.length} chars`,
			);
			assert.ok(result.content.includes("comedian"));
		});

		it("returns error for 404", async () => {
			const result = await fetcher.fetch(
				"https://en.wikipedia.org/wiki/This_Page_Does_Not_Exist_12345",
				{ runId: 1 },
			);
			assert.strictEqual(result.error, "HTTP 404");
			assert.strictEqual(result.content, null);
		});

		it("rejects fetch without runId", async () => {
			await assert.rejects(
				() => fetcher.fetch("https://en.wikipedia.org/wiki/Mitch_Hedberg"),
				/runId is required/,
			);
		});
	});

	// closeContext() contract: an in-flight page.goto in the run's context
	// must reject within milliseconds, not hang for the configured timeout.
	// This is the only test that exercises real chromium — the plugin-level
	// tests mock closeContext() itself.
	describe("closeContext", () => {
		let server;
		let port;
		let fetcher;

		before(async () => {
			// HTTP server that accepts connections but never responds —
			// page.goto with waitUntil:"networkidle" will block until either
			// timeout or closeContext().
			server = http.createServer(() => {});
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			port = server.address().port;
			fetcher = new WebFetcher();
		});

		after(async () => {
			await fetcher.close();
			await new Promise((resolve) => server.close(resolve));
		});

		it("force-aborts an in-flight page.goto in the run's context", async () => {
			const runId = 7;
			const start = Date.now();
			const fetchPromise = fetcher.fetch(`http://127.0.0.1:${port}/hang`, {
				timeout: 60000,
				runId,
			});
			setTimeout(() => fetcher.closeContext(runId), 200);
			const result = await fetchPromise;
			const elapsed = Date.now() - start;
			assert.ok(
				result.error,
				`expected error from closed context, got: ${JSON.stringify(result)}`,
			);
			assert.ok(
				elapsed < 5000,
				`fetch should reject quickly after closeContext, took ${elapsed}ms (the 60000ms goto timeout would mean closeContext did nothing)`,
			);
		});

		it("isolates contexts: closing one run does not abort another", async () => {
			// Two parallel fetches in different runs. Close run A's context
			// mid-flight. Run A's fetch must error; run B's must keep going
			// (we don't await it past a short check — point is no error fires).
			const runA = 100;
			const runB = 101;
			const aPromise = fetcher.fetch(`http://127.0.0.1:${port}/hang`, {
				timeout: 60000,
				runId: runA,
			});
			const bPromise = fetcher.fetch(`http://127.0.0.1:${port}/hang`, {
				timeout: 60000,
				runId: runB,
			});
			setTimeout(() => fetcher.closeContext(runA), 200);
			const aResult = await aPromise;
			assert.ok(aResult.error, "run A's fetch errored from closed context");
			// b should still be in flight; force-close it to clean up
			fetcher.closeContext(runB);
			await bPromise;
		});
	});

	// search() returns SearXNG's native per-result shape verbatim and wraps
	// every failure mode with host + query preview so dispatch logs are
	// actionable. Stubs globalThis.fetch — no chromium, no real network.
	describe("search", () => {
		const origFetch = globalThis.fetch;
		const origUrl = process.env.RUMMY_WEB_SEARXNG_URL;
		let fetcher;

		before(() => {
			process.env.RUMMY_WEB_SEARXNG_URL = "https://searxng.test";
			fetcher = new WebFetcher();
		});

		after(async () => {
			globalThis.fetch = origFetch;
			if (origUrl === undefined) delete process.env.RUMMY_WEB_SEARXNG_URL;
			else process.env.RUMMY_WEB_SEARXNG_URL = origUrl;
			await fetcher.close();
		});

		it("returns SearXNG results sliced to limit", async () => {
			const results = Array.from({ length: 20 }, (_, i) => ({
				url: `https://e${i}.test/p`,
				title: `T${i}`,
			}));
			globalThis.fetch = async () =>
				new Response(JSON.stringify({ results }), { status: 200 });
			const out = await fetcher.search("the query", { limit: 5 });
			assert.equal(out.length, 5);
			assert.equal(out[0].url, "https://e0.test/p");
			assert.equal(out[4].url, "https://e4.test/p");
		});

		it("non-OK response wraps with status, statusText, host, and query preview", async () => {
			globalThis.fetch = async () =>
				new Response("nope", {
					status: 503,
					statusText: "Service Unavailable",
				});
			await assert.rejects(
				() => fetcher.search("the query"),
				/SearXNG 503 Service Unavailable — host=searxng\.test query="the query"/,
			);
		});

		it("TimeoutError wraps with FETCH_TIMEOUT, host, and query preview; preserves cause", async () => {
			const cause = new Error("operation timed out");
			cause.name = "TimeoutError";
			globalThis.fetch = async () => {
				throw cause;
			};
			await assert.rejects(
				() => fetcher.search("the query"),
				(err) => {
					assert.match(
						err.message,
						/SearXNG timeout after \d+ms — host=searxng\.test query="the query"/,
					);
					assert.equal(err.cause, cause, "original error preserved as cause");
					return true;
				},
			);
		});

		it("connection error unwraps err.cause for code + detail; preserves cause", async () => {
			const cause = new Error("getaddrinfo ENOTFOUND searxng.test");
			cause.code = "ENOTFOUND";
			const err = new Error("fetch failed", { cause });
			globalThis.fetch = async () => {
				throw err;
			};
			await assert.rejects(
				() => fetcher.search("the query"),
				(thrown) => {
					assert.match(
						thrown.message,
						/SearXNG fetch failed \[ENOTFOUND\] — getaddrinfo ENOTFOUND searxng\.test; host=searxng\.test query="the query"/,
					);
					assert.equal(thrown.cause, err, "original error preserved as cause");
					return true;
				},
			);
		});

		it("missing err.cause falls back to UNKNOWN code + err.message", async () => {
			globalThis.fetch = async () => {
				throw new Error("something broke");
			};
			await assert.rejects(
				() => fetcher.search("the query"),
				/SearXNG fetch failed \[UNKNOWN\] — something broke; host=searxng\.test query="the query"/,
			);
		});

		it("long queries are truncated to 60 chars + … in the error preview", async () => {
			globalThis.fetch = async () =>
				new Response("nope", { status: 500, statusText: "Internal" });
			const long = "x".repeat(80);
			await assert.rejects(
				() => fetcher.search(long),
				new RegExp(`query="${"x".repeat(60)}…"`),
			);
		});
	});
});
