# @possumtech/rummy.web — Specification

Architectural specification for the rummy web plugin. Covers the plugin contract, entry lifecycle, handler dispatch, and design rationale.

## Plugin Contract (v0.2)

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

The plugin loader scans directories for `.js` files, imports the default export, and instantiates with `new Plugin(core)`. The plugin name is derived from the filename (`web.js` → `"web"`). Built-in plugins load first (`src/plugins/`), then user plugins (`~/.rummy/plugins/`). Test files (`*.test.js`) are skipped.

Plugins that still export a `static register(hooks)` method are supported for backward compatibility.

## PluginContext API

The `core` object passed to the constructor:

### Properties

| Property | Type | Description |
|---|---|---|
| `core.name` | String | Plugin name as derived by the loader |
| `core.hooks` | Hooks | Full hook system (for cross-scheme registration) |
| `core.db` | Database | SQLRite prepared statements (available after DB init) |
| `core.entries` | KnownStore | K/V store API (available after DB init) |

### `core.on(event, callback, priority)`

Registers a named callback scoped to the plugin's own tool name:

| Event | Resolves to |
|---|---|
| `"handler"` | `hooks.tools.onHandle(core.name, callback, priority)` |
| `"full"` | `hooks.tools.onView(core.name, callback, "full")` |
| `"summary"` | `hooks.tools.onView(core.name, callback, "summary")` |
| Any other | Walks `hooks` by dot-path (e.g. `"entry.changed"` → `hooks.entry.changed.on(fn)`) |

### `core.filter(name, callback, priority)`

Registers a filter callback. Walks `hooks` by dot-path to find the filter.

| Filter | Purpose |
|---|---|
| `"instructions.toolDocs"` | Append tool documentation to system prompt |
| `"llm.response"` | Transform LLM response |
| `"assembly.system"` | Add sections to system message |
| `"assembly.user"` | Add sections to user message |

### Cross-Scheme Registration

`core.on("handler")` and `core.on("full")` register against `core.name`. To register handlers or views on other schemes, use `core.hooks` directly:

```javascript
core.hooks.tools.ensureTool("search");
core.hooks.tools.onHandle("search", handler);
core.hooks.tools.onView("search", viewFn, "full");
core.hooks.tools.onView("http", viewFn);
core.hooks.tools.onHandle("get", handler, 5);
```

## RummyContext API

Passed to all handlers as the second argument. Provides unified access to the current turn.

### Properties

| Property | Type | Description |
|---|---|---|
| `rummy.hooks` | Hooks | Full hook system reference |
| `rummy.db` | Database | SQLRite prepared statement collection |
| `rummy.entries` | KnownStore | K/V store API |
| `rummy.project` | Object | Current project metadata |
| `rummy.type` | String | Turn mode: `"ask"` or `"act"` |
| `rummy.sequence` | Number | Current turn number |
| `rummy.runId` | Number | Current run ID |
| `rummy.contextSize` | Number | Token budget |

### Tool Methods

Same operations available to the model via XML tags:

```javascript
await rummy.set({ path, body, state, attributes })
await rummy.get(path)
await rummy.store(path)
await rummy.rm(path)
await rummy.mv(from, to)
await rummy.cp(from, to)
```

### Plugin-Only Methods

```javascript
rummy.entries                       // Direct KnownStore access
rummy.getAttributes(path)           // Read entry attributes JSON
rummy.getEntries(pattern, body?)    // Pattern query
rummy.log(message)                  // Audit log
```

## KnownStore API

The entry store used by `rummy.entries`:

```javascript
await store.upsert(runId, turn, path, body, state, { attributes, hash })
await store.getBody(runId, path)
await store.getAttributes(runId, path)
await store.getEntriesByPattern(runId, pattern, body?, { limit, offset })
await store.slugPath(runId, scheme, content)
await store.promote(runId, path, turn)
await store.demote(runId, path)
await store.remove(runId, path)
```

## Entry System

All model-facing state lives as entries in a unified K/V store (`known_entries` table) keyed by URI-scheme paths.

### Schemes

Web-relevant schemes and their configuration:

| Scheme | Fidelity | Valid States | Category | Model Visible |
|---|---|---|---|---|
| `http` | `turn` | `full`, `summary`, `stored` | `file` | Yes |
| `https` | `turn` | `full`, `summary`, `stored` | `file` | Yes |
| `search` | `full` | `full`, `info` | `result` | Yes |

### States and Model Visibility

| Scheme | State | Model Sees | Context Category |
|---|---|---|---|
| `http`/`https` | `full` | Full markdown content | `file` |
| `http`/`https` | `summary` | Summary content | `file_summary` |
| `http`/`https` | `stored` | Path listed only | `file_index` |
| `search` | `full` | URL listing | `result` |
| `search` | `info` | Result count + URLs | `result` |

