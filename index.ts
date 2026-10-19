/**
 * pi-deepseek-tools
 *
 * DeepSeek Search & Fetch as Pi tools.
 * - deepseek_search: live web search (DeepSeek's own index, with query operators)
 * - deepseek_fetch: fetch one page as Markdown, with a no-JS local fallback
 *
 * Both tools are exposed to `codemode` by default so scripts can search,
 * filter and read pages without the results passing through the model twice.
 * Set `PI_DEEPSEEK_EXPOSURE=direct|codemode|deferred|hidden` to override.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolExposure } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_BASE_URL,
	DeepSeekApiError,
	API_KEY_ENV,
	BASE_URL_ENV,
	fetchPage,
	fetchPageLocally,
	MAX_COUNT,
	MAX_QUERY_CHARS,
	MIN_COUNT,
	search,
	type FetchedPage,
	type SearchResult,
	truncateText,
} from "./deepseek.ts";

// =============================================================================
// Parameters
// =============================================================================

const SearchParams = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: MAX_QUERY_CHARS,
		description:
			'Search query (1-128 chars), sent verbatim. Operators can be combined: site:github.com, site:a.com OR site:b.com, -site:example.com, "exact phrase", -"phrase", -term, lang:en, lang:zh,en, after:2025, after:2025-01-01, before:2026-06-01.',
	}),
	count: Type.Optional(
		Type.Integer({ minimum: MIN_COUNT, maximum: MAX_COUNT, description: "Number of results to return (default 10)." }),
	),
	needContent: Type.Optional(
		Type.Boolean({
			description:
				"Also return each page's body as Markdown (default false). Prefer false and call deepseek_fetch on the few results worth reading.",
		}),
	),
	maxContentChars: Type.Optional(
		Type.Integer({
			minimum: 500,
			maximum: 200_000,
			description: "Per-result cap on returned content when needContent is true (default 6000).",
		}),
	),
});

const FetchParams = Type.Object({
	url: Type.String({ minLength: 1, description: "Absolute http(s) URL to fetch (max 8192 chars)." }),
	maxChars: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 400_000,
			description: "Cap on returned Markdown (default 20000). The full text is written to a temp file when truncated.",
		}),
	),
});

type SearchArgs = {
	query: string;
	count?: number;
	needContent?: boolean;
	maxContentChars?: number;
};

type FetchArgs = {
	url: string;
	maxChars?: number;
};

// =============================================================================
// Output schemas (structuredContent for codemode scripts)
// =============================================================================

const SearchOutput = Type.Object({
	query: Type.String(),
	results: Type.Array(
		Type.Object({
			title: Type.String(),
			url: Type.String(),
			snippet: Type.String(),
			summary: Type.String(),
			content: Type.String(),
			siteName: Type.Union([Type.String(), Type.Null()]),
			siteIcon: Type.Union([Type.String(), Type.Null()]),
			date: Type.Union([Type.String(), Type.Null()]),
			authority: Type.Integer(),
			rerankScore: Type.Number(),
		}),
	),
});

const FetchOutput = Type.Object({
	url: Type.String(),
	title: Type.String(),
	content: Type.String(),
	source: Type.Union([Type.Literal("deepseek"), Type.Literal("local")]),
	truncated: Type.Boolean(),
	totalChars: Type.Integer(),
});

// =============================================================================
// Details (UI / session state)
// =============================================================================

interface SearchDetails {
	query: string;
	count: number;
	elapsedMs: number;
	results: { title: string; url: string; rerankScore: number; authority: number; date: string | null }[];
}

interface FetchDetails {
	url: string;
	title: string;
	source: "deepseek" | "local";
	chars: number;
	truncated: boolean;
	fullContentPath?: string;
}

// =============================================================================
// Formatting
// =============================================================================

const DEFAULT_SEARCH_CONTENT_CHARS = 6_000;
const DEFAULT_FETCH_CHARS = 20_000;

function formatMeta(result: SearchResult): string {
	const parts = [`score ${result.rerankScore.toFixed(2)}`];
	if (result.authority >= 0) parts.push(`authority ${result.authority}`);
	if (result.date) parts.push(result.date.slice(0, 10));
	if (result.siteName) parts.push(result.siteName);
	return parts.join(" | ");
}

function formatSearchText(query: string, elapsedMs: number, results: SearchResult[], maxContentChars: number): string {
	const header = `${results.length} result${results.length === 1 ? "" : "s"} for "${query}" (${(elapsedMs / 1000).toFixed(1)}s)`;
	if (results.length === 0) {
		return `${header}\n\nNo matches. Try fewer words or drop restrictive operators (site:, \"phrase\", after:).`;
	}

	const blocks = results.map((result, index) => {
		const body = result.content || result.summary || result.snippet;
		const capped = truncateText(body, maxContentChars);
		const note = capped.truncated ? `\n   [content truncated: ${capped.chars} of ${capped.totalChars} chars]` : "";
		return `${index + 1}. ${result.title || "(untitled)"}\n   ${result.url}\n   ${formatMeta(result)}\n   ${capped.text.replace(/\n/g, "\n   ")}${note}`;
	});

	return `${header}\n\n${blocks.join("\n\n")}`;
}

function formatFetchText(page: FetchedPage, cappedChars: number, fullContentPath?: string): string {
	const title = page.title || "(untitled)";
	const note = fullContentPath
		? `\n[truncated: showing first ${cappedChars} of ${page.content.length} chars; full text at ${fullContentPath}]`
		: "";
	return `# ${title}\n${page.url} (${page.content.length} chars)\n\n${page.content.slice(0, cappedChars)}${note}`;
}

// =============================================================================
// Tools
// =============================================================================

async function runSearch(args: SearchArgs): Promise<{
	text: string;
	details: SearchDetails;
	structured: { query: string; results: SearchResult[] };
}> {
	const set = await search(args.query, {
		count: args.count,
		needContent: args.needContent === true,
	});
	const maxChars = args.maxContentChars ?? DEFAULT_SEARCH_CONTENT_CHARS;
	return {
		text: formatSearchText(set.query, set.elapsedMs, set.results, maxChars),
		details: {
			query: set.query,
			count: set.results.length,
			elapsedMs: set.elapsedMs,
			results: set.results.map((result) => ({
				title: result.title,
				url: result.url,
				rerankScore: result.rerankScore,
				authority: result.authority,
				date: result.date,
			})),
		},
		structured: { query: set.query, results: set.results },
	};
}

function shouldFallBack(error: unknown): boolean {
	if (!(error instanceof DeepSeekApiError)) return false;
	if (error.status === undefined) return true;
	return error.status === 403 || error.status === 404 || error.status === 408 || error.status >= 500;
}

async function runFetch(args: FetchArgs): Promise<{
	text: string;
	details: FetchDetails;
	structured: {
		url: string;
		title: string;
		content: string;
		source: "deepseek" | "local";
		truncated: boolean;
		totalChars: number;
	};
}> {
	const maxChars = args.maxChars ?? DEFAULT_FETCH_CHARS;
	let page: FetchedPage | undefined;
	let source: "deepseek" | "local" = "deepseek";
	let fallbackNote = "";

	try {
		page = await fetchPage(args.url);
	} catch (error) {
		if (!shouldFallBack(error)) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		let local: { title: string; content: string };
		try {
			local = await fetchPageLocally(args.url);
		} catch (localError) {
			const localReason = localError instanceof Error ? localError.message : String(localError);
			throw new DeepSeekApiError(`${reason}\nLocal fallback also failed: ${localReason}`);
		}
		source = "local";
		page = { url: args.url, title: local.title, content: local.content, elapsedMs: 0 };
		fallbackNote = `DeepSeek fetch failed (${reason}). Fell back to a plain local fetch; extraction is cruder and may include navigation text.\n\n`;
	}

	const capped = truncateText(page.content, maxChars);
	let fullContentPath: string | undefined;
	if (capped.truncated) {
		try {
			const dir = await mkdtemp(join(tmpdir(), "pi-deepseek-"));
			const host = new URL(page.url).hostname.replace(/[^\w.-]+/g, "_");
			fullContentPath = join(dir, `${host || "page"}.md`);
			await writeFile(fullContentPath, page.content, "utf8");
		} catch {
			fullContentPath = undefined;
		}
	}

	const text = fallbackNote + formatFetchText(page, capped.chars, fullContentPath);
	return {
		text,
		details: {
			url: page.url,
			title: page.title,
			source,
			chars: page.content.length,
			truncated: capped.truncated,
			fullContentPath,
		},
		structured: {
			url: page.url,
			title: page.title,
			content: page.content,
			source,
			truncated: capped.truncated,
			totalChars: page.content.length,
		},
	};
}

// =============================================================================
// Exposure
// =============================================================================

const VALID_EXPOSURE: readonly ToolExposure[] = ["direct", "model-only", "codemode", "deferred", "hidden"];

function parseExposure(value: string | undefined): ToolExposure | undefined {
	const normalized = value?.trim().toLowerCase();
	return VALID_EXPOSURE.find((exposure) => exposure === normalized);
}

// =============================================================================
// Extension
// =============================================================================

export default function deepseekTools(pi: ExtensionAPI) {
	const configuredExposure = parseExposure(process.env.PI_DEEPSEEK_EXPOSURE);
	let exposure: ToolExposure = configuredExposure ?? "codemode";

	const register = () => {
		pi.registerTool({
			name: "deepseek_search",
			label: "DeepSeek Search",
			description: `Search the live web with DeepSeek's own search engine. Returns ranked results with title, URL, snippet, a model-facing summary, optional page content, publication date, a relevance score (rerankScore 0-3, 1.5+ is high quality) and an authority tier (0-4, 3+ is highly authoritative). Use it for anything newer than your training data: releases, versions, docs, prices, people, current events, or to verify a claim.

The query is sent verbatim and supports operators, combinable in one string: site:github.com (restrict; several = site:a.com OR site:b.com), -site:example.com (exclude), "exact phrase", -"phrase", -term, lang:en / lang:zh,en, after:2025 / after:2025-01-01, before:2026-06-01.

Every successful call is billed (~$0.00075), so prefer one call with count 10-20 over several small ones. Filter by rerankScore/authority before reading pages, and use deepseek_fetch for the few that matter.`,
			promptSnippet: "Search the live web (DeepSeek's index) and fetch pages as Markdown",
			promptGuidelines: [
				"Use deepseek_search for information newer than training data or to verify facts; put site:, lang: and after:/before: operators directly in the query.",
				"Use deepseek_fetch to read a promising search result, or any URL the user provides, in full.",
				"deepseek_search and deepseek_fetch are billed per request; batch them in a codemode script instead of making many separate calls.",
			],
			parameters: SearchParams,
			outputSchema: SearchOutput,
			annotations: { readOnlyHint: true, openWorldHint: true },
			executionMode: "parallel",
			exposure,
			namespace: {
				name: "deepseek",
				description: "DeepSeek Search & Fetch: live web search and Markdown page fetching.",
			},
			async execute(_toolCallId, params) {
				const outcome = await runSearch(params);
				return {
					content: [{ type: "text", text: outcome.text }],
					details: outcome.details,
					structuredContent: outcome.structured,
				};
			},
		});

		pi.registerTool({
			name: "deepseek_fetch",
			label: "DeepSeek Fetch",
			description: `Fetch one web page through DeepSeek and return its main content as Markdown, plus the page title. Use it to read a deepseek_search result in full, follow a documentation link, or read a URL the user gave you. Pages behind a login, an interactive app, or a site's bot policy fail with 403/404; the tool then retries with a plain local fetch and labels the output as lower-quality extraction. Content is capped (default 20000 chars) and the full text is written to a temp file when truncated.`,
			annotations: { readOnlyHint: true, openWorldHint: true },
			executionMode: "parallel",
			parameters: FetchParams,
			outputSchema: FetchOutput,
			exposure,
			namespace: {
				name: "deepseek",
				description: "DeepSeek Search & Fetch: live web search and Markdown page fetching.",
			},
			async execute(_toolCallId, params) {
				const outcome = await runFetch(params);
				return {
					content: [{ type: "text", text: outcome.text }],
					details: outcome.details,
					structuredContent: outcome.structured,
				};
			},
		});
	};

	register();

	// Without codemode the tools would be unreachable, so expose them directly
	// in sessions that do not have it. An explicit environment override wins.
	pi.on("session_start", () => {
		if (configuredExposure || exposure !== "codemode") return;
		const active = pi.getActiveTools();
		if (active.includes("codemode")) return;
		exposure = "direct";
		register();
		pi.setActiveTools([...new Set([...pi.getActiveTools(), "deepseek_search", "deepseek_fetch"])]);
	});
}

export { DEFAULT_BASE_URL, API_KEY_ENV, BASE_URL_ENV };
