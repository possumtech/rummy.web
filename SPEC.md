# @possumtech/rummy.web — Specification

Architectural specification for the rummy web plugin. Covers the plugin contract, entry lifecycle, handler dispatch, and design rationale.

## Plugin Contract

Plugins export a class whose constructor receives a `PluginContext`:

```javascript
export default class RummyWeb {
    #core;
    constructor(core) {
        this.#core = core;
    }
}
```

External plugins load via `RUMMY_PLUGIN_*` env vars:

```env
RUMMY_PLUGIN_WEB=@possumtech/rummy.web
```

The plugin name is derived from the env var key (`RUMMY_PLUGIN_WEB` → `"web"`).

## PluginContext API

### `core.ensureTool()`

Declares the plugin as a model-facing tool. Required for the tool to appear in the model's tool list.

### `core.registerScheme(config?)`

Registers the plugin's scheme in the database:

```javascript
core.registerScheme({
    name: "https",        // defaults to plugin name
    category: "data",     // "data" | "logging" | "unknown" | "prompt"
    scope: "run",         // "run" | "project" | "global"
    writableBy: ["model", "plugin"],
});
```

### `core.on(event, callback, priority?)`

| Event | Payload | Purpose |
|---|---|---|
| `"handler"` | `(entry, rummy)` | Tool handler — scoped to `core.name` |
| `"visible"` | `(entry)` | Visible projection — full body shown |
| `"summarized"` | `(entry)` | Summarized projection — compact view, body hidden |
| `"turn.started"` | `({rummy, mode, prompt, ...})` | Turn beginning |
| `"turn.response"` | `({rummy, turn, result, ...})` | LLM responded |
| `"turn.proposing"` | `({rummy, recorded})` | Tool dispatched |
| `"turn.completed"` | `(turnResult)` | Turn resolved |
| `"entry.created"` | `(entry)` | Entry created during dispatch |
| `"entry.changed"` | `({runId, path, changeType})` | Entry modified |
| Any `"dotted.name"` | varies | Resolves to matching hook |

### `core.filter(name, callback, priority?)`

| Filter | Signature | Purpose |
|---|---|---|
| `"instructions.toolDocs"` | `(docsMap) → docsMap` | Add tool documentation |
| `"assembly.system"` | `(content, ctx) → content` | Contribute to system message |
| `"assembly.user"` | `(content, ctx) → content` | Contribute to user message |
| `"llm.messages"` | `(messages) → messages` | Transform messages before LLM call |
| `"llm.response"` | `(response) → response` | Transform LLM response |

### Cross-Scheme Registration

`core.on("handler")` and `core.on("visible")` register against `core.name`. To register handlers or views on schemes this plugin doesn't own, use `core.hooks` directly:

```javascript
hooks.tools.ensureTool("search");
hooks.tools.onHandle("search", handler);
hooks.tools.onView("search", viewFn, "visible");
hooks.tools.onView("https", viewFn, "summarized");
hooks.tools.onHandle("get", handler, 5);
```

## RummyContext API

Passed to handlers as the second argument. Per-turn scope.

### Tool Verbs

| Method | Effect |
|---|---|
| `rummy.set({ path?, body?, state?, visibility?, outcome?, attributes? })` | Create/update entry. State defaults to `"resolved"`. |
| `rummy.get(path)` | Promote entries matching pattern to `visible` |
| `rummy.rm(path)` | Remove entry |
| `rummy.mv(from, to)` | Rename entry |
| `rummy.cp(from, to)` | Copy entry |
| `rummy.update(body, { status?, attributes? })` | Write lifecycle signal |

### Query Methods

| Method | Returns |
|---|---|
| `rummy.getBody(path)` | Body text or null |
| `rummy.getState(path)` | State (`"proposed"` \| `"streaming"` \| `"resolved"` \| `"failed"` \| `"cancelled"`) or null |
| `rummy.getAttributes(path)` | Parsed attributes `{}` or null |
| `rummy.getEntry(path)` | First matching entry or null |
| `rummy.getEntries(pattern, body?)` | Array of matching entries |
| `rummy.setAttributes(path, attrs)` | Merge attributes |

