import WebFetcher from "./WebFetcher.js";

const SEARCH_DOCS = `## <search>[query]</search> - Search the web
Example: <search>node.js streams backpressure</search>
Example: <search results="5">SQLite WAL mode</search> (limit results)
* Results are titles and snippets at "demoted" fidelity.
* Use <get>https://example.com/page</get> on a result URL to fetch the full page (promoted).`;

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
		hooks.tools.onView("search", this.#viewSearch.bind(this), "promoted");

		hooks.tools.onView("http", (entry) => entry.body);
		hooks.tools.onView("http", this.#summaryUrl, "demoted");
		hooks.tools.onView("https", (entry) => entry.body);
		hooks.tools.onView("https", this.#summaryUrl, "demoted");

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

		const limit = attrs.results || 12;
		const results = await this.#getFetcher().search(query, { limit });

		// Prefetch all pages in a shared browser context so the model
		// sees real token counts at demoted fidelity. Shared context =
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
				fidelity: "demoted",
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
		const attrs = entry.attributes || {};
		return `# search "${attrs.path || ""}"\n${entry.body}`;
	}
}
