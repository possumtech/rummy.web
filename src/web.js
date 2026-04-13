import WebFetcher from "./WebFetcher.js";

const SEARCH_DOCS = `## <search>[query]</search> - Search the web
Example: <search>node.js streams backpressure</search>
Example: <search results="5">SQLite WAL mode</search> (limit results)
* Results are titles and snippets at "summary" fidelity. Use <get> on a result URL to fetch the full page.

## <get>[url]</get> - Fetch a web page
Example: <get>https://en.wikipedia.org/wiki/Mitch_Hedberg</get>
* Fetches entire web page at "full" fidelity`;

export default class RummyWeb {
	#core;
	#fetcher = null;

	constructor(core) {
		this.#core = core;

		const { hooks } = core;

		hooks.tools.ensureTool("search");
		hooks.tools.onHandle("search", this.#handleSearch.bind(this));
		hooks.tools.onView("search", this.#viewSearch.bind(this), "full");

		hooks.tools.onView("http", (entry) => entry.body);
		hooks.tools.onView("http", this.#summaryUrl, "summary");
		hooks.tools.onView("https", (entry) => entry.body);
		hooks.tools.onView("https", this.#summaryUrl, "summary");

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

		const urls = [];
		for (const r of results) {
			const url = WebFetcher.cleanUrl(r.url);
			urls.push(url);
			await rummy.set({
				path: url,
				body: `${r.title}\n${r.snippet}`,
				status: 200,
				fidelity: "summary",
				attributes: {
					query,
					engine: r.engine,
					title: r.title,
					snippet: r.snippet,
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
