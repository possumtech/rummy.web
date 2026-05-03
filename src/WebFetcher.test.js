import assert from "node:assert";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import WebFetcher, { decodeText, normalizeKeywords } from "./WebFetcher.js";

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

	// schema.org `keywords` reaches us through Brave's `schemas` field
	// in three documented shapes plus structural variation (object vs.
	// array). The walker has to flatten, casefold, trim, and dedup.
	describe("normalizeKeywords", () => {
		it("splits CSV string on commas, lowercases, trims, dedupes", () => {
			const out = normalizeKeywords({
				keywords: "Alpha, BETA ,  alpha , gamma",
			});
			assert.deepEqual(out, ["alpha", "beta", "gamma"]);
		});

		it("normalizes array-of-strings shape", () => {
			const out = normalizeKeywords({ keywords: ["X", "Y", "x"] });
			assert.deepEqual(out, ["x", "y"]);
		});

		it("returns null when no keywords reachable", () => {
			assert.strictEqual(normalizeKeywords(null), null);
			assert.strictEqual(normalizeKeywords(undefined), null);
			assert.strictEqual(normalizeKeywords({ name: "Article" }), null);
			assert.strictEqual(normalizeKeywords({ keywords: "" }), null);
		});

		it("walks an array of schema objects and merges all keywords", () => {
			const out = normalizeKeywords([
				{ "@type": "Article", keywords: "node, streams" },
				{ "@type": "BreadcrumbList" },
				{ "@type": "WebPage", keywords: ["Backpressure", "node"] },
			]);
			assert.deepEqual(out.toSorted(), ["backpressure", "node", "streams"]);
		});

		it("ignores non-string entries inside a keywords array", () => {
			const out = normalizeKeywords({
				keywords: ["valid", 42, null, { nested: "ignored" }, "ok"],
			});
			assert.deepEqual(out, ["valid", "ok"]);
		});
	});

	// Brave returns descriptions and titles with HTML entities
	// (`&amp;`, `&#39;`) and `<strong>` highlight tags around query
	// matches. decodeText is the boundary cleanup.
	describe("decodeText", () => {
		it("strips <strong> and <em> highlight tags", () => {
			assert.equal(
				decodeText("Node.js <strong>streams</strong> and <em>buffers</em>"),
				"Node.js streams and buffers",
			);
		});

		it("decodes named entities Brave actually emits", () => {
			assert.equal(
				decodeText("Tom &amp; Jerry &mdash; &ldquo;hello&rdquo; &hellip;"),
				"Tom & Jerry — “hello” …",
			);
		});

		it("decodes numeric (decimal and hex) entities", () => {
			assert.equal(decodeText("it&#39;s &#x27;ok&#x27;"), "it's 'ok'");
		});

		it("preserves unrecognized entities verbatim", () => {
			assert.equal(decodeText("&unknownentity; stays"), "&unknownentity; stays");
		});

		it("returns empty/null inputs unchanged", () => {
			assert.equal(decodeText(""), "");
			assert.equal(decodeText(null), null);
			assert.equal(decodeText(undefined), undefined);
		});
	});
});
