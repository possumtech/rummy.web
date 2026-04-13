# @possumtech/rummy.web — Specification

Architectural specification for the rummy web plugin. Covers the plugin contract, entry lifecycle, handler dispatch, and design rationale.

## Plugin Contract

Plugins export a class whose constructor receives a `PluginContext`:

```javascript
export default class RummyWeb {
    #core;

    constructor(core) {
        this.#core = core;
        // Register handlers, views, filters via core
    }
}
```

External plugins load via `RUMMY_PLUGIN_*` env vars:

```env
RUMMY_PLUGIN_WEB=@possumtech/rummy.web
```

The plugin loader imports the default export and instantiates with `new Plugin(core)`. The plugin name is derived from the env var key (`RUMMY_PLUGIN_WEB` → `"web"`). Graceful failure if not installed.

Plugins that still export a `static register(hooks)` method are supported for backward compatibility.

## PluginContext API

The `core` object passed to the constructor.

### Registration: `core.on(event, callback, priority?)`

| Event | Purpose |
|---|---|
| `"handler"` | Tool handler — scoped to `core.name` |
| `"full"` | Full projection — scoped to `core.name` |
| `"summary"` | Summary projection — scoped to `core.name` |
| `"turn"` | Turn processor — runs before context materialization |
| `"entry.created"` | Entry created during dispatch |
| `"entry.changed"` | File entries changed on disk |
| Any `"dotted.name"` | Resolves to the matching hook in the hook tree |

### Registration: `core.filter(name, callback, priority?)`

| Filter | Purpose |
|---|---|
| `"instructions.toolDocs"` | Append tool documentation to system prompt |
| `"assembly.system"` | Contribute to system message |
| `"assembly.user"` | Contribute to user message |
| `"llm.messages"` | Transform final messages before LLM call |
| `"llm.response"` | Transform LLM response |
| Any `"dotted.name"` | Resolves to the matching filter in the hook tree |

### Properties

| Property | Type | Description |
|---|---|---|
| `core.name` | String | Plugin name as derived by the loader |
| `core.hooks` | Hooks | Full hook system (for cross-scheme registration) |
| `core.db` | Database | SQLRite prepared statements (available after DB init) |
| `core.entries` | KnownStore | K/V store API (available after DB init) |

### Cross-Scheme Registration

`core.on("handler")` and `core.on("full")` register against `core.name`. To register handlers or views on other schemes, use `core.hooks` directly:

```javascript
core.hooks.tools.ensureTool("search");
core.hooks.tools.onHandle("search", handler);
core.hooks.tools.onView("search", viewFn, "full");
core.hooks.tools.onView("http", viewFn);
core.hooks.tools.onHandle("get", handler, 5);
```

This is the established pattern for plugins that extend tools they don't own (see `file.js` in core).

## RummyContext API

Passed to handlers as the second argument. Per-turn scope.

### Tool Verbs

| Method | Effect |
|---|---|
| `rummy.set({ path, body, status, fidelity, attributes })` | Create/update entry |
| `rummy.get(path)` | Promote to full fidelity |
| `rummy.store(path)` | Demote to stored fidelity |
| `rummy.rm(path)` | Delete permanently |
| `rummy.mv(from, to)` | Move entry |
| `rummy.cp(from, to)` | Copy entry |

### Query Methods

| Method | Returns |
|---|---|
| `rummy.getEntry(path)` | Full entry object |
| `rummy.getBody(path)` | Body text or null |
| `rummy.getState(path)` | State string or null |
| `rummy.getAttributes(path)` | Parsed attributes `{}` |
| `rummy.getEntries(pattern, body?)` | Array of matching entries |

### Properties

| Property | Type | Description |
|---|---|---|
| `rummy.entries` | KnownStore | Direct store access |
| `rummy.db` | Database | SQLRite prepared statements |
| `rummy.runId` | Number | Current run ID |
| `rummy.projectId` | Number | Current project ID |
| `rummy.sequence` | Number | Current turn number |

### Direct Store Access

Handlers may use `rummy.entries` (KnownStore) directly for operations not covered by the verb/query API, such as `upsert` with explicit `runId` and `turn`. This is the established pattern used by core plugins.

## Entry System

All model-facing state lives as entries in a unified K/V store (`known_entries` table) keyed by URI-scheme paths.

### Schemes

Web-relevant schemes and their configuration:

| Scheme | Fidelity | Category | Model Visible |
|---|---|---|---|
| `http` | `full`, `summary`, `stored` | `data` | Yes |
| `https` | `full`, `summary`, `stored` | `data` | Yes |
| `search` | `full` | `logging` | Yes |

