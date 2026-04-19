# @possumtech/rummy.web

Web search and fetch plugin for [rummy](https://github.com/possumtech/rummy). Adds `<search>` and URL-aware `<get>` tools powered by Playwright, Mozilla Readability, and configurable search backends (SearXNG or Brave).

## Install

```sh
npm install @possumtech/rummy.web
npx playwright install chromium
```

## Setup

Load via environment variable:

```env
RUMMY_PLUGIN_WEB=@possumtech/rummy.web
```

### Search Backend

SearXNG (default):

```env
RUMMY_SEARCH=searxng
RUMMY_SEARXNG_URL=http://127.0.0.1:8888
```

Brave Search API:

```env
RUMMY_SEARCH=brave
BRAVE_API_KEY=your-api-key
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RUMMY_PLUGIN_WEB` | Yes | — | Set to `@possumtech/rummy.web` to load |
| `RUMMY_SEARCH` | No | `searxng` | Search backend: `searxng` or `brave` |
| `RUMMY_SEARXNG_URL` | If searxng | — | SearXNG base URL |
| `BRAVE_API_KEY` | If brave | — | Brave Search API key |
| `RUMMY_FETCH_TIMEOUT` | No | `15000` | Timeout in ms for page loads and search requests |

## Tools

### `<search>` — Web Search

Queries the configured search backend and prefetches all result pages concurrently.

```xml
<search>node.js streams backpressure</search>
<search results="5">SQLite WAL mode</search>
```

- Results default to 12; set the `results` attribute to limit.
- All result pages are prefetched in parallel (5s timeout per page, shared browser context).
- Each result is stored as an `https://` entry at `demoted` fidelity with the full page content — the model sees token counts but not the body until promoted.
- Failed prefetches are dropped from results.
- Use `<get>` on a result URL to promote it to full fidelity.

### `<get>` — URL Fetch

When `<get>` targets an `http://` or `https://` URL, this plugin intercepts at priority 5 (before the core get handler at 10).

```xml
<get>https://en.wikipedia.org/wiki/Mitch_Hedberg</get>
```

- If the URL was prefetched by `<search>`, the core get handler promotes it — no refetch needed.
- Otherwise, fetches the page with headless Chromium, extracts content via Readability, converts to markdown via Turndown.
- Wikipedia URLs are automatically redirected to the mobile-html API for cleaner content.
- All fetches use mobile device emulation (Pixel 5) for lighter page responses.

## Programmatic Access

`WebFetcher` is available as a standalone export:

```javascript
import WebFetcher from "@possumtech/rummy.web/fetcher";

const fetcher = new WebFetcher();

const page = await fetcher.fetch("https://example.com");
console.log(page.title, page.content);

const pages = await fetcher.fetchAll(["https://a.com", "https://b.com"], { timeout: 5000 });

const results = await fetcher.search("query");

await fetcher.close();
```

### `WebFetcher.fetch(url, opts?)` Response

```javascript
{ url, title, content, excerpt, byline, siteName }
// or on failure:
{ url, title: null, content: null, error: "message" }
```

### `WebFetcher.fetchAll(urls, opts?)` Response

Returns `Promise.allSettled` — array of `{ status, value }` objects, each value matching the `fetch` response shape.

### `WebFetcher.search(query, opts?)` Response

```javascript
[{ title, url, snippet, engine }]
```

### `WebFetcher.cleanUrl(raw)`

Static. Strips query params, hash fragments, and trailing slashes.

## License

MIT
