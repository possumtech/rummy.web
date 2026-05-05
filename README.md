# @possumtech/rummy.web

Web search and fetch plugin for [rummy](https://github.com/possumtech/rummy). Adds `<search>` and URL-aware `<get>` tools powered by Playwright, Mozilla Readability, and a SearXNG backend (which itself federates upstream engines).

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

SearXNG is the only backend — point it at a running instance:

```env
RUMMY_WEB_SEARXNG_URL=http://127.0.0.1:8888
```

SearXNG can itself federate to Brave, DuckDuckGo, Wikipedia, and many other engines (configured upstream in your SearXNG instance); we take its normalized output as gospel.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RUMMY_PLUGIN_WEB` | Yes | — | Set to `@possumtech/rummy.web` to load |
| `RUMMY_WEB_SEARXNG_URL` | Yes | — | SearXNG base URL |
| `RUMMY_WEB_FETCH_TIMEOUT` | Yes | — | Timeout in ms for page loads and search requests |
| `RUMMY_WEB_SEARCH_MAX` | Yes | — | Max `<search>` commands per turn |
| `RUMMY_WEB_SEARCH_RESULTS` | Yes | — | Default candidate count when the model doesn't set `results=N` |
| `RUMMY_TOKEN_DIVISOR` | Yes | — | Page chars-per-token ratio for the listing's `(N tokens)` badge |
| `RUMMY_WEB_PLAYWRIGHT_WS` | No | — | CDP `ws://` endpoint to connect to a shared chromium instead of launching locally |
| `RUMMY_WEB_NO_SANDBOX` | No | — | `1` to drop chromium's user-namespace sandbox (docker-friendly; mild security tradeoff) |
| `RUMMY_WEB_CHROMIUM_HEAP_MB` | No | — | Cap chromium's V8 old-space heap (MB) |

The `Yes` variables have no in-code defaults — `Number(undefined)` becomes `NaN` and downstream behavior degrades silently. The package ships `.env.example` with sensible values and the test runner cascades it before `.env.test`. In production, the parent rummy app's env file is the source of truth.

## Tools

### `<search>` — Web Search

Queries the configured search backend, fetches each result in parallel, archives the bodies as `<https>` run entries (`visibility: "archived"`), and returns the surviving candidates with their token costs as a single log entry. A subsequent `<get>` on any listed URL is a pure visibility flip — no second round trip.

```xml
<search>node.js streams backpressure</search>
<search results="5">SQLite WAL mode</search>
```

- Results default to 12; set the `results` attribute to limit.
- Every candidate URL is fetched in parallel (10s timeout) — to validate reachability, measure token cost, and archive the body for a zero-network `<get>`. Candidates already archived within the last 10 minutes are served from the existing entry; only stale or new URLs hit the network.
- Unreachable results (404, timeout, network error) are dropped from the listing. The header reports `N of M results (M-N unreachable)` so the model knows some were filtered.
- The search log entry's body is a markdown bullet list. Each result renders as `* URL — title (N tokens)` followed (when populated) by an indented date line (`YYYY-MM-DD`) and the page's description. The leading `*` is load-bearing: it marks the body as rendered output the model has no training prior for emitting as a tool. Token count is the signal for the model's "which one is worth promoting" decision.
- Each successfully-fetched URL lands as an archived `<https>` entry (`state: "resolved"`, `visibility: "archived"`) with the body and `{title, content, publishedDate, engine, excerpt, byline, siteName, fetched_at}` attributes. `<get>` on a listed URL becomes a pure visibility flip; no re-fetch.
- Hard-capped at `RUMMY_WEB_SEARCH_MAX` searches per turn; further searches are refused (error logged with status 429).

### `<get>` — URL Fetch

When `<get>` targets an `http://` or `https://` URL, this plugin intercepts at priority 5 (before the core get handler at 10).

```xml
<get>https://en.wikipedia.org/wiki/Mitch_Hedberg</get>
```

- If the URL is already a known entry **and was fetched within the last 10 minutes**, this handler skips the network call and lets the core get handler promote the existing entry. Stale entries (older than 10 min) fall through to a fresh fetch and overwrite the archive.
- Otherwise, fetches the page with headless Chromium. HTML responses go through Readability + Turndown for clean markdown; non-HTML responses (`text/plain`, `application/json`, source files, …) are read as raw text.
- Wikipedia URLs are redirected to the mobile-html API for cleaner content. GitHub `blob/` URLs are redirected to `raw.githubusercontent.com` so source files come through as their raw bytes instead of the JS-rendered SPA (whose CSP forbids Readability injection anyway).
- All fetches use mobile device emulation (Pixel 5) for lighter page responses.

This makes `<get>` the universal URL-fetching verb regardless of where the URL came from — search results, page prose, or operator input.

## Programmatic Access

`WebFetcher` is available as a standalone export:

```javascript
import WebFetcher from "@possumtech/rummy.web/fetcher";

const fetcher = new WebFetcher();
const runId = 1; // required — scopes the BrowserContext (cookies, cache, etc.)

const page = await fetcher.fetch("https://example.com", { runId });
console.log(page.title, page.content);

const pages = await fetcher.fetchAll(["https://a.com", "https://b.com"], { runId, timeout: 10000 });

const results = await fetcher.search("query");

fetcher.closeContext(runId); // free the run's context when done
await fetcher.close();         // tear down the browser
```

`runId` is load-bearing: each run gets its own `BrowserContext` (isolated cookies, localStorage, cache) on a shared chromium. Calling `fetch`/`fetchAll` without one throws.

### `WebFetcher.fetch(url, opts?)` Response

```javascript
{ url, title, content, excerpt, byline, siteName }
// or on failure:
{ url, title: null, content: null, error: "message" }
```

### `WebFetcher.fetchAll(urls, opts?)` Response

Returns `Promise.allSettled` — array of `{ status, value }` objects, each value matching the `fetch` response shape.

### `WebFetcher.search(query, opts?)` Response

Returns SearXNG's native per-result shape verbatim, sliced to `limit`:

```javascript
[{
  url, title, content,
  engine, engines,
  publishedDate, score, category,
  thumbnail, // … plus any other fields SearXNG emits
}]
```

`content` is the upstream snippet (already lxml-extracted by SearXNG — no entity-decode or highlight-strip needed on our side). `score` is SearXNG's per-result quality signal; `engines` is the set of upstream engines that returned this URL (a useful cross-backend agreement signal when SearXNG is configured with multiple engines).

### `WebFetcher.cleanUrl(raw)`

Static. Strips query params, hash fragments, and trailing slashes.

## License

MIT
