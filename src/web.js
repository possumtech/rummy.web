import WebFetcher from "./WebFetcher.js";

const MAX_SEARCHES_PER_TURN = Number(process.env.RUMMY_WEB_SEARCH_MAX) || 1;
const TOKEN_DIVISOR = Number(process.env.RUMMY_TOKEN_DIVISOR) || 4;
// Per-URL cache TTL. An http/https entry whose attributes.fetched_at is
// younger than this is served from the existing archived body — same
// rule for both <get> and search-result paths.
const CACHE_TTL_MS = 10 * 60 * 1000;

function countTokens(text) {
	if (!text) return 0;
	return Math.ceil(text.length / TOKEN_DIVISOR);
}

function isFresh(entry, now = Date.now()) {
	const attrs =
		typeof entry.attributes === "string"
			? JSON.parse(entry.attributes)
			: entry.attributes || {};
	if (!attrs.fetched_at) return false;
	return now - attrs.fetched_at < CACHE_TTL_MS;
}

const SEARCH_DOCS = `## <search>[query]</search> - Search the web (ONE per turn)
Example: <search>node.js streams backpressure</search>
Example: <search results="5">SQLite WAL mode</search> (limit results)
* Results listed in the search's log entry as a markdown bullet list — \`* URL — title (N tokens)\` per candidate, with an indented snippet line beneath. Token count is the page's real cost if you <get> it; use it to pick.
* Unreachable URLs are dropped; the header reports \`N of M results (M-N unreachable)\` when any were filtered.
* Use <get path="https://example.com/page"/> on a result URL to promote it into context (already fetched during search; <get> is a pure promote, no second round trip).
* **ONE \`<search>\` per turn.** Each call returns 5–12 candidate URLs. Additional searches the same turn are refused.`;

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

	// Wire fetcher.kill() to rummy.signal — see WebFetcher#kill for why.
	// Returns a cleanup fn for try/finally so the listener never outlives
	// the handler.
	#armAbortKill(rummy, fetcher) {
		const { signal } = rummy;
		if (signal.aborted) {
			fetcher.kill();
			return () => {};
		}
		const onAbort = () => fetcher.kill();
		signal.addEventListener("abort", onAbort, { once: true });
		return () => signal.removeEventListener("abort", onAbort);
	}

	async #handleSearch(entry, rummy) {
		const attrs = entry.attributes || {};
		const query = attrs.path || entry.body;
		if (!query) return;

		// Honor noWeb: ToolRegistry exclusions are cosmetic (docs hidden
		// from the model) but dispatch still fires if the model emits
		// <search> from a training prior. Bail with a clear refusal so the
		// model gets feedback instead of a silent fetch that contradicts
		// the run's contract.
		if (rummy.noWeb) {
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId: rummy.runId,
				turn: rummy.sequence,
				loopId: rummy.loopId,
				message: `Web access disabled for this run. <search> refused: "${query}".`,
				status: 403,
			});
			return;
		}

		// Path pattern is the log namespace, not the pre-migration
		// `search://` scheme — the old pattern silently never matched.
		const priorSearches = await rummy.getEntries(
			`log://turn_${rummy.sequence}/search/*`,
			null,
		);
		if (priorSearches.length >= MAX_SEARCHES_PER_TURN) {
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId: rummy.runId,
				turn: rummy.sequence,
				loopId: rummy.loopId,
				message: `Only one <search> per turn. Dropped: "${query}". Each search returns 5–12 URLs; refine and re-emit next turn if needed.`,
				status: 429,
			});
			return;
		}

		const limit = attrs.results || 12;
		const fetcher = this.#getFetcher();
		const disarm = this.#armAbortKill(rummy, fetcher);
		try {
			return await this.#runSearch(entry, rummy, fetcher, query, limit);
		} finally {
			disarm();
		}
	}

	async #runSearch(entry, rummy, fetcher, query, limit) {
		const results = await fetcher.search(query, { limit });

		// Fetch each candidate in parallel and STORE the body as an
		// archived run entry. Two consequences: every URL that survives
		// this pass is guaranteed reachable (the model can't pick an
		// unreachable result), and a subsequent <get> on the URL is a
		// pure visibility flip — no second round trip. Pages that don't
		// load within the deadline are dropped from the listing; the
		// header reports the count. The token total guides the model's
		// "which is worth promoting" choice.
		//
		// Cache: any URL already in the run as an archived entry whose
		// attributes.fetched_at is younger than CACHE_TTL_MS is served
		// from the cached body. We skip the network round-trip and reuse
		// the entry verbatim. Stale entries fall through to refetch.
		const urls = results.map((r) => WebFetcher.cleanUrl(r.url));
		const now = Date.now();
		const cached = new Map();
		const toFetch = [];
		for (const url of urls) {
			const existing = await rummy.getEntries(url, null);
			if (existing.length > 0 && isFresh(existing[0], now)) {
				cached.set(url, existing[0]);
			} else {
				toFetch.push(url);
			}
		}
		const fetchedPages =
			toFetch.length > 0
				? await fetcher.fetchAll(toFetch, { timeout: 10000 })
				: [];
		const fetchedByUrl = new Map();
		for (let i = 0; i < toFetch.length; i++) {
			fetchedByUrl.set(toFetch[i], fetchedPages[i]);
		}

		const valid = [];
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const url = urls[i];
			if (cached.has(url)) {
				const e = cached.get(url);
				const eAttrs =
					typeof e.attributes === "string"
						? JSON.parse(e.attributes)
						: e.attributes || {};
				valid.push({
					url,
					title: eAttrs.title || r.title,
					snippet: r.snippet,
					tokens: e.tokens ?? countTokens(e.body),
				});
				continue;
			}
			const page = fetchedByUrl.get(url);
			const fetched = page?.status === "fulfilled" ? page.value : null;
			if (!fetched || fetched.error) continue;
			const titleHeader = fetched.title ? `# ${fetched.title}\n\n` : "";
			await rummy.set({
				path: url,
				body: titleHeader + (fetched.content || ""),
				state: "resolved",
				visibility: "archived",
				attributes: {
					title: fetched.title,
					excerpt: fetched.excerpt,
					byline: fetched.byline,
					siteName: fetched.siteName,
					fetched_at: now,
				},
			});
			valid.push({
				url,
				title: fetched.title || r.title,
				snippet: r.snippet,
				tokens: countTokens(fetched.content),
			});
		}

		const header =
			valid.length === results.length
				? `${results.length} results for "${query}"`
				: `${valid.length} of ${results.length} results for "${query}" (${results.length - valid.length} unreachable)`;
		// Markdown bullet list, NOT XML or tool-shape: leading `*` is the
		// load-bearing signal that this body is rendered output, not
		// anything the model would type as a query. The same URL/title/
		// tokens metadata as before, behind a marker the model has zero
		// training-prior for emitting as a tool.
		const lines = [header];
		for (const r of valid) {
			const head = r.title ? `${r.url} — ${r.title}` : r.url;
			lines.push(`* ${head} (${r.tokens} tokens)`);
			if (r.snippet) lines.push(`  ${r.snippet}`);
		}

		await rummy.set({
			path: entry.resultPath,
			body: lines.join("\n").trimEnd(),
			state: "resolved",
			attributes: { query },
		});
	}

	async #handleGet(entry, rummy) {
		const attrs = entry.attributes || {};
		const target = attrs.path;
		if (!target || !/^https?:\/\//.test(target)) return;

		const clean = WebFetcher.cleanUrl(target);

		// Cache: an existing archived entry whose attributes.fetched_at
		// is younger than CACHE_TTL_MS is served as-is — the core get
		// handler does the visibility flip; we don't refetch. Stale or
		// missing entries fall through to a fresh fetch.
		const existing = await rummy.getEntries(clean, null);
		if (existing.length > 0 && isFresh(existing[0])) return;

		if (rummy.noWeb) {
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId: rummy.runId,
				turn: rummy.sequence,
				loopId: rummy.loopId,
				message: `Web access disabled for this run. <get> on URL refused: ${clean}`,
				status: 403,
			});
			return;
		}

		const fetcher = this.#getFetcher();
		const disarm = this.#armAbortKill(rummy, fetcher);
		let fetched;
		try {
			fetched = await fetcher.fetch(clean);
		} catch (err) {
			console.warn(`[RUMMY] Fetch crashed: ${clean} — ${err.message}`);
			return;
		} finally {
			disarm();
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
				fetched_at: Date.now(),
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
