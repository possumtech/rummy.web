# @possumtech/rummy-web — Specification

Architectural specification for the rummy web plugin. Covers the plugin contract, entry lifecycle, handler dispatch, and design rationale.

## Plugin Contract

All rummy plugins export a class with a static `register(hooks)` method:

```javascript
export default class WebPlugin {
    static register(hooks) { }
}
```

The plugin loader (`registerPlugins`) scans directories for `.js` files, imports them, and calls `Plugin.register(hooks)` if present. Built-in plugins load first (`src/plugins/`), then user plugins (`~/.rummy/plugins/`). Within a directory, files matching the directory name (e.g. `web/web.js`) or root-level `.js` files (excluding `index.js`) are loaded. Test files (`*.test.js`) are skipped.

## Hook System

The `hooks` object provides the full registration API.

### Tool Registration

```javascript
hooks.tools.register(name, {
    modes: new Set(["ask", "act"]),  // Which agent modes allow this tool
    category: "ask",                  // "ask" (read-only) or "act" (mutating)
    docs: "markdown string",          // Injected into system prompt
    project: (entry) => string,       // Projection: transforms entry for model view
    handler: async (entry, rummy) => {} // Optional inline handler
});
```

### Handler Registration

Handlers execute in priority order (lower = earlier). Return `false` to stop the chain.

```javascript
hooks.tools.onHandle(scheme, async (entry, rummy) => {
    // entry: { scheme, path, body, attributes, state, resultPath }
    // rummy: RummyContext
    // Return false to stop chain; implicit return continues
}, priority);
```

### Projection Registration

Projections transform an entry's body into what the model sees:

```javascript
hooks.tools.onProject(scheme, (entry) => transformedBody);
```

### Turn Processors

Run before materialization each turn:

```javascript
hooks.onTurn(async (rummy) => { }, priority);
```

### Events and Filters

Events: `hooks.entry.created`, `hooks.run.started`, `hooks.ask.completed`, etc.
Filters: `hooks.llm.messages`, `hooks.llm.response`, `hooks.rpc.request`, etc.

## RummyContext API

Passed to all handlers and turn processors. Provides unified access to the current turn.

### Properties

| Property | Type | Description |
|---|---|---|
| `hooks` | Hooks | Full hook system reference |
| `db` | Database | SQLRite prepared statement collection |
| `entries` | KnownStore | K/V store API |
| `project` | Object | Current project metadata |
| `type` | String | Turn mode: `"ask"` or `"act"` |
| `sequence` | Number | Current turn number |
| `runId` | Number | Current run ID |
| `contextSize` | Number | Token budget |

### Tool Methods

Same operations available to the model via XML tags:

```javascript
await rummy.set({ path, body, state, attributes })
await rummy.read(path)
await rummy.store(path)
await rummy.delete(path)
await rummy.move(from, to)
await rummy.copy(from, to)
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

Metadata stored as JSON in `entry.attributes`, invisible to the model unless a projection function surfaces it:

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

## WebPlugin Registration

### Tool: `search`

```javascript
hooks.tools.register("search", {
    modes: new Set(["ask", "act"]),
    category: "ask",
    docs: SEARCH_DOCS,
    project: (entry) => `# search "${attrs.path || ""}"\n${entry.body}`
});
```

Available in both `ask` and `act` modes. Categorized as `ask` (non-mutating).

### Projections: `http` and `https`

```javascript
hooks.tools.onProject("http", (entry) => entry.body);
hooks.tools.onProject("https", (entry) => entry.body);
```

Pass-through: body is the markdown content itself.

### Handler: `search` (default priority)

1. Extract query from `attrs.path` or `entry.body`.
2. Query SearXNG via `WebFetcher.search(query, { limit })`.
3. For each result, clean the URL and create an `https://` entry at `summary` state with `title + snippet` body and `{ query, engine }` attributes.
4. Update the `search://` result entry to `info` state with the URL listing.