### Properties

| Property | Type | Description |
|---|---|---|
| `rummy.entries` | Repository proxy | Auto-binds `writer` on writes |
| `rummy.db` | SqlRite db | Database access |
| `rummy.hooks` | Hook registry | Full hook system |
| `rummy.runId` | Number | Current run ID |
| `rummy.projectId` | Number | Current project ID |
| `rummy.sequence` | Number | Current turn number |
| `rummy.loopId` | Number | Current loop ID |
| `rummy.type` | `"ask"` \| `"act"` | Current mode |
| `rummy.writer` | String | Default `"model"` in handler dispatch |
| `rummy.noWeb` | Boolean | Loop flag — web tools disabled |

## Entry System

All model-facing state lives as entries in a unified K/V store keyed by URI-scheme paths.

### Schemes

Web-relevant schemes registered by this plugin:

| Scheme | Category | Description |
|---|---|---|
| `http` | `data` | Fetched web page content |
| `https` | `data` | Fetched web page content |
| `search` | `logging` | Search operation results |

### Visibility

| Visibility | Model Sees |
|---|---|
| `visible` | Full body content in `<knowns>` / `<performed>` |
| `summarized` | Path + token count + summary projection only |

### Entry States

| State | Meaning |
|---|---|
| `resolved` | Operation completed successfully |
| `proposed` | Awaiting client resolution |
| `streaming` | In progress |
| `failed` | Operation failed (outcome carries detail, e.g. `429:rate_limited`) |
| `cancelled` | Operation cancelled |

### Entry Attributes

`https://` entries are created by both `<search>` (archived per candidate, with SearXNG metadata) and `<get>` (visible on demand, Readability-only). The attribute set:

```json
{
    "title": "Page Title",
    "content": "SearXNG's per-result snippet (lxml-extracted upstream)",
    "publishedDate": "2024-08-12T10:00:00",
    "engine": "brave",
    "excerpt": "Readability's first-paragraph excerpt",
    "byline": "Author Name",
    "siteName": "example.com",
    "fetched_at": 1735689600000
}
```

The SearXNG-side fields (`content`, `publishedDate`, `engine`) populate when search archived the entry; they're `null` on direct-`<get>` entries. Readability-side fields (`excerpt`, `byline`, `siteName`) populate from extraction. On stale-refresh via `<get>`, the new Readability fields override their counterparts and SearXNG-side fields are preserved as-is via attribute spread.

`fetched_at` is `Date.now()` at write time. It's the freshness signal for the 10-minute cache check applied by both `<search>` (skip refetch of fresh candidates) and `<get>` (skip refetch of fresh existing entries).

The search log entry (`log://turn_N/search/{slug}`) carries `{ query }` as its attributes. Body is a markdown bullet list — per-result block as `* URL — title (N tokens)` with optional indented `YYYY-MM-DD` date line and the page description.

## RummyWeb Registration

### Constructor

```javascript
constructor(core) {
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
```

All registration is cross-scheme (`core.name` is `"web"`, but it registers on `search`, `get`, `http`, and `https`), so it goes through `core.hooks` directly.

### Handler: `search` (default priority)

1. Extract query from `attrs.path` or `entry.body`.
2. If `rummy.noWeb`, emit a 403 via `rummy.hooks.error.log.emit()` and return.
3. Check per-turn search cap (`RUMMY_WEB_SEARCH_MAX`). If exceeded, emit a 429 via `rummy.hooks.error.log.emit()` and return.
4. Query SearXNG (`/search?q=…&format=json&language=…`).
5. Partition candidates against the cache: for each cleaned URL, look up an existing entry. If one exists and `attributes.fetched_at` is younger than `CACHE_TTL_MS` (10 min), reuse it; otherwise queue for fetch.
6. Fetch the queued (stale or new) URLs in parallel via `fetcher.fetchAll(urls, { timeout: 10000 })` to validate reachability, measure token cost, and capture the body. If everything was cached, the network call is skipped entirely.
7. Drop any freshly-fetched result whose fetch failed (network error) or whose content extraction errored (404, timeout, etc.).
8. For each fresh survivor, archive the body as an `<https>` entry: `path: cleanUrl`, `state: "resolved"`, `visibility: "archived"`, body `# {title}\n\n{content}`, attributes carry the SearXNG-side set (`content`, `publishedDate`, `engine`) plus the Readability-side set (`excerpt`, `byline`, `siteName`) plus `title` and `fetched_at`. Cached survivors are reused as-is — no rewrite.
9. Build the result listing as a markdown bullet list. Each result: `* URL — title (N tokens)`; then an indented `YYYY-MM-DD` date line if `publishedDate` is set; then the description if present. Header reports `valid/total` count when any were dropped. The `*` prefix is load-bearing — it makes the body unambiguously rendered output, not something the model would emit as a tool.
10. Store the listing at `entry.resultPath` with state `"resolved"` and `{ query }` attributes.

