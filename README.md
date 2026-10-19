# pi-deepseek-tools

DeepSeek's [Search & Fetch APIs](https://api-docs.deepseek.com/guides/search) as two Pi tools. No extra search account, no browser, no scraping stack.

| Tool | What it does |
|---|---|
| `deepseek_search` | Live web search over DeepSeek's own index: ranked results, model-facing summaries, optional page Markdown, relevance/authority scores, dates, query operators |
| `deepseek_fetch` | One page as Markdown, with a no-JS local fallback when DeepSeek declines the URL |

Both are exposed to **codemode** by default, so a single script can search, rank, fetch and filter before anything reaches the model's context.

## Install

```bash
pi install npm:pi-deepseek-tools
```

Or try it without installing:

```bash
pi -e npm:pi-deepseek-tools
```

## API key

The tools use the same key as the DeepSeek model provider. They look for it in this order:

1. `DEEPSEEK_API_KEY`
2. `<agent dir>/auth.json` → the `deepseek` entry (`~/.pi/agent/auth.json` by default, honoring `PI_CODING_AGENT_DIR`)

If you already log in to DeepSeek in Pi, there is nothing to configure. To point at a different gateway:

```bash
export DEEPSEEK_BASE_URL=https://api.deepseek.com
```

**No credentials are bundled.** The published tarball contains only `index.ts`, `deepseek.ts`, `README.md`, `LICENSE` and `package.json`. Every install resolves its own key at runtime from `DEEPSEEK_API_KEY` or its own `<agent dir>/auth.json`, and sends it only to the configured DeepSeek base URL. `npm publish` runs `scripts/check-secrets.mjs`, which refuses to publish when a credential-looking string appears in any tracked file.

## Use

```text
Search for DeepSeek V4 pricing and tell me what changed.
```

From a codemode script:

```js
const { results } = await tools.deepseek_search({
  query: "deepseek v4 release site:api-docs.deepseek.com OR site:deepseek.com lang:en after:2026-01-01",
  count: 10,
});

const worthReading = results.filter((r) => r.rerankScore >= 1.5 && r.authority >= 3).slice(0, 2);
const pages = await Promise.allSettled(worthReading.map((r) => tools.deepseek_fetch({ url: r.url })));

for (const page of pages) {
  if (page.status === "fulfilled") text(page.value.content.slice(0, 4000));
}
```

### `deepseek_search`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `query` | string (1-128) | required | Sent verbatim; supports the operators below |
| `count` | integer 1-50 | `10` | Per-request price does not change with `count` |
| `needContent` | boolean | `false` | Adds each page's body to the results |
| `maxContentChars` | integer | `6000` | Per-result cap when `needContent` is on |

Each result carries `title`, `url`, `snippet`, `summary` (~600-800 chars, written for a model), `content`, `siteName`, `siteIcon`, `date`, `authority` (0-4) and `rerankScore` (0-3).

### `deepseek_fetch`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | Absolute http(s) URL, max 8192 chars |
| `maxChars` | integer | `20000` | When truncated, the full Markdown is written to a temp file and its path is included |

### Query operators

| Operator | Example |
|---|---|
| Restrict to a site | `site:github.com`, several: `site:a.com OR site:b.com` |
| Exclude a site | `-site:example.com` |
| Exact phrase / exclusion | `"release notes"`, `-"release notes"` |
| Exclude a term | `-advertisement` |
| Language | `lang:en`, `lang:zh,en` |
| Publication date | `after:2025`, `after:2025-01-01`, `before:2026-06-01` |

## Behavior

- **Ranking hints.** `rerankScore >= 1.5` is high quality, `authority >= 3` is a highly authoritative source. Filter on both in scripts instead of reading everything.
- **Retries.** 408, 429 and 5xx responses are retried twice with exponential backoff and `Retry-After` support. Other 4xx errors fail immediately with a message that names the cause (401 bad key, 402 no balance, 403/404 fetch policy or no extractable content).
- **Fetch fallback.** If DeepSeek's fetch returns 403/404/408/5xx (or the network fails), the page is fetched directly and stripped to text. The output is labeled as lower-quality extraction. Login walls, bot protection and client-rendered app pages still fail.
- **Markdown cleanup.** DeepSeek escapes punctuation (`\#`, `\-`); it is unescaped outside fenced code blocks.
- **Read-only.** Neither tool writes anything except the temp file for truncated fetch output. They are annotated `readOnlyHint` + `openWorldHint`.

## Exposure

By default the tools are `codemode`-only: they do not appear in the model's tool list, but scripts can call them. If a session does not have codemode active, the extension re-registers them as `direct` tools automatically.

```bash
PI_DEEPSEEK_EXPOSURE=direct    # always visible to the model
PI_DEEPSEEK_EXPOSURE=deferred  # findable with tool_search
PI_DEEPSEEK_EXPOSURE=hidden    # registered but unreachable
```

If you use Pi's `--tools` allowlist, it also filters what codemode scripts can reach, so name the tools explicitly: `-t codemode,deepseek_search,deepseek_fetch` (or `-t '*'`).

## Cost and limits

Billed by DeepSeek per successful request, not per result or token:

| API | Price | Rate limit |
|---|---|---|
| Search | $0.75 / 1,000 successful requests | 100 QPS per account |
| Fetch | $0.75 / 1,000 successful requests | 25 QPS per account, plus a per-domain limit |

Failed requests, empty result sets and timeouts are not billed.

## Development

```bash
git clone https://github.com/muntasimulhaque/pi-deepseek-tools
cd pi-deepseek-tools
npm install
pi -e ./index.ts -p "Search for 'pi coding agent' and list the top 3 URLs."
```

Files:

- `index.ts` — tool registration, formatting, exposure logic
- `deepseek.ts` — HTTP client, credentials, retries, Markdown helpers, local fallback

## License

MIT © Muntasim Ul Haque