State transitions are enforced by database triggers against the `valid_states` column in the `schemes` table.

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

All registration happens in the constructor via `core.hooks` (cross-scheme) and `core.filter` (doc injection).

### Tool: `search`

Registered via `hooks.tools.ensureTool("search")` with a handler, view, and doc filter.

### Views: `http` and `https`

```javascript
hooks.tools.onView("http", (entry) => entry.body);
hooks.tools.onView("https", (entry) => entry.body);
```

Pass-through: body is the markdown content itself.

### Doc Injection

```javascript
core.filter("instructions.toolDocs", (content) =>
    content ? `${content}\n\n${SEARCH_DOCS}` : SEARCH_DOCS,
);
```

The framework calls `instructions.toolDocs` filters during materialization. No `onTurn` hook needed.

### Handler: `search` (default priority)

1. Extract query from `attrs.path` or `entry.body`.
2. Query SearXNG via `WebFetcher.search(query, { limit })`.
3. For each result, clean the URL and create an `https://` entry at `summary` state with `title + snippet` body and `{ query, engine }` attributes.
4. Update the `search://` result entry to `info` state with the URL listing.

### Handler: `get` (priority 5)

Priority 5 runs before the core get handler at priority 10.

1. Check `attrs.path` matches `/^https?:\/\//`. If not, return (pass to next handler).
2. Check if the URL already exists in the store (deduplication). If found, return.
3. Clean the URL via `WebFetcher.cleanUrl()`.
4. Fetch via `WebFetcher.fetch()` (Playwright + Readability + Turndown).
5. On error: log warning, return (don't stop chain).
6. On success: upsert at `full` state with markdown body and `{ title, excerpt, byline, siteName }` attributes.

## Handler Priority Chain

```
Dispatch "get" for https://example.com
  Priority 5:  RummyWeb — detects URL, fetches, upserts markdown
  Priority 10: Core get — skipped (RummyWeb already handled)

Dispatch "get" for src/app.js
  Priority 5:  RummyWeb — not a URL, returns (implicit continue)
  Priority 10: Core get — promotes file entry to full
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
    → Creates https:// entries at "summary"
    → Updates search:// entry to "info" with listing
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

Both paths use the same dispatch chain. RPC clients bypass mode enforcement but share the handler pipeline.

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

`WebFetcher.cleanUrl(raw)` strips query params, hash fragments, and trailing slashes. This serves two purposes:

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

1. `TurnExecutor.execute()` writes `instructions://system`.
2. The framework runs `instructions.toolDocs` filters. RummyWeb's filter appends `SEARCH_DOCS`.
3. `InstructionsPlugin` renders the system prompt with interpolated tool descriptions.
4. `v_model_context` VIEW selects visible entries. Web entries categorize as:
   - `file` (http/https at full or summary state)
   - `file_index` (http/https at stored state)
   - `result` (search entries)
5. `ContextAssembler` places file-category entries in the system message context section and result-category entries in user message tool results.

## Design Decisions

### Web entries as scheme-based K/V

Fetched pages use `http://` and `https://` schemes in the same K/V store as files and knowledge. This gives unified state transitions (promote/demote/store), consistent visibility rules, deduplication by path, and model transparency — URLs appear alongside files in context.

### Priority 5 for URL interception

The get handler registers at priority 5, before the core get handler at 10. URL detection is scheme-specific and non-contentious. Early exit prevents unnecessary filesystem operations. The core handler remains unaware of web URLs.

### Search results as separate entries

Each search creates one `search://` metadata entry plus individual `http(s)://` entries at `summary` state. Individual entries are deduplicatable and independently fetchable. Each carries the originating query in attributes.

### Lazy browser initialization

Playwright browser launches on first fetch, not at plugin construction. Most agent sessions never use web tools, so this avoids ~2s startup overhead. The singleton pattern with async coordination (`#launching` promise) prevents concurrent launches.

### Attributes for metadata, body for content

Fetch metadata (`title`, `byline`, `excerpt`, `siteName`) lives in `entry.attributes`; the body is pure markdown content. Attributes are invisible to the model unless a view function surfaces them, keeping the content clean.

### Cross-scheme registration via core.hooks

This plugin registers handlers and views on schemes it doesn't own (`search`, `get`, `http`, `https`). The `core.on()` shorthand scopes to `core.name` (which is `"web"`), so cross-scheme work goes through `core.hooks.tools` directly. This is the intended pattern for plugins that extend existing tools.

## Timeout Cascade

```
RUMMY_FETCH_TIMEOUT (default 15000 ms)
  ├ WebFetcher.fetch()   — page.goto({ timeout: FETCH_TIMEOUT })
  └ WebFetcher.search()  — fetch({ signal: AbortSignal.timeout(FETCH_TIMEOUT) })
```

Both page loads and SearXNG requests share the same timeout value.

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
