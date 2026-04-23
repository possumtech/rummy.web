import WebFetcher from "./WebFetcher.js";

const MAX_SEARCHES_PER_TURN = Number(process.env.RUMMY_WEB_SEARCH_MAX);

const SEARCH_DOCS = `## <search>[query]</search> - Search the web
Example: <search>node.js streams backpressure</search>
Example: <search results="5">SQLite WAL mode</search> (limit results)
* Results are titles and snippets at "summarized" visibility.
* Use <get>https://example.com/page</get> on a result URL to fetch the full page (visible).
* Hard-capped at ${MAX_SEARCHES_PER_TURN} <search> commands per turn; further searches in the same turn are refused.`;

export default class RummyWeb {
	#core;
	#fetcher = null;

	constructor(core) {
		this.#core = core;

		const { hooks } = core;

		hooks.tools.ensureTool("search");
		core.registerScheme({ name: "http", category: "data" });
		core.registerScheme({ name: "https", category: "data" });
		hooks.tools.onHandle("search", this.#handleSearch.bind(this));
		hooks.tools.onView("search", this.#viewSearch.bind(this), "visible");
		hooks.tools.onView("search", this.#summarySearch, "summarized");

		hooks.tools.onView("http", (entry) => entry.body, "visible");
		hooks.tools.onView("http", this.#summaryUrl, "summarized");
		hooks.tools.onView("https", (entry) => entry.body, "visible");
		hooks.tools.onView("https", this.#summaryUrl, "summarized");

		hooks.tools.onHandle("get", this.#handleGet.bind(this), 5);

		core.filter("instructions.toolDocs", (docsMap) => {
			docsMap.search = SEARCH_DOCS;
			return docsMap;
		});
	}

	#getFetcher() {
		this.#fetcher ??= new WebFetcher();
		return this.#fetcher;
	}

	async #handleSearch(entry, rummy) {
		const attrs = entry.attributes || {};
		const query = attrs.path || entry.body;
		if (!query) return;

		// Per-turn search cap. Searches are expensive (each prefetches
		// multiple pages) so they're throttled individually while the
		// overall command cap stays generous for cheap verbs like set/get/rm.
		const priorSearches = await rummy.getEntries(
			`search://turn_${rummy.sequence}/*`,
			null,
		);
		if (priorSearches.length >= MAX_SEARCHES_PER_TURN) {
			await rummy.entries.set({
				runId: rummy.runId,
				turn: rummy.sequence,
				path: entry.resultPath,
				body: "Refused: search cap reached this turn.",
				state: "failed",
				// 429: the conventional rate-limit code. stateToStatus
				// extracts it from outcome and renders as status="429"
				// on the log tag, keeping this refusal consistent with
				// other HTTP-coded failures (overflow:413, permission:403).
				outcome: "429:rate_limited",
				loopId: rummy.loopId,
			});
			return;
		}

		const limit = attrs.results || 12;
		const results = await this.#getFetcher().search(query, { limit });

		// Prefetch all pages in a shared browser context so the model
		// sees real token counts at summarized visibility. Shared context =
		// shared DNS/cache/connections; 5s timeout per page, snippet fallback.
		const fetcher = this.#getFetcher();
		const urls = results.map((r) => WebFetcher.cleanUrl(r.url));
		const fetchStart = Date.now();
		const pages = await fetcher.fetchAll(urls, { timeout: 5000 });
		console.log(
			`[RUMMY] Prefetched ${urls.length} pages in ${((Date.now() - fetchStart) / 1000).toFixed(1)}s`,
		);

		const successUrls = [];
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const url = urls[i];
			const page = pages[i];
			const fetched = page.status === "fulfilled" ? page.value : null;
			const fetchOk = fetched && !fetched.error;

			if (!fetchOk) continue;

			successUrls.push(url);
			const header = fetched.title ? `# ${fetched.title}\n\n` : "";
			await rummy.set({
				path: url,
				body: header + (fetched.content || ""),
				state: "resolved",
				visibility: "summarized",
				attributes: {
					query,
					engine: r.engine,
					title: fetched.title || r.title,
					snippet: r.snippet,
					excerpt: fetched.excerpt,
					byline: fetched.byline,
					siteName: fetched.siteName,
					prefetched: true,
				},
			});
		}

		const listing = successUrls.join("\n");
		await rummy.set({
			path: entry.resultPath,
			body: `${successUrls.length} results for "${query}"\n${listing}`,
			state: "resolved",
			attributes: { query },
		});
	}

	async #handleGet(entry, rummy) {
		const attrs = entry.attributes || {};
		const target = attrs.path;
		if (!target || !/^https?:\/\//.test(target)) return;

		const clean = WebFetcher.cleanUrl(target);

		// If search already prefetched this page, the content is already
		// in the entry — just let the core get handler promote it.
		const existing = await rummy.getAttributes(clean);
		if (existing?.prefetched) return;

		// Not prefetched (direct <get> on a URL) — fetch now.
		let fetched;
		try {
			fetched = await this.#getFetcher().fetch(clean);
		} catch (err) {
			console.warn(`[RUMMY] Fetch crashed: ${clean} — ${err.message}`);
			return;
		}
		if (fetched.error) {
			console.warn(`[RUMMY] Fetch failed: ${clean} — ${fetched.error}`);
			return;
		}

		const header = fetched.title ? `# ${fetched.title}\n\n` : "";
		await rummy.set({
			path: clean,
			body: header + (fetched.content || ""),
			state: "resolved",
			attributes: {
				title: fetched.title,
				excerpt: fetched.excerpt,
				byline: fetched.byline,
				siteName: fetched.siteName,
			},
		});
	}

	#summaryUrl(entry) {
		const { title, excerpt, snippet, byline, siteName } =
			entry.attributes || {};
		const lines = [];
		if (title) lines.push(`## ${title}`);
		if (siteName || byline)
			lines.push([siteName, byline].filter(Boolean).join(" — "));
		if (excerpt || snippet) lines.push(excerpt || snippet);
		return lines.join("\n");
	}

	#viewSearch(entry) {
		const attrs = parseAttrs(entry);
		return `# search "${attrs.query || ""}"\n${entry.body}`;
	}

	#summarySearch(entry) {
		return parseAttrs(entry).query || "";
	}
}

function parseAttrs(entry) {
	if (!entry.attributes) return {};
	return typeof entry.attributes === "string"
		? JSON.parse(entry.attributes)
		: entry.attributes;
}
