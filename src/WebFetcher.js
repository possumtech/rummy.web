import { createRequire } from "node:module";
import TurndownService from "turndown";

const require = createRequire(import.meta.url);
const READABILITY_PATH = require.resolve("@mozilla/readability/Readability.js");

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT) || 15000;

export default class WebFetcher {
	#browser = null;
	#launching = null;

	async #getBrowser() {
		if (this.#browser) return this.#browser;
		if (this.#launching) return this.#launching;
		this.#launching = (async () => {
			const { chromium } = await import("playwright");
			this.#browser = await chromium.launch({ headless: true });
			return this.#browser;
		})();
		return this.#launching;
	}

	/**
	 * Strip query params and fragments from a URL.
	 * https://example.com/page?foo=bar#section → https://example.com/page
	 */
	static cleanUrl(raw) {
		const url = new URL(raw);
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	}

	/**
	 * Fetch a URL, extract readable content, convert to markdown.
	 * Runs Readability inside the Playwright page (real browser DOM).
	 */
	async fetch(rawUrl) {
		const url = WebFetcher.cleanUrl(rawUrl);
		const browser = await this.#getBrowser();
		const context = await browser.newContext();
		const page = await context.newPage();

		try {
			const response = await page.goto(url, {
				waitUntil: "networkidle",
				timeout: FETCH_TIMEOUT,
			});
			const status = response?.status() ?? 0;
			if (status >= 400)
				return { url, title: null, content: null, error: `HTTP ${status}` };

			await page.addScriptTag({ path: READABILITY_PATH });
			const article = await page.evaluate(() => {
				const clone = document.cloneNode(true);
				const reader = new Readability(clone);
				const parsed = reader.parse();
				if (!parsed) return null;
				return {
					title: parsed.title,
					content: parsed.content,
					excerpt: parsed.excerpt,
					byline: parsed.byline,
					siteName: parsed.siteName,
				};
			});

			if (!article) {
				const html = await page.content();
				return { url, title: null, content: html.slice(0, 5000) };
			}

			return {
				url,
				title: article.title,
				content: turndown.turndown(article.content),
				excerpt: article.excerpt || null,
				byline: article.byline || null,
				siteName: article.siteName || null,
			};
		} catch (err) {
			return { url, title: null, content: null, error: err.message };
		} finally {
			await context.close();
		}
	}

	/**
	 * Search via SearXNG. Returns array of result objects.
	 */
	async search(query, { limit = 12, language = "en" } = {}) {
		const base = process.env.RUMMY_SEARXNG_URL;
		if (!base) throw new Error("RUMMY_SEARXNG_URL not configured");

		const url = new URL("/search", base);
		url.searchParams.set("q", query);
		url.searchParams.set("format", "json");
		url.searchParams.set("language", language);

		const response = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
		});
		if (!response.ok) {
			throw new Error(`SearXNG ${response.status}: ${response.statusText}`);
		}
		const data = await response.json();
		return (data.results || []).slice(0, limit).map((r) => ({
			title: r.title,
			url: r.url,
			snippet: r.content || "",
			engine: r.engine,
		}));
	}

	async close() {
		if (this.#browser) {
			await this.#browser.close();
			this.#browser = null;
			this.#launching = null;
		}
	}
}