### Fidelity and Model Visibility

| Scheme | Fidelity | Model Sees | Role |
|---|---|---|---|
| `http`/`https` | `full` | Full markdown content | Data |
| `http`/`https` | `summary` | Summary content | Data |
| `http`/`https` | `stored` | Invisible (retrievable via `<get>`) | Data |
| `search` | `full` | URL listing | Logging |

### Entry Attributes

Metadata stored as JSON in `entry.attributes`, invisible to the model unless a view function surfaces it:

**Search result entries** (`https://` at `summary`):
```json
{ "query": "the search query", "engine": "bing" }
```

**Fetched URL entries** (`https://` at `full`):
```json
{
    "title": "Page Title",
    "excerpt": "Short description",
    "byline": "Author Name",
    "siteName": "example.com"
}
```

## RummyWeb Registration

### Constructor

```javascript
constructor(core) {
    const { hooks } = core;

    hooks.tools.ensureTool("search");
    hooks.tools.onHandle("search", this.#handleSearch.bind(this));
    hooks.tools.onView("search", this.#viewSearch.bind(this), "full");

    hooks.tools.onView("http", (entry) => entry.body);
    hooks.tools.onView("https", (entry) => entry.body);

    hooks.tools.onHandle("get", this.#handleGet.bind(this), 5);

    core.filter("instructions.toolDocs", (content) =>
        content ? `${content}\n\n${SEARCH_DOCS}` : SEARCH_DOCS,
    );
}
```