A subsequent `<get>` on any listed URL hits the existing-entry short-circuit in the get handler and is promoted to `visible` without a second round trip.

### Handler: `get` (priority 5)

Priority 5 runs before the core get handler at priority 10.

1. Check `attrs.path` matches `/^https?:\/\//`. If not, return (pass to next handler).
2. If the URL is already a known entry **and `attributes.fetched_at` is younger than `CACHE_TTL_MS`**, return — let the core get handler promote the existing entry to `visible` without a network call. Stale entries fall through to step 4.
3. If `rummy.noWeb`, emit a 403 via `rummy.hooks.error.log.emit()` and return.
4. Fetch the page via `WebFetcher.fetch()`.
5. On error: log warning, return.
6. On success: store at state `"resolved"` with markdown body and metadata attributes (including `fetched_at: Date.now()`). Overwrites any prior stale archive at the same path.

### Views

**Visible** (`http`/`https`): pass-through `entry.body` — the full markdown content.

**Summarized** (`http`/`https`): compact card from attributes:
```
## Page Title
2024-08-12 · example.com
Content (or excerpt fallback)
```
Date comes from SearXNG's `publishedDate` (sliced to `YYYY-MM-DD`); publisher comes from Readability's `siteName || byline` since SearXNG doesn't expose a publisher field. The metadata line is omitted entirely if both resolve empty.

**Visible** (`search`): `# search "query"\n{url listing}`

**Summarized** (`search`): the query string only.

### Doc Injection

```javascript
core.filter("instructions.toolDocs", (docsMap) => {
    docsMap.search = SEARCH_DOCS;
    return docsMap;
});
```

Uses the docsMap pattern — the instructions plugin filters by active tool set automatically.

## Handler Priority Chain

```
Dispatch "get" for https://example.com (known entry, fresh)
  Priority 5:  RummyWeb#handleGet — fresh archive, returns (no network)
  Priority 10: Core Get#handler — promotes entry to visible

Dispatch "get" for https://example.com (known entry, stale > 10 min)
  Priority 5:  RummyWeb#handleGet — refetches, overwrites archive
  Priority 10: Core Get#handler — runs on refreshed entry

Dispatch "get" for https://example.com (not yet known)
  Priority 5:  RummyWeb#handleGet — fetches page, stores entry
  Priority 10: Core Get#handler — runs on stored entry

Dispatch "get" for src/app.js
  Priority 5:  RummyWeb#handleGet — not a URL, returns
  Priority 10: Core Get#handler — promotes file entry
```

## Entry Dispatch Lifecycle

### Model Path

```
Model emits <search>query</search>
  → XmlParser produces { name: "search", path: "query" }
  → TurnExecutor records the search entry (resultPath: log://turn_N/search/{slug})
  → hooks.tools.dispatch("search", entry, rummy)
    → RummyWeb#handleSearch fires
    → Honors noWeb (403) and per-turn search cap (429)
    → Partitions candidates: fresh archives (fetched_at < 10 min) reused as-is; stale/new go to fetchAll()
    → Fetches the stale/new subset in parallel to validate + measure tokens
    → Archives each fresh survivor as an <https> entry (visibility: "archived", fetched_at stamped); drops unreachable
    → Stores (* URL — title (N tokens) + optional date + content) bullet listing at entry.resultPath
  → hooks.entry.created.emit(entry)
```

