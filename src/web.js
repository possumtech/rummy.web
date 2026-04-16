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

		// Prefetch all pages concurrently so the model sees real token
		// counts at demoted fidelity. Without this, the model has no way
		// to budget — it sees snippet tokens (140) not page tokens (112K).
		const fetcher = this.#getFetcher();
		const urls = results.map((r) => WebFetcher.cleanUrl(r.url));
		const pages = await Promise.allSettled(
			urls.map((url) => fetcher.fetch(url)),
		);

		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const url = urls[i];
			const page = pages[i];
			const fetched = page.status === "fulfilled" ? page.value : null;
			const fetchOk = fetched && !fetched.error;

			const header = fetchOk && fetched.title ? `# ${fetched.title}\n\n` : "";
			const body = fetchOk
				? header + (fetched.content || "")
				: `${r.title}\n${r.snippet}`;

			await rummy.set({
				path: url,
				body,
				status: 200,
				fidelity: "demoted",
				attributes: {
					query,
					engine: r.engine,
					title: fetchOk ? fetched.title || r.title : r.title,
					snippet: r.snippet,
					excerpt: fetchOk ? fetched.excerpt : null,
					byline: fetchOk ? fetched.byline : null,
					siteName: fetchOk ? fetched.siteName : null,
					prefetched: fetchOk,
				},
			});
		}

		const listing = urls.join("\n");
		await rummy.set({
			path: entry.resultPath,
			body: `${results.length} results for "${query}"\n${listing}`,
			status: 200,
		});
	}

	async #handleGet(entry, rummy) {
		const attrs = entry.attributes || {};
		const target = attrs.path;
		if (!target || !/^https?:\/\//.test(target)) return;

		const clean = WebFetcher.cleanUrl(target);

		// If search already prefetched this page, just promote it.
		const existing = await rummy.getAttributes(clean);
		if (existing?.prefetched) {
			await rummy.setFidelity(clean, "promoted");
			return;
		}

		// Not prefetched (direct <get> on a URL) — fetch now.
		const fetched = await this.#getFetcher().fetch(clean);
		if (fetched.error) {
			console.warn(`[RUMMY] Fetch failed: ${clean} — ${fetched.error}`);
			return;
		}

		const header = fetched.title ? `# ${fetched.title}\n\n` : "";
		await rummy.set({
			path: clean,
			body: header + (fetched.content || ""),
			status: 200,
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
