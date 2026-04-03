# @possumtech/rummy-web

Web search and fetch plugin for [rummy](https://github.com/possumtech/rummy). Provides `<search>` and URL-aware `<read>` tools powered by Playwright and SearXNG.

## Install

```sh
npm install @possumtech/rummy-web
```

Then install Playwright's Chromium browser:

```sh
npx playwright install chromium
```

## Setup

Drop the plugin into your rummy plugins directory:

```
~/.rummy/plugins/web.js
```

```javascript
export { default } from "@possumtech/rummy-web";
```

Rummy's plugin loader will discover the file and call `WebPlugin.register(hooks)` automatically.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RUMMY_SEARXNG_URL` | Yes (for search) | — | Base URL of your SearXNG instance (e.g. `http://127.0.0.1:8888`) |
| `RUMMY_FETCH_TIMEOUT` | No | `15000` | Timeout in ms for page loads and search requests |

## Tools

### `<search>` — Web Search

Queries a SearXNG instance and returns results as URL entries.

```xml
<search>node.js streams backpressure</search>
<search results="5">SQLite WAL mode</search>
```

- Results default to 12; set `results` attribute to limit.
- Each result is stored as an `https://` entry at `summary` state.
- Use `<read>` on a result URL to fetch the full page content.

### `<read>` — URL Fetch

When `<read>` targets an `http://` or `https://` URL, this plugin intercepts (priority 5, before the core file reader at 10), fetches the page with Playwright, extracts readable content via Mozilla Readability, and converts it to markdown with Turndown.

```xml
<read>https://docs.example.com/api</read>
```

- Content is stored as a `full` entry with `title`, `excerpt`, `byline`, and `siteName` attributes.
- Already-fetched URLs are skipped (no duplicate requests).

## Plugin Contract

This package exports a standard rummy plugin class:

```javascript
export default class WebPlugin {
    static register(hooks) { /* ... */ }
}
```

### Hooks Used

| Hook | Purpose |
|---|---|
| `hooks.tools.register("search", ...)` | Registers the search tool with modes, docs, and projection |
| `hooks.tools.onProject("http", ...)` | Projection for http:// entries |
| `hooks.tools.onProject("https", ...)` | Projection for https:// entries |
| `hooks.tools.onHandle("search", ...)` | Handles search execution via SearXNG |
| `hooks.tools.onHandle("read", ..., 5)` | Intercepts URL reads before core file handler |
| `hooks.onTurn(..., 15)` | Injects tool descriptions into system instructions |

### RummyContext Methods Used

- `rummy.write({ path, body, state, attributes })` — store search results
- `rummy.entries.upsert(runId, turn, path, body, state, opts)` — record tool results and update instructions
- `rummy.entries.getBody(runId, path)` — check for existing fetched content
- `rummy.entries.getAttributes(runId, path)` — read instruction attributes

## Programmatic Access

The `WebFetcher` class is available as a standalone export for direct use outside the plugin system:

```javascript
import WebFetcher from "@possumtech/rummy-web/fetcher";

const fetcher = new WebFetcher();
const page = await fetcher.fetch("https://example.com");
console.log(page.title, page.content);

const results = await fetcher.search("query");
console.log(results);

await fetcher.close();
```

## License

MIT