### RPC Path

```
Client sends { method: "get", path: "https://example.com", run: "myrun" }
  → RPC dispatch → Repository
  → hooks.tools.dispatch("get", entry, rummy)
    → Priority 5: RummyWeb#handleGet
    → Priority 10: Core handler
  → Response
```

## WebFetcher Architecture

### Browser and Per-Run Contexts

A single chromium browser is shared across all runs in a fetcher; each run gets its own `BrowserContext` (cookies, localStorage, cache) so there's no cross-run bleed. Contexts are keyed on `rummy.runId` in `WebFetcher#contexts` (a `Map`). The browser stays warm until the 15-minute idle timer fires (`close()`); contexts are released earlier — either at run end (clean) or on abort.

Local launches pass no extra args by default — Playwright's headless mode already injects `--disable-dev-shm-usage`, `--disable-extensions`, `--no-first-run`, and ~30 other automation flags, so duplicating them here would just be ceremony. Opt-in extras: `--no-sandbox` (`RUMMY_WEB_NO_SANDBOX=1`) and `--js-flags=--max-old-space-size=N` (`RUMMY_WEB_CHROMIUM_HEAP_MB=N`). Setting `RUMMY_WEB_PLAYWRIGHT_WS=ws://...` swaps the local launch for `chromium.connect()` against a remote chromium — multiple rummy processes can then share one browser process while still having per-run context isolation.

### Browser Disconnect Recovery

`#getBrowser()` registers a `browser.on("disconnected", …)` listener on every launched/connected `Browser` instance. When chromium dies (OOM, segfault, CDP sidecar teardown), Playwright fires the `disconnected` event and the listener nulls `#browser` and clears `#contexts` so the next operation triggers a fresh launch via the lazy-init path. Without this, the `Browser` handle goes stale and every subsequent `newContext()` would reject opaquely.

The listener guards on `this.#browser === browser` — a late `disconnected` from a previously-replaced browser is a no-op against the new singleton (handles relaunch races cleanly). `#contexts.clear()` skips per-context `close()` calls because their underlying browser is already gone; calling close() would either no-op or reject.

### Run-End Context Cleanup

The plugin constructor subscribes to `hooks.act.completed` and `hooks.ask.completed`. When either fires, the listener calls `WebFetcher#closeContext(runId)`. `runId` on the event payload is a hard contract — a missing runId throws (`"RummyWeb: completed event missing runId"`). This is the clean-shutdown path; it runs whether the run finished normally or was aborted.

### Shutdown via `rummy.signal`

Both `#handleSearch` and `#handleGet` register a one-shot listener on `rummy.signal` (via `#armAbortClose`) that calls `WebFetcher#closeContext(rummy.runId)` when the run is aborted. Closing the context tears down the CDP connection for that context's pages — every in-flight `page.goto` in pages owned by it rejects with "Target … has been closed" within milliseconds. Necessary because `page.goto` honors its own `timeout` opt, not the abort signal: without this, an awaited graceful close during shutdown would block on browser teardown that's itself blocked behind the in-flight goto. The browser process is unaffected; other runs keep working.

The abort listener is removed in a `try/finally` `disarm()` so it never outlives the handler. The run-end listener and the abort listener race; whichever fires first wins, the other becomes a no-op (`closeContext` is idempotent — an unknown runId returns silently). `rummy.signal` is a hard contract; if absent, destructuring it crashes — fail-hard, no fallback.

### `fetch(url, opts?)`

Opens a tab in the run's `BrowserContext` (creating it if needed), navigates, extracts content (HTML branch or non-HTML branch — see `#extract`), closes the tab. Options: `runId` **(required)**, `timeout` (default `FETCH_TIMEOUT`), `waitUntil` (default `"networkidle"`). Throws `"WebFetcher: runId is required"` if `runId` is missing.

### `fetchAll(urls, opts?)`

Opens concurrent tabs in the run's `BrowserContext`. Returns `Promise.allSettled`. Each page logs fetch time and content size. Options: `runId` **(required)**, `timeout` (default 10s — `<search>` uses this to validate candidates and measure token cost; failures are dropped from the listing).

