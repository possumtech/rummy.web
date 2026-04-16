import assert from "node:assert";
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
			);
			assert.strictEqual(result.error, "HTTP 404");
			assert.strictEqual(result.content, null);
		});
	});
});
