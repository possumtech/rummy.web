import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import WebFetcher from "./WebFetcher.js";

const SEARCH_DOCS = readFileSync(
	fileURLToPath(new URL("./search.md", import.meta.url)),
	"utf8",
);

const MAX_SEARCHES_PER_TURN = Number(process.env.RUMMY_WEB_SEARCH_MAX);
const SEARCH_RESULTS_DEFAULT = Number(process.env.RUMMY_WEB_SEARCH_RESULTS);
const TOKEN_DIVISOR = Number(process.env.RUMMY_TOKEN_DIVISOR);
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

		// Per-run context cleanup: close the run's BrowserContext when the
		// run ends so the next run starts with a fresh cookie jar / cache.
		// Both `act` and `ask` channels fire `completed` for any given run;
		// either path arrives here.
		const onCompleted = ({ runId }) => {
			if (!runId) throw new Error("RummyWeb: completed event missing runId");
			this.#fetcher?.closeContext(runId);
		};
		hooks.act.completed.on(onCompleted);
		hooks.ask.completed.on(onCompleted);
	}

	#getFetcher() {
		this.#fetcher ??= new WebFetcher();
		return this.#fetcher;
	}

	// Close the run's BrowserContext on abort so any in-flight page.goto
	// rejects promptly with "Target closed" instead of blocking on its own
	// timeout — see WebFetcher#closeContext for why. Browser stays warm
	// for other runs. Returns a cleanup fn for try/finally so the listener
	// never outlives the handler.
	#armAbortClose(rummy, fetcher) {
		const { signal, runId } = rummy;
		if (signal.aborted) {
			fetcher.closeContext(runId);
			return () => {};
		}
		const onAbort = () => fetcher.closeContext(runId);
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

		const limit = attrs.results || SEARCH_RESULTS_DEFAULT;
		const fetcher = this.#getFetcher();
		const disarm = this.#armAbortClose(rummy, fetcher);
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
				? await fetcher.fetchAll(toFetch, {
						timeout: 10000,
						runId: rummy.runId,
					})
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
					tokens: e.tokens ?? countTokens(e.body),
					src: r,
				});
				continue;
			}
			const page = fetchedByUrl.get(url);
			const fetched = page?.status === "fulfilled" ? page.value : null;
			if (!fetched || fetched.error) continue;
			const titleHeader = fetched.title ? `# ${fetched.title}\n\n` : "";
			// SearXNG-side fields (content, publishedDate, engine) come from
			// the upstream search result. Readability-side fields (excerpt,
			// byline, siteName) come from extracting the page itself. Both
			// sets persist on the archived entry; #handleGet's stale-refresh
			// preserves SearXNG-side via attribute spread.
			await rummy.set({
				path: url,
				body: titleHeader + (fetched.content || ""),
				state: "resolved",
				visibility: "archived",
				attributes: {
					title: r.title || fetched.title,
					content: r.content || null,
					publishedDate: r.publishedDate || null,
					engine: r.engine || null,
					excerpt: fetched.excerpt,
					byline: fetched.byline,
					siteName: fetched.siteName,
					fetched_at: now,
				},
			});
			valid.push({
				url,
				title: r.title || fetched.title,
				tokens: countTokens(fetched.content),
				src: r,
			});
		}

		const header = `${valid.length} results for "${query}"`;
		// Markdown bullet list, NOT XML or tool-shape: leading `*` is the
		// load-bearing signal that this body is rendered output, not
		// anything the model would type as a query.
		const lines = [header];
		for (const v of valid) {
			lines.push(...renderResult(v));
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
		const disarm = this.#armAbortClose(rummy, fetcher);
		let fetched;
		try {
			fetched = await fetcher.fetch(clean, { runId: rummy.runId });
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
		// Preserve SearXNG-side attributes (content, publishedDate, engine)
		// when refreshing a stale entry. The direct-<get> path has no
		// SearXNG result to draw from, so overwriting attributes wholesale
		// would silently downgrade an entry that was originally archived
		// via <search>.
		const existingAttrs =
			existing.length > 0
				? typeof existing[0].attributes === "string"
					? JSON.parse(existing[0].attributes)
					: existing[0].attributes || {}
				: {};
		await rummy.set({
			path: clean,
			body: header + (fetched.content || ""),
			state: "resolved",
			attributes: {
				...existingAttrs,
				title: fetched.title || existingAttrs.title,
				excerpt: fetched.excerpt,
				byline: fetched.byline,
				siteName: fetched.siteName,
				fetched_at: Date.now(),
			},
		});
	}

	#summaryUrl(entry) {
		const attrs = parseAttrs(entry);
		const lines = [];
		if (attrs.title) lines.push(`## ${attrs.title}`);
		const meta = metadataLine(attrs);
		if (meta) lines.push(meta);
		const desc = attrs.content || attrs.excerpt;
		if (desc) lines.push(desc);
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

// One-line metadata: "2024-08-12 · example.com". Date from SearXNG's
// publishedDate; publisher from Readability (siteName/byline) since
// SearXNG doesn't expose a publisher field. Empty pieces drop; if
// nothing remains the caller skips the line.
function metadataLine(attrs) {
	const parts = [];
	const date = attrs.publishedDate
		? String(attrs.publishedDate).slice(0, 10)
		: null;
	if (date) parts.push(date);
	const publisher = attrs.siteName || attrs.byline;
	if (publisher) parts.push(publisher);
	return parts.length > 0 ? parts.join(" · ") : null;
}

// Per-result block in the search log: bullet line + optional indented
// date line + optional description.
function renderResult({ url, title, tokens, src }) {
	const head = title ? `${url} — ${title}` : url;
	const lines = [`* ${head} (${tokens} tokens)`];
	const date = src?.publishedDate
		? String(src.publishedDate).slice(0, 10)
		: null;
	if (date) lines.push(`  ${date}`);
	if (src?.content) lines.push(`  ${src.content}`);
	return lines;
}
