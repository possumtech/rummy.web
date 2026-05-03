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

const FETCH_TIMEOUT = Number(process.env.RUMMY_WEB_FETCH_TIMEOUT);
const IDLE_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const SEARCH_BACKEND = process.env.RUMMY_WEB_SEARCH_BACKEND;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
// Connect to a remote chromium via CDP instead of launching a local one.
// Lets multiple rummy processes share a single chromium; each process
// still opens its own BrowserContext per run for isolation.
const PLAYWRIGHT_WS = process.env.RUMMY_WEB_PLAYWRIGHT_WS;
// Drop chromium's user-namespace sandbox. Avoids "no usable sandbox"
// errors in containers that lack the namespaces; mild security tradeoff,
// off by default.
const NO_SANDBOX = process.env.RUMMY_WEB_NO_SANDBOX === "1";
// Cap chromium's V8 old-space heap (MB). Useful on memory-constrained
// hosts where chromium's default would crowd out other workloads.
const CHROMIUM_HEAP_MB = Number(process.env.RUMMY_WEB_CHROMIUM_HEAP_MB);

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
	// One BrowserContext per run. Cookies, localStorage, and cache are
	// scoped to the run that opened the context — no cross-run bleed.
	// Keyed on rummy.runId; closed by closeContext() when the run ends
	// or aborts. Browser process stays warm across all of them.
	#contexts = new Map();
	#launching = null;
	#idleTimer = null;

	/**
	 * Get or launch the chromium browser. Connects to a remote one via
	 * RUMMY_WEB_PLAYWRIGHT_WS if set; otherwise launches locally with
	 * docker-friendly chromium args. Single browser shared across all
	 * runs in this fetcher; per-run isolation is at the context layer.
	 */
	async #getBrowser() {
		this.#touchIdle();
		if (this.#browser) return this.#browser;
		if (!this.#launching) {
			this.#launching = (async () => {
				const { chromium } = await import("playwright");
				if (PLAYWRIGHT_WS) return chromium.connect(PLAYWRIGHT_WS);
				const args = ["--disable-gpu", "--disable-dev-shm-usage"];
				if (NO_SANDBOX) args.push("--no-sandbox");
				if (CHROMIUM_HEAP_MB) {
					args.push(`--js-flags=--max-old-space-size=${CHROMIUM_HEAP_MB}`);
				}
				return chromium.launch({ headless: true, args });
			})();
		}
		this.#browser = await this.#launching;
		this.#launching = null;
		return this.#browser;
	}

	/**
	 * Get-or-create the BrowserContext for `runId`. Each run gets a
	 * fresh cookie jar / cache / localStorage; cleared at run end via
	 * closeContext().
	 */
	async #getContext(runId) {
		if (!runId) throw new Error("WebFetcher: runId is required");
		this.#touchIdle();
		if (this.#contexts.has(runId)) return this.#contexts.get(runId);
		const browser = await this.#getBrowser();
		const { devices } = await import("playwright");
		const ctx = await browser.newContext(devices["Pixel 5"]);
		this.#contexts.set(runId, ctx);
		return ctx;
	}

	/**
	 * Drop the run's BrowserContext. Closing the context cascades to
	 * any in-flight page.goto in pages owned by it — they reject with
	 * "Target closed", handlers' catch blocks return error objects,
	 * shutdown unblocks. Fire-and-forget; the close() promise itself
	 * is allowed to resolve at its own pace.
	 *
	 * Called both at run end (clean cleanup hook) and on abort
	 * (rummy.signal listener in the plugin).
	 */
	closeContext(runId) {
		const ctx = this.#contexts.get(runId);
		if (!ctx) return;
		this.#contexts.delete(runId);
		ctx.close().catch(() => {});
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
	 * Fetch a single page. Opens a tab in the run's context, extracts
	 * content (Readability + markdown for HTML; raw text for everything
	 * else), closes the tab.
	 */
	async fetch(
		rawUrl,
		{ timeout = FETCH_TIMEOUT, waitUntil = "networkidle", runId } = {},
	) {
		const url = WebFetcher.cleanUrl(rawUrl);
		const fetchUrl = toWikiMobileUrl(url) || toGithubRawUrl(url) || url;
		const context = await this.#getContext(runId);
		const page = await context.newPage();

		try {
			const response = await page.goto(fetchUrl, { waitUntil, timeout });
			return await this.#extract(url, page, response);
		} catch (err) {
			return { url, title: null, content: null, error: err.message };
		} finally {
			// Context may already be torn down via closeContext() on abort
			// or run-end; tolerate the "Target closed" reject rather than
			// masking the real failure.
			await page.close().catch(() => {});
		}
	}

	/**
	 * Fetch multiple URLs as concurrent tabs in the run's context.
	 * Shared DNS, cache, and connections across all pages within the run.
	 */
	async fetchAll(urls, { timeout = 10000, runId } = {}) {
		const context = await this.#getContext(runId);
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
	 * Search the web. Dispatches to the configured backend. Both backends
	 * return the same shape; Brave-only fields are null when unavailable
	 * (e.g. SearXNG path, or per-result when Brave didn't supply them).
	 *
	 * Returns [{
	 *   url, title, description,
	 *   page_age, age, language, content_type, subtype,
	 *   profile, meta_url, keywords, engine
	 * }].
	 *
	 * `description` is decoded — HTML entities resolved and `<strong>`
	 * highlight tags stripped — at this boundary so callers handle plain
	 * text.
	 */
	async search(query, { limit = 12, language = "en" } = {}) {
		if (SEARCH_BACKEND === "brave") return this.#searchBrave(query, { limit });
		return this.#searchSearxng(query, { limit, language });
	}

	async #searchSearxng(query, { limit, language }) {
		const base = process.env.RUMMY_WEB_SEARXNG_URL;
		if (!base) throw new Error("RUMMY_WEB_SEARXNG_URL not configured");

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
			url: r.url,
			title: r.title,
			description: decodeText(r.content || ""),
			page_age: null,
			age: null,
			language: null,
			content_type: null,
			subtype: null,
			profile: null,
			meta_url: null,
			keywords: null,
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
			url: r.url,
			title: r.title,
			description: decodeText(r.description || ""),
			page_age: r.page_age || null,
			age: r.age || null,
			language: r.language || null,
			content_type: r.content_type || null,
			subtype: r.subtype || null,
			profile: r.profile || null,
			meta_url: r.meta_url || null,
			keywords: normalizeKeywords(r.schemas),
			engine: "brave",
		}));
	}

	/**
	 * Tear everything down: all per-run contexts then the browser. Called
	 * by the 15-min idle timer and by tests at teardown. In CDP mode
	 * browser.close() disconnects the local handle without shutting the
	 * remote chromium down, so this is safe in both shapes.
	 */
	async close() {
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = null;
		}
		const contexts = [...this.#contexts.values()];
		this.#contexts.clear();
		await Promise.allSettled(contexts.map((c) => c.close()));
		if (this.#browser) {
			await this.#browser.close().catch(() => {});
			this.#browser = null;
		}
		this.#launching = null;
	}
}