### Handler: `read` (priority 5)

Priority 5 runs before the core file reader at priority 10.

1. Check `attrs.path` matches `/^https?:\/\//`. If not, return (pass to next handler).
2. Check if the URL already exists in the store (deduplication). If found, return.
3. Clean the URL via `WebFetcher.cleanUrl()`.
4. Fetch via `WebFetcher.fetch()` (Playwright + Readability + Turndown).
5. On error: log warning, return (don't stop chain).
6. On success: upsert at `full` state with markdown body and `{ title, excerpt, byline, siteName }` attributes.

### Turn Hook (priority 15)

Injects `SEARCH_DOCS` and `FETCH_DOCS` into the `instructions://system` entry's `toolDescriptions` attribute array. Runs before materialization. Includes deduplication check to prevent double-injection across turns.

## Handler Priority Chain

```
Dispatch "read" for https://example.com
  Priority 5:  WebPlugin — detects URL, fetches, upserts markdown
  Priority 10: Core read — skipped (WebPlugin already handled)

Dispatch "read" for src/app.js
  Priority 5:  WebPlugin — not a URL, returns (implicit continue)
  Priority 10: Core read — promotes file entry to full
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
    → WebPlugin search handler fires
    → Creates https:// entries at "summary"
    → Updates search:// entry to "info" with listing
  → hooks.entry.created.emit(entry)
```

### RPC Path

```
Client sends { method: "read", path: "https://example.com", run: "myrun" }
  → buildRunContext(hooks, ctx, "myrun")
  → dispatchTool(hooks, rummy, "get", path, "", { path })
    → hooks.tools.dispatch("get", entry, rummy)
      → Priority 5: WebPlugin detects URL, fetches, upserts
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

1. `TurnExecutor.execute()` writes `instructions://system` with empty `toolDescriptions: []`.
2. `hooks.processTurn(rummy)` fires. WebPlugin's onTurn hook (priority 15) pushes `SEARCH_DOCS` and `FETCH_DOCS` into `toolDescriptions`.
3. `InstructionsPlugin.project()` renders `prompt.md` with interpolated tool descriptions.
4. `v_model_context` VIEW selects visible entries. Web entries categorize as:
   - `file` (http/https at full or summary state)
   - `file_index` (http/https at stored state)
   - `result` (search entries)
5. `ContextAssembler` places file-category entries in the system message context section and result-category entries in user message tool results.

## Design Decisions

### Web entries as scheme-based K/V

Fetched pages use `http://` and `https://` schemes in the same K/V store as files and knowledge. This gives unified state transitions (promote/demote/store), consistent visibility rules, deduplication by path, and model transparency — URLs appear alongside files in context.

### Priority 5 for URL interception

The read handler registers at priority 5, before core file read at 10. URL detection is scheme-specific and non-contentious. Early exit prevents unnecessary filesystem operations. The core handler remains unaware of web URLs.

### Search results as separate entries

Each search creates one `search://` metadata entry plus individual `http(s)://` entries at `summary` state. Individual entries are deduplicatable and independently fetchable. Each carries the originating query in attributes.

### Lazy browser initialization

Playwright browser launches on first fetch, not at plugin registration. Most agent sessions never use web tools, so this avoids ~2s startup overhead. The singleton pattern with async coordination (`#launching` promise) prevents concurrent launches.

### onTurn for doc injection

Tool documentation is injected into `instructions://system.toolDescriptions` during the onTurn hook (priority 15), not at registration time. This allows conditional injection, deduplication across turns, and runs after the file scanner but before core materialization.

### Attributes for metadata, body for content

Fetch metadata (`title`, `byline`, `excerpt`, `siteName`) lives in `entry.attributes`; the body is pure markdown content. Attributes are invisible to the model unless a projection function surfaces them, keeping the content clean.

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
├── web.js              — WebPlugin class (plugin entry point)
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