### `closeContext(runId)`

Removes the run's context from the map and fires `BrowserContext.close()` fire-and-forget. Idempotent: calling for an unknown runId returns silently. Called from `#armAbortClose` (on abort) and from the `act.completed` / `ask.completed` listener (on run end).

### `#extract(url, page, response)`

HTTP status check → branch on `Content-Type`:
- **HTML** (`text/html` or `application/xhtml+xml`): inject Readability.js → `page.evaluate()` → Turndown conversion. If Readability returns null, fall through to first 5000 chars of raw HTML.
- **Non-HTML** (everything else — `text/plain`, `application/json`, source files, …): read `document.body.innerText` directly. Title is the URL's basename. `excerpt`/`byline`/`siteName` are null.

The non-HTML branch exists because Chromium doesn't execute scripts on non-HTML documents, so Readability injection is a no-op there; and because Readability against a single `<pre>` of source code is useless even when it does run.

### Search Backends

**SearXNG** (the only backend):
```
GET /search?q=...&format=json&language=en
→ { results: [{ url, title, content, engine, engines, publishedDate, score, category, thumbnail, ... }] }
```

`search()` returns SearXNG's per-result shape verbatim, sliced to `limit`. SearXNG itself federates upstream engines (Brave, DuckDuckGo, Wikipedia, …) and normalizes their output via `extract_text` (lxml) — content arrives already entity-decoded and stripped of highlight markup, so we don't post-process. Per-result `score` and `engines` (set of upstream engines that returned the URL) are SearXNG's quality and cross-engine-agreement signals.

### URL Normalization

URLs are normalized to bytes-friendly hosts before fetch:

| Pattern | Rewrite | Reason |
|---|---|---|
| `*.wikipedia.org/wiki/*` | `*.wikipedia.org/api/rest_v1/page/mobile-html/*` | Pre-cleaned content; eliminates ~40% of noise |
| `github.com/{owner}/{repo}/blob/{ref}/{path}` | `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` | The blob page is a JS-rendered SPA with CSP that blocks Readability; raw serves the file's bytes directly |

### Mobile Device Emulation

All fetches use Playwright's Pixel 5 device profile — mobile user agent, 393x851 viewport, 2.75x device scale.

### URL Cleaning

`WebFetcher.cleanUrl(raw)` strips query params, hash fragments, and trailing slashes.

### Error Handling

| Scenario | Behavior |
|---|---|
| `RUMMY_WEB_SEARXNG_URL` not set | `search()` throws |
| SearXNG returns non-200 | `search()` throws with status |
| Page returns 4xx/5xx | `fetch()` returns `{ error: "HTTP 404" }` |
| Page load timeout | `fetch()` returns `{ error: message }` |
| Readability parse fails | `fetch()` returns first 5000 chars of raw HTML |
| Fetch error in handler | Warning logged, handler returns |
| Per-turn search cap exceeded | Error logged via `hooks.error.log.emit()` with status 429 |
| `rummy.signal` aborts mid-fetch | Plugin calls `WebFetcher#closeContext(runId)` fire-and-forget; `BrowserContext.close()` rejects in-flight `page.goto` within ms; handler's catch returns an error object. Browser stays warm for other runs. |

## Design Decisions

### Token-cost listing on search

Each candidate URL is fetched concurrently (10s timeout) so the listing can show real page token counts instead of snippet tokens (~140) vs. page tokens (~20K). The fetched body is archived as an `<https>` entry (`visibility: "archived"`) keyed by the cleaned URL, so a subsequent `<get>` on a listed result is a pure visibility flip — no second round trip. The trade-off: every reachable candidate's body lives in run state from the moment search returns, even if the model never promotes it. The win: deterministic `<get>` latency and a guarantee that listed URLs are fetchable.

### `<get>` is the universal fetch verb

Pages become run entries through two paths: archived during `<search>` prefetch, or fetched on demand by `<get>` when the URL came from page prose or operator input. `handleGet` short-circuits if the URL is already a known entry **and the archive is fresh** (`fetched_at` within `CACHE_TTL_MS`), deferring to the core handler for promotion; stale or missing entries fall through to a fetch. After search has run, the fresh short-circuit is the common case.

