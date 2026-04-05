# @possumtech/rummy.web

Web search and fetch plugin for [rummy](https://github.com/possumtech/rummy). Adds `<search>` and URL-aware `<get>` tools powered by Playwright, Mozilla Readability, and SearXNG.

## Install

```sh
npm install @possumtech/rummy.web
npx playwright install chromium
```

## Setup

Create a one-line re-export in your rummy plugins directory:

```
~/.rummy/plugins/web.js
```

```javascript
export { default } from "@possumtech/rummy.web";
```

The plugin loader discovers the file, derives the name `"web"` from the filename, and calls `new RummyWeb(core)` with a `PluginContext`.

### SearXNG

The `<search>` tool requires a running [SearXNG](https://github.com/searxng/searxng) instance:

```sh
docker run -d -p 8888:8080 searxng/searxng
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RUMMY_SEARXNG_URL` | Yes (for search) | — | SearXNG base URL (e.g. `http://127.0.0.1:8888`) |
| `RUMMY_FETCH_TIMEOUT` | No | `15000` | Timeout in ms for page loads and search requests |

## Tools

### `<search>` — Web Search

Queries SearXNG and creates URL entries from results.

```xml
<search>node.js streams backpressure</search>
<search results="5">SQLite WAL mode</search>
```

- Results default to 12; set the `results` attribute to limit.
- Each result is stored as an `https://` entry at `summary` state with `title + snippet` body.
- A `search://` result entry is created at `info` state with the URL listing.
- Use `<get>` on a result URL to fetch the full page.

### `<get>` — URL Fetch

When `<get>` targets an `http://` or `https://` URL, this plugin intercepts at priority 5 (before the core get handler at 10), fetches the page with headless Chromium, extracts readable content via Mozilla Readability, and converts it to markdown via Turndown.

```xml
<get>https://docs.example.com/api</get>
```

- Content is stored as a `full` entry with `title`, `excerpt`, `byline`, and `siteName` attributes.
- Already-fetched URLs are skipped (deduplication by path).
- If Readability fails to parse, falls back to the first 5000 chars of raw HTML.

## Programmatic Access

`WebFetcher` is available as a standalone export for use outside the plugin system:

```javascript
import WebFetcher from "@possumtech/rummy.web/fetcher";

const fetcher = new WebFetcher();

const page = await fetcher.fetch("https://example.com");
console.log(page.title, page.content);

const results = await fetcher.search("query");
console.log(results);

await fetcher.close();
```

### `WebFetcher.fetch(url)` Response

```javascript
{ url, title, content, excerpt, byline, siteName }
// or on failure:
{ url, title: null, content: null, error: "message" }
```

### `WebFetcher.search(query, opts)` Response

```javascript
[{ title, url, snippet, engine }]
```

### `WebFetcher.cleanUrl(raw)`

Static method. Strips query params, hash fragments, and trailing slashes for path canonicalization and cache deduplication.

## License

MIT
