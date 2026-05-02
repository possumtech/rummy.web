import { createRequire } from "node:module";
import TurndownService from "turndown";

const require = createRequire(import.meta.url);
const READABILITY_PATH = require.resolve("@mozilla/readability/Readability.js");

const WRAP_WIDTH = 80;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

// Encode parens in hrefs so markdown link syntax is unambiguous for the
// word wrap tokenizer. Preserve title attributes as context grounding.
turndown.addRule("safe-links", {
	filter: "a",
	replacement(content, node) {
		const href = node.getAttribute("href");
		if (!href) return content;
		const safeHref = href.replace(/\(/g, "%28").replace(/\)/g, "%29");
		const title = node.getAttribute("title");
		if (title) return `[${content}](${safeHref} "${title}")`;
		return `[${content}](${safeHref})`;
	},
});

turndown.addRule("wrap-paragraphs", {
	filter: "p",
	replacement(content) {
		return `\n\n${wrapText(content.trim(), WRAP_WIDTH)}\n\n`;
	},
});

// Markdown links, images, and inline code are atomic — never split mid-token.
// Hrefs have parens encoded (%28/%29), so the only unescaped ) is the link closer.
// Title strings: [text](url "title with spaces")
const TOKEN_RE =
	/!\[[^\]]*\]\([^)"]*(?:"[^"]*")?[^)]*\)|\[[^\]]*\]\([^)"]*(?:"[^"]*")?[^)]*\)|`[^`]+`|\S+/g;

function wrapText(text, width) {
	const tokens = text.match(TOKEN_RE) || [];
	const lines = [];
	let line = "";
	for (const token of tokens) {
		if (line && line.length + 1 + token.length > width) {
			lines.push(line);
			line = token;
		} else {
			line = line ? `${line} ${token}` : token;
		}
	}
	if (line) lines.push(line);
	return lines.join("\n");
}

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT);
const IDLE_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const SEARCH_BACKEND = process.env.RUMMY_SEARCH;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

// https://en.wikipedia.org/wiki/Foo → mobile-html API for clean content
const WIKI_PATTERN = /^(https?:\/\/[a-z]+\.wikipedia\.org)\/wiki\/(.+)$/;

function toWikiMobileUrl(url) {
	const match = WIKI_PATTERN.exec(url);
	if (!match) return null;
	return `${match[1]}/api/rest_v1/page/mobile-html/${match[2]}`;
}

// https://github.com/{owner}/{repo}/blob/{ref}/{path} → raw.githubusercontent.com.
// The blob page is a JS-rendered SPA whose CSP refuses Readability injection;
// raw serves the file's bytes, which the non-HTML extraction path handles.
const GITHUB_BLOB_PATTERN =
	/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/;

function toGithubRawUrl(url) {
	const match = GITHUB_BLOB_PATTERN.exec(url);
	if (!match) return null;
	return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
}

export default class WebFetcher {
	#browser = null;
	#context = null;
	#launching = null;
	#idleTimer = null;

	/**
	 * Get the persistent browser context, launching Playwright on first
	 * call. The browser + context stay alive across requests (warm DNS,
	 * cache, connections) and shut down after 15 minutes of inactivity.
	 */
	async #getContext() {
		this.#touchIdle();
		if (this.#context) return this.#context;

		if (!this.#browser) {
			if (!this.#launching) {
				this.#launching = (async () => {
					const { chromium } = await import("playwright");
					return chromium.launch({ headless: true });
				})();
			}
			this.#browser = await this.#launching;
			this.#launching = null;
		}

		const { devices } = await import("playwright");
		this.#context = await this.#browser.newContext(devices["Pixel 5"]);
		return this.#context;
	}

	#touchIdle() {
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => this.close(), IDLE_TIMEOUT);
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
	 * Fetch a single page. Opens a tab in the persistent context, extracts
	 * content (Readability + markdown for HTML; raw text for everything
	 * else), closes the tab.
	 */
	async fetch(
		rawUrl,
		{ timeout = FETCH_TIMEOUT, waitUntil = "networkidle" } = {},
	) {
		const url = WebFetcher.cleanUrl(rawUrl);
		const fetchUrl = toWikiMobileUrl(url) || toGithubRawUrl(url) || url;
		const context = await this.#getContext();
		const page = await context.newPage();

		try {
			const response = await page.goto(fetchUrl, { waitUntil, timeout });
			return await this.#extract(url, page, response);
		} catch (err) {
			return { url, title: null, content: null, error: err.message };
		} finally {
			// Browser may already be dead via kill() on abort; tolerate the
			// "Target closed" reject rather than masking the real failure.
			await page.close().catch(() => {});
		}
	}

	/**
	 * Fetch multiple URLs as concurrent tabs in the persistent context.
	 * Shared DNS, cache, and connections across all pages.
	 */
	async fetchAll(urls, { timeout = 10000 } = {}) {
		const context = await this.#getContext();
		return Promise.allSettled(
			urls.map(async (rawUrl) => {
				const url = WebFetcher.cleanUrl(rawUrl);
				const fetchUrl = toWikiMobileUrl(url) || toGithubRawUrl(url) || url;
				const start = Date.now();
				const page = await context.newPage();
				try {
					const response = await page.goto(fetchUrl, {
						waitUntil: "networkidle",
						timeout,
					});
					const result = await this.#extract(url, page, response);
					const elapsed = ((Date.now() - start) / 1000).toFixed(1);
					const size = result.content?.length ?? 0;
					console.log(
						`[RUMMY] Fetched ${url} (${elapsed}s, ${size} chars${result.error ? `, error: ${result.error}` : ""})`,
					);
					return result;
				} catch (err) {
					const elapsed = ((Date.now() - start) / 1000).toFixed(1);
					console.log(
						`[RUMMY] Fetch timeout ${url} (${elapsed}s: ${err.message})`,
					);
					return { url, title: null, content: null, error: err.message };
				} finally {
					await page.close();
				}
			}),
		);
	}

	async #extract(url, page, response) {
		const status = response?.status() ?? 0;
		if (status >= 400)
			return { url, title: null, content: null, error: `HTTP ${status}` };

		// Readability needs an HTML DOM with executable scripts. Non-HTML
		// responses (text/plain source files, JSON, raw configs, …) get the
		// rendered text directly — Chromium wraps text/* in a synthetic
		// <pre>, so document.body.innerText returns the bytes verbatim.
		const contentType = response?.headers()?.["content-type"] || "";
		const isHtml = /^(text\/html|application\/xhtml\+xml)/i.test(contentType);
		if (!isHtml) {
			const text = await page.evaluate(() => document.body?.innerText ?? "");
			const basename =
				new URL(url).pathname.split("/").filter(Boolean).pop() || url;
			return {
				url,
				title: basename,
				content: text,
				excerpt: null,
				byline: null,
				siteName: null,
			};
		}

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
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = null;
		}
		if (this.#context) {
			await this.#context.close().catch(() => {});
			this.#context = null;
		}
		if (this.#browser) {
			await this.#browser.close().catch(() => {});
			this.#browser = null;
		}
		this.#launching = null;
	}

	// Force-cancel for shutdown. `page.goto` honors its own `timeout`
	// opt, not the run's AbortSignal — a graceful awaited close() during
	// shutdown waits on browser teardown blocked behind in-flight gotos
	// and the supervisor's kill deadline expires before run artifacts
	// finish writing. Playwright doesn't expose the chromium subprocess
	// handle (1.59), so we can't SIGKILL directly. Calling close()
	// fire-and-forget tears down the CDP connection: every in-flight
	// goto rejects with "Target page, context or browser has been closed"
	// almost immediately, the handlers' catch blocks return error objects,
	// and shutdown proceeds. The browser process cleanup happens on its
	// own timeline and doesn't block the run.
	kill() {
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = null;
		}
		const browser = this.#browser;
		this.#browser = null;
		this.#context = null;
		this.#launching = null;
		if (browser) {
			// Fire-and-forget: the contract is that in-flight gotos reject
			// promptly (CDP teardown does that synchronously); the close()
			// promise itself races process exit and we don't care about
			// its outcome.
			browser.close({ reason: "rummy run aborted" }).catch(() => {});
		}
	}
}