### Per-URL freshness cache (10 min TTL)

A single `CACHE_TTL_MS = 10 * 60 * 1000` constant gates both `<search>` and `<get>`. Every successful fetch (from either path) stamps `attributes.fetched_at = Date.now()` on the archived `<https>` entry. On the next visit, an entry younger than the TTL is reused as-is; older entries are refetched and overwritten. One TTL, one stamp, one predicate (`isFresh`) — applied identically at both entry points so the model never has to reason about cache semantics differing between verbs. Trade-off: a stale page can be served for up to 10 minutes after its first archive; refresh latency is bounded by the TTL, not by anything the model can control.

### Per-turn search cap

Each search fetches and archives every cache-miss candidate and is therefore expensive — both in network time and in run-state size. `RUMMY_WEB_SEARCH_MAX` throttles searches per turn while the overall command cap stays generous for cheap verbs. Exceeding the cap emits an error via the `hooks.error.log` hook with status 429.

### Web entries as `data` category

Fetched pages register as `data` category (alongside files and knowledge), not `logging`. They're persistent content the model carries and reasons about, not ephemeral operation records.

### Per-run browser contexts on a shared chromium

Single chromium browser process; one `BrowserContext` per run, keyed on `rummy.runId`. Each run gets isolated cookies, localStorage, and cache — no cross-run bleed. The chromium subprocess (or remote CDP connection via `RUMMY_WEB_PLAYWRIGHT_WS`) stays warm across all runs. Contexts close at run end via the `act.completed` / `ask.completed` hook subscription; they also close on `rummy.signal` abort to collapse in-flight `page.goto` immediately. 15-minute idle timeout closes everything if no fetch activity.

### URL rewrites for known hostile hosts

Wikipedia's standard pages have deeply interleaved content and metadata; the mobile-html API returns pre-cleaned content (~40% less noise). GitHub's `blob/` view is a JS-rendered SPA whose Content-Security-Policy refuses inline script injection, breaking Readability — and even if it didn't, the SPA chrome would dominate the extraction. Rewriting `github.com/.../blob/...` to `raw.githubusercontent.com` sends the request to the file bytes directly, where the non-HTML extraction branch handles the response. Both rewrites are URL-shape transforms, not response-time fallbacks: the failure case is that the model couldn't read source code at all.

### Mobile device emulation

Pixel 5 profile reduces page weight for sites serving responsive content.

### SearXNG as the single backend

The plugin used to support both SearXNG and Brave Search API directly, choosing between them via `RUMMY_WEB_SEARCH_BACKEND`. That dispatch is gone. SearXNG can itself federate to Brave (and many other engines) upstream and normalize them all into its own `MainResult` shape; we take that as gospel and removed the parallel direct-Brave path. The simplification deletes the API-key plumbing, the dual result-normalization, and a long list of Brave-specific helpers (`normalizeKeywords`, `decodeText`) and entry attributes (`page_age`, `age`, `language`, `content_type`, `subtype`, `profile`, `meta_url`, `keywords`, `extra_snippets`).

## Timeout Cascade

```
RUMMY_WEB_FETCH_TIMEOUT
  ├ WebFetcher.fetch()     — page.goto({ timeout })
  ├ WebFetcher.search()    — fetch({ signal: AbortSignal.timeout() })
  └ WebFetcher.fetchAll()  — default 10000ms per page (overridable)
```

`RUMMY_WEB_FETCH_TIMEOUT` is read from the environment with no hardcoded default — the server is expected to set it. Distinct from `RUMMY_FETCH_TIMEOUT` (rummy core's LLM-side fetch timeout) — these are two different ceilings.

## File Structure

```
src/
├── web.js              — RummyWeb class (plugin entry point)
├── WebFetcher.js       — Playwright fetch + search backends
└── WebFetcher.test.js  — Unit + live integration tests
```

## Dependencies

| Package | Purpose |
|---|---|
| `playwright` | Headless Chromium browser automation + device emulation |
| `@mozilla/readability` | Article content extraction (injected into page via addScriptTag) |
| `turndown` | HTML to Markdown conversion |
