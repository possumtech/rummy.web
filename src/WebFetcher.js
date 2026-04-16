import { createRequire } from "node:module";
import TurndownService from "turndown";

const require = createRequire(import.meta.url);
const READABILITY_PATH = require.resolve("@mozilla/readability/Readability.js");

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT) || 15000;
const SEARCH_BACKEND = process.env.RUMMY_SEARCH || "searxng";
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";

// https://en.wikipedia.org/wiki/Foo → mobile-html API for clean content
const WIKI_PATTERN = /^(https?:\/\/[a-z]+\.wikipedia\.org)\/wiki\/(.+)$/;

function toWikiMobileUrl(url) {
	const match = WIKI_PATTERN.exec(url);
	if (!match) return null;
	return `${match[1]}/api/rest_v1/page/mobile-html/${match[2]}`;
}

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
		const fetchUrl = toWikiMobileUrl(url) || url;
		const browser = await this.#getBrowser();
		const { devices } = await import("playwright");
		const context = await browser.newContext(devices["Pixel 5"]);
		const page = await context.newPage();

		try {
			const response = await page.goto(fetchUrl, {
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
	 * Search the web. Dispatches to the configured backend.
	 * Returns [{ title, url, snippet, engine }].
	 */
	async search(query, { limit = 12, language = "en" } = {}) {
		if (SEARCH_BACKEND === "brave") return this.#searchBrave(query, { limit });
		return this.#searchSearxng(query, { limit, language });
	}

	async #searchSearxng(query, { limit, language }) {
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

	async #searchBrave(query, { limit }) {
		if (!BRAVE_API_KEY) throw new Error("BRAVE_API_KEY not configured");

		const url = new URL("https://api.search.brave.com/res/v1/web/search");
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(Math.min(limit, 20)));

		const response = await fetch(url, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": BRAVE_API_KEY,
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
		});
		if (!response.ok) {
			throw new Error(`Brave ${response.status}: ${response.statusText}`);
		}
		const data = await response.json();
		return (data.web?.results || []).slice(0, limit).map((r) => ({
			title: r.title,
			url: r.url,
			snippet: r.description || "",
			engine: "brave",
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