// schema.org `keywords` ships in three documented shapes (string with
// commas, array of strings, absent) and Brave returns the parent
// `schemas` field as either an object or an array of objects depending
// on what the page emits. Walk the structure, collect any string value
// reached via a `keywords` key, casefold + trim + dedup. Exported only
// for testability.
export function normalizeKeywords(schemas) {
	if (!schemas) return null;
	const collected = new Set();
	const visit = (node) => {
		if (!node) return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (typeof node !== "object") return;
		const kw = node.keywords;
		if (typeof kw === "string") {
			for (const tag of kw.split(",")) {
				const t = tag.trim().toLowerCase();
				if (t) collected.add(t);
			}
		} else if (Array.isArray(kw)) {
			for (const tag of kw) {
				if (typeof tag !== "string") continue;
				const t = tag.trim().toLowerCase();
				if (t) collected.add(t);
			}
		}
	};
	visit(schemas);
	return collected.size > 0 ? [...collected] : null;
}

// Brave returns descriptions with HTML entities (`&amp;`, `&#39;`,
// `&hellip;`) and `<strong>` highlight tags around query matches. Both
// are noise in the markdown listing — strip the tags, decode the
// entities. Covers the named entities Brave actually emits plus numeric
// (`&#39;`, `&#x27;`) for anything else. Exported only for testability.
const NAMED_ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
};
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;
const HIGHLIGHT_RE = /<\/?(?:strong|em|b|i)>/gi;

export function decodeText(text) {
	if (!text) return text;
	return text
		.replace(HIGHLIGHT_RE, "")
		.replace(ENTITY_RE, (m, dec, hex, name) => {
			if (dec) return String.fromCodePoint(Number(dec));
			if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
			return NAMED_ENTITIES[name?.toLowerCase()] ?? m;
		});
}