All registration is cross-scheme (this plugin's `core.name` is `"web"`, but it registers on `search`, `get`, `http`, and `https`), so it goes through `core.hooks` directly. Doc injection uses `core.filter("instructions.toolDocs")`, the established pattern used by all core plugins.

### Handler: `search` (default priority)

1. Extract query from `attrs.path` or `entry.body`.
2. Query SearXNG via `WebFetcher.search(query, { limit })`.
3. For each result, clean the URL and call `rummy.set()` to create an `https://` entry at `summary` fidelity with `title + snippet` body and `{ query, engine }` attributes.
4. Upsert the result entry at status 200 with the URL listing.

### Handler: `get` (priority 5)

Priority 5 runs before the core get handler at priority 10.

1. Check `attrs.path` matches `/^https?:\/\//`. If not, return (pass to next handler).
2. Check if the URL already exists in the store (deduplication). If found, return.
3. Clean the URL via `WebFetcher.cleanUrl()`.
4. Fetch via `WebFetcher.fetch()` (Playwright + Readability + Turndown).
5. On error: log warning, return (don't stop chain).
6. On success: upsert at `full` fidelity with markdown body and `{ title, excerpt, byline, siteName }` attributes.

### View: `search` (full fidelity)

```javascript
`# search "${attrs.path || ""}"\n${entry.body}`
```

### Views: `http` and `https`

Pass-through: `(entry) => entry.body`. The body is the markdown content itself.

### Doc Injection

```javascript
core.filter("instructions.toolDocs", (content) =>
    content ? `${content}\n\n${SEARCH_DOCS}` : SEARCH_DOCS,
);
```

## Handler Priority Chain

```
Dispatch "get" for https://example.com
  Priority 5:  RummyWeb#handleGet — detects URL, fetches, upserts markdown
  Priority 10: Core Get#handler — skipped (already handled)

Dispatch "get" for src/app.js
  Priority 5:  RummyWeb#handleGet — not a URL, returns (implicit continue)
  Priority 10: Core Get#handler — promotes file entry to full
```

Handler return semantics:
- **Implicit return** (no return value): chain continues to next handler.
- **Return `false`**: stop chain, entry fully handled.

## Entry Dispatch Lifecycle

### Model Path

```
Model emits <search>query</search>
  → XmlParser produces { name: "search", path: "query" }
  → TurnExecutor records search:// entry at "full"
  → hooks.tools.dispatch("search", entry, rummy)
    → RummyWeb#handleSearch fires
    → Creates https:// entries at "summary" via rummy.set()
    → Updates search:// result entry at status 200
  → hooks.entry.created.emit(entry)
```

### RPC Path

```
Client sends { method: "get", path: "https://example.com", run: "myrun" }
  → buildRunContext(hooks, ctx, "myrun")
  → dispatchTool(hooks, rummy, "get", path, "", { path })
    → hooks.tools.dispatch("get", entry, rummy)
      → Priority 5: RummyWeb#handleGet detects URL, fetches, upserts
      → Priority 10: Core handler (skipped)
  → RPC response: { status: "ok" }
```

Both paths use the same dispatch chain.

## WebFetcher Architecture

### Lazy Browser Singleton

```javascript
#browser = null;
#launching = null;

async #getBrowser() {
    if (this.#browser) return this.#browser;
    if (this.#launching) return this.#launching;
    this.#launching = (async () => {
        const { chromium } = await import("playwright");
        this.#browser = await chromium.launch({ headless: true });
        return this.#browser;
    })();
    return this.#launching;
}
```

Playwright startup is ~2s. Lazy initialization means no overhead if web tools are never used. The `#launching` promise prevents concurrent browser launches.

### Fetch Pipeline

```
URL → cleanUrl() → Playwright page.goto() → page.content()
  → JSDOM parse → Readability extract → Turndown to markdown
```

Each fetch creates a fresh browser context (isolated cookies/state), closed in `finally`.

### Search Pipeline

```
query → SearXNG GET /search?q=...&format=json&language=en
  → JSON response → slice to limit → map to { title, url, snippet, engine }
```

Uses global `fetch` with `AbortSignal.timeout(FETCH_TIMEOUT)`.

### URL Cleaning

`WebFetcher.cleanUrl(raw)` strips query params, hash fragments, and trailing slashes:

1. **Cache deduplication**: `?utm_source=x` and `#section` are transient; same content shouldn't be fetched twice.
2. **Path canonicalization**: entries keyed by clean URL are reliably addressable.

### Error Handling

| Scenario | Behavior |
|---|---|
| `RUMMY_SEARXNG_URL` not set | `search()` throws `Error("RUMMY_SEARXNG_URL not configured")` |
| SearXNG returns non-200 | `search()` throws with status code |
| Page load timeout | `fetch()` returns `{ error: message }` |
| Readability parse fails | `fetch()` returns first 5000 chars of raw HTML |
| Fetch error in handler | Warning logged, handler returns (chain continues) |

## Materialization Flow

How web entries reach the model:

1. `TurnExecutor` writes `instructions://system`.
2. `instructions.toolDocs` filters run. RummyWeb's filter appends `SEARCH_DOCS`.
3. `InstructionsPlugin` renders the system prompt with interpolated tool descriptions.
4. `v_model_context` VIEW selects visible entries. Web entries categorize as:
   - `data` (http/https — persistent content the model carries)
   - `logging` (search — records of search operations)
5. `ContextAssembler` places data-category entries in `<knowns>` (system message) and logging-category entries in `<current>`/`<previous>` (user message).

## Design Decisions

### Web entries as scheme-based K/V

Fetched pages use `http://` and `https://` schemes in the same K/V store as files and knowledge. Unified state transitions, consistent visibility rules, deduplication by path, and model transparency — URLs appear alongside files in context.

### Priority 5 for URL interception

The get handler registers at priority 5, before the core get handler at 10. URL detection is scheme-specific and non-contentious. Early exit prevents unnecessary filesystem operations.

### Search results as separate entries

Each search creates one `search://` metadata entry plus individual `http(s)://` entries at `summary` state. Individual entries are deduplicatable and independently fetchable. Each carries the originating query in attributes.

### Lazy browser initialization

Playwright browser launches on first fetch, not at plugin construction. Most agent sessions never use web tools, so this avoids ~2s startup overhead. The singleton pattern with `#launching` promise prevents concurrent launches.

### Attributes for metadata, body for content

Fetch metadata (`title`, `byline`, `excerpt`, `siteName`) lives in `entry.attributes`; the body is pure markdown content. Attributes are invisible to the model unless a view function surfaces them.

### Cross-scheme registration via core.hooks

This plugin registers handlers and views on schemes it doesn't own (`search`, `get`, `http`, `https`). `core.on()` scopes to `core.name` (`"web"`), so cross-scheme work goes through `core.hooks.tools` directly — the same pattern used by the core `file` plugin.

## Timeout Cascade

```
RUMMY_FETCH_TIMEOUT (default 15000 ms)
  ├ WebFetcher.fetch()   — page.goto({ timeout: FETCH_TIMEOUT })
  └ WebFetcher.search()  — fetch({ signal: AbortSignal.timeout(FETCH_TIMEOUT) })
```

## File Structure

```
src/
├── web.js              — RummyWeb class (plugin entry point)
├── WebFetcher.js       — Playwright fetch + SearXNG search
└── WebFetcher.test.js  — Unit tests (cleanUrl)
```

## Dependencies

| Package | Purpose |
|---|---|
| `playwright` | Headless Chromium browser automation |
| `@mozilla/readability` | Article content extraction from HTML |
| `jsdom` | DOM parsing for Readability |
| `turndown` | HTML to Markdown conversion |
