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

`https://` entries are created by both `<search>` (archived per candidate) and `<get>` (visible on demand). The attribute set is:

```json
{
    "title": "Page Title",
    "excerpt": "Short description",
    "byline": "Author Name",
    "siteName": "example.com",
    "fetched_at": 1735689600000
}
```

`fetched_at` is `Date.now()` at write time. It's the freshness signal for the 10-minute cache check applied by both `<search>` (skip refetch of fresh candidates) and `<get>` (skip refetch of fresh existing entries).

The search log entry (`log://turn_N/search/{slug}`) carries `{ query }` as its attributes; the body is the (URL, title, snippet) candidate listing.

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
4. Query configured search backend (SearXNG or Brave).
5. Partition candidates against the cache: for each cleaned URL, look up an existing entry. If one exists and `attributes.fetched_at` is younger than `CACHE_TTL_MS` (10 min), reuse it; otherwise queue for fetch.
6. Fetch the queued (stale or new) URLs in parallel via `fetcher.fetchAll(urls, { timeout: 10000 })` to validate reachability, measure token cost, and capture the body. If everything was cached, the network call is skipped entirely.
7. Drop any freshly-fetched result whose fetch failed (network error) or whose content extraction errored (404, timeout, etc.).
8. For each fresh survivor, archive the body as an `<https>` entry: `path: cleanUrl`, `state: "resolved"`, `visibility: "archived"`, body `# {title}\n\n{content}`, attributes `{title, excerpt, byline, siteName, fetched_at}`. Cached survivors are reused as-is — no rewrite.
9. Build the result listing as a markdown bullet list — `* URL — title (N tokens)` per survivor with an indented snippet line. Header reports `valid/total` count when any were dropped. The `*` prefix is load-bearing — it makes the body unambiguously rendered output, not something the model would emit as a tool.
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
siteName — Author
Excerpt or search snippet
```

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
    → Stores (* URL — title (N tokens) / snippet) bullet listing at entry.resultPath
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

### Persistent Browser Context

Single browser instance with a persistent context shared across all fetches. Benefits: warm DNS cache, connection reuse, shared cookies. The browser shuts down after 15 minutes of inactivity via idle timer.

### `fetch(url, opts?)`

Opens a tab in the persistent context, navigates, runs Readability, converts to markdown, closes the tab. Options: `timeout` (default `FETCH_TIMEOUT`), `waitUntil` (default `"networkidle"`).

### `fetchAll(urls, opts?)`

Opens concurrent tabs in the shared context. Returns `Promise.allSettled`. Each page logs fetch time and content size. Default timeout: 5s (aggressive — `<search>` uses this to validate candidates and measure token cost; failures are dropped from the listing).

### `#extract(url, page, response)`

Shared extraction logic: HTTP status check → inject Readability.js → `page.evaluate()` → Turndown conversion.

### Search Backends

**SearXNG** (`RUMMY_SEARCH=searxng`):
```
GET /search?q=...&format=json&language=en
→ { results: [{ title, url, content, engine }] }
```

**Brave** (`RUMMY_SEARCH=brave`):
```
GET https://api.search.brave.com/res/v1/web/search?q=...&count=N
Headers: X-Subscription-Token, Accept: application/json
→ { web: { results: [{ title, url, description }] } }
```

Both normalize to `[{ title, url, snippet, engine }]`.

### Wikipedia Optimization

URLs matching `*.wikipedia.org/wiki/*` are rewritten to the mobile-html API:

```
https://en.wikipedia.org/wiki/Foo
→ https://en.wikipedia.org/api/rest_v1/page/mobile-html/Foo
```

### Mobile Device Emulation

All fetches use Playwright's Pixel 5 device profile — mobile user agent, 393x851 viewport, 2.75x device scale.

### URL Cleaning

`WebFetcher.cleanUrl(raw)` strips query params, hash fragments, and trailing slashes.

### Error Handling

| Scenario | Behavior |
|---|---|
| `RUMMY_SEARXNG_URL` not set | `search()` throws |
| `BRAVE_API_KEY` not set | `search()` throws |
| Search backend returns non-200 | `search()` throws with status |
| Page returns 4xx/5xx | `fetch()` returns `{ error: "HTTP 404" }` |
| Page load timeout | `fetch()` returns `{ error: message }` |
| Readability parse fails | `fetch()` returns first 5000 chars of raw HTML |
| Fetch error in handler | Warning logged, handler returns |
| Per-turn search cap exceeded | Error logged via `hooks.error.log.emit()` with status 429 |

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

### Persistent browser context

Single browser context shared across all fetches within a session. Warm DNS, connection reuse, and shared state. 15-minute idle timeout prevents resource leaks.

### Wikipedia mobile-html redirect

Wikipedia's standard pages have deeply interleaved content and metadata. The mobile-html API returns pre-cleaned content — eliminates ~40% of noise.

### Mobile device emulation

Pixel 5 profile reduces page weight for sites serving responsive content.

### Configurable search backends

SearXNG (self-hosted, private) and Brave Search API (hosted, API key) both normalize to the same result shape. Backend selection via `RUMMY_SEARCH` env var.

## Timeout Cascade

```
RUMMY_FETCH_TIMEOUT
  ├ WebFetcher.fetch()     — page.goto({ timeout })
  ├ WebFetcher.search()    — fetch({ signal: AbortSignal.timeout() })
  └ WebFetcher.fetchAll()  — default 10000ms per page (overridable)
```

`RUMMY_FETCH_TIMEOUT` is read from the environment with no hardcoded default — the server is expected to set it.

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
