/**
 * Client for DeepSeek's Search and Fetch APIs.
 * Docs: https://api-docs.deepseek.com/guides/search
 *
 * Both endpoints are plain JSON and billed per successful request
 * (Search $0.75/1k, Fetch $0.75/1k). Search allows 100 QPS per account,
 * Fetch 25 QPS plus a per-domain limit.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "deepseek";
export const API_KEY_ENV = "DEEPSEEK_API_KEY";
export const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

export const SEARCH_PATH = "/v1/tools/search";
export const FETCH_PATH = "/v1/tools/fetch";

const SEARCH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

export const MIN_QUERY_CHARS = 1;
export const MAX_QUERY_CHARS = 128;
export const MIN_COUNT = 1;
export const MAX_COUNT = 50;

// =============================================================================
// Errors
// =============================================================================

export class DeepSeekApiError extends Error {
	readonly status: number | undefined;
	readonly retryable: boolean;

	constructor(message: string, status?: number, retryable = false) {
		super(message);
		this.name = "DeepSeekApiError";
		this.status = status;
		this.retryable = retryable;
	}
}

// =============================================================================
// Credentials
// =============================================================================

export interface ApiKeyInfo {
	key: string;
	/** Where the key came from, for error messages and `/deepseek` style output. */
	source: string;
}

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/** Pi's agent config directory: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[AGENT_DIR_ENV]?.trim();
	if (configured) return expandTilde(configured);
	return join(homedir(), ".pi", "agent");
}

export function getAuthJsonPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "auth.json");
}

/**
 * Reads `<agent dir>/auth.json` the same way Pi stores credentials: one
 * `{ type: "api_key", key }` entry per provider.
 */
function readStoredApiKey(env: NodeJS.ProcessEnv): string | undefined {
	try {
		const raw = readFileSync(getAuthJsonPath(env), "utf8").replace(/^\uFEFF/, "");
		const data = JSON.parse(raw) as Record<string, unknown>;
		const credential = data[PROVIDER_ID];
		if (!credential || typeof credential !== "object") return undefined;
		const record = credential as { type?: unknown; key?: unknown };
		if (record.type !== "api_key") return undefined;
		return typeof record.key === "string" && record.key.trim() ? record.key.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): ApiKeyInfo {
	const fromEnv = env[API_KEY_ENV]?.trim();
	if (fromEnv) return { key: fromEnv, source: API_KEY_ENV };

	const stored = readStoredApiKey(env);
	if (stored) return { key: stored, source: getAuthJsonPath(env) };

	throw new DeepSeekApiError(
		`No DeepSeek API key found. Set ${API_KEY_ENV}, or store one for Pi under "${PROVIDER_ID}" in ${getAuthJsonPath(env)}.`,
	);
}

export function getBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[BASE_URL_ENV]?.trim();
	return (configured || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

// =============================================================================
// Types
// =============================================================================

// A type alias (not an interface) keeps the object assignable to JsonValue,
// so results can be returned as `structuredContent`.
export type SearchResult = {
	title: string;
	url: string;
	snippet: string;
	/** Long, model-facing summary (~600-800 chars). */
	summary: string;
	/** Page body as Markdown; empty unless `needContent` was requested. */
	content: string;
	siteName: string | null;
	siteIcon: string | null;
	/** RFC 3339 publication time, or null when unknown. */
	date: string | null;
	/** Authority tier 0-4; 3 or above is highly authoritative. */
	authority: number;
	/** Relevance score 0-3; 1.5 or above is high quality. */
	rerankScore: number;
};

export interface SearchResultSet {
	query: string;
	results: SearchResult[];
	elapsedMs: number;
}

export interface FetchedPage {
	url: string;
	title: string;
	content: string;
	elapsedMs: number;
}

export interface RequestOptions {
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

export interface SearchOptions extends RequestOptions {
	count?: number;
	needContent?: boolean;
	/** The user's original question, which improves query understanding. */
	oriQuestion?: string;
}

// =============================================================================
// Markdown helpers
// =============================================================================

// DeepSeek escapes ASCII punctuation aggressively (\# , \& , \/ , \" ,
// \= , ...). Unescape it outside fenced code blocks, where backslashes are
// meaningful; non-punctuation escapes such as \d or \U in paths stay as-is.
const MARKDOWN_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

/**
 * DeepSeek's fetch returns Markdown with punctuation escaped (`\#`, `\-`, `\.`).
 * Unescape it outside fenced code blocks, where backslashes are meaningful.
 */
export function unescapeMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (/^\s{0,3}(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) lines[i] = line.replace(MARKDOWN_ESCAPE, "$1");
	}
	return lines.join("\n");
}

export interface TruncatedText {
	text: string;
	truncated: boolean;
	chars: number;
	totalChars: number;
}

/** Caps text at `maxChars`, preferring a line break near the cut. */
export function truncateText(text: string, maxChars: number | undefined): TruncatedText {
	const totalChars = text.length;
	if (!maxChars || totalChars <= maxChars) {
		return { text, truncated: false, chars: totalChars, totalChars };
	}
	const slice = text.slice(0, maxChars);
	const breakAt = slice.lastIndexOf("\n");
	const cut = breakAt > maxChars * 0.6 ? slice.slice(0, breakAt) : slice;
	return { text: cut, truncated: true, chars: cut.length, totalChars };
}

// =============================================================================
// HTTP
// =============================================================================

interface RawSearchResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	summary?: unknown;
	content?: unknown;
	site_name?: unknown;
	site_icon?: unknown;
	date?: unknown;
	authority?: unknown;
	rerank_score?: unknown;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeResult(raw: RawSearchResult): SearchResult {
	return {
		title: asString(raw.title),
		url: asString(raw.url),
		snippet: asString(raw.snippet),
		summary: asString(raw.summary),
		content: asString(raw.content),
		siteName: asStringOrNull(raw.site_name),
		siteIcon: asStringOrNull(raw.site_icon),
		date: asStringOrNull(raw.date),
		authority: asNumber(raw.authority, -1),
		rerankScore: asNumber(raw.rerank_score, 0),
	};
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
	const header = response?.headers.get("retry-after");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
		const date = Date.parse(header);
		if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), MAX_RETRY_DELAY_MS));
	}
	return Math.min(750 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250);
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new DeepSeekApiError("DeepSeek request cancelled.");
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DeepSeekApiError("DeepSeek request cancelled."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function readErrorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: { message?: unknown } };
		const message = body?.error?.message;
		if (typeof message === "string" && message.trim()) return message.trim();
	} catch {
		// fall through to a synthesized message
	}
	const text = response.statusText ? ` ${response.statusText}` : "";
	return `HTTP ${response.status}${text}`;
}

function failureHint(status: number, kind: "search" | "fetch"): string | undefined {
	switch (status) {
		case 401:
			return "The DeepSeek API key is missing or invalid.";
		case 402:
			return "The DeepSeek account has insufficient balance; top up at https://platform.deepseek.com.";
		case 403:
			return kind === "fetch"
				? "DeepSeek's fetch security policy rejected this URL."
				: "The request was rejected (403).";
		case 404:
			return kind === "fetch"
				? "DeepSeek could not retrieve usable content: the page is unreachable, blocked by the site, unsupported, or has no extractable text."
				: "Not found (404).";
		case 429:
			return "Rate limit exceeded (Search 100 QPS, Fetch 25 QPS plus a per-domain limit). Wait and retry.";
		default:
			return undefined;
	}
}

async function postJson<T>(
	path: string,
	body: unknown,
	kind: "search" | "fetch",
	options: RequestOptions & { timeoutMs: number },
): Promise<T> {
	const env = options.env ?? process.env;
	const { key } = resolveApiKey(env);
	const url = `${getBaseUrl(env)}${path}`;
	const fetchImpl = options.fetchImpl ?? fetch;

	let lastError: DeepSeekApiError | undefined;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (options.signal?.aborted) throw new DeepSeekApiError("DeepSeek request cancelled.");

		const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			if (options.signal?.aborted) throw new DeepSeekApiError("DeepSeek request cancelled.");
			const reason = timeoutSignal.aborted
				? `timed out after ${Math.round(options.timeoutMs / 1000)}s`
				: error instanceof Error
					? error.message
					: String(error);
			lastError = new DeepSeekApiError(`Could not reach ${url}: ${reason}`, undefined, true);
			if (attempt < MAX_ATTEMPTS - 1) {
				await sleep(retryDelayMs(undefined, attempt), options.signal);
				continue;
			}
			throw lastError;
		}

		if (response.ok) {
			try {
				return (await response.json()) as T;
			} catch (error) {
				throw new DeepSeekApiError(`DeepSeek returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const apiMessage = await readErrorMessage(response);
		const hint = failureHint(response.status, kind);
		lastError = new DeepSeekApiError(
			`DeepSeek ${kind} failed: ${apiMessage}${hint ? ` (${hint})` : ""}`,
			response.status,
			isRetryableStatus(response.status),
		);

		if (lastError.retryable && attempt < MAX_ATTEMPTS - 1) {
			await sleep(retryDelayMs(response, attempt), options.signal);
			continue;
		}
		throw lastError;
	}

	throw lastError ?? new DeepSeekApiError(`DeepSeek ${kind} failed.`);
}

// =============================================================================
// Search
// =============================================================================

export async function search(query: string, options: SearchOptions = {}): Promise<SearchResultSet> {
	const trimmed = query.trim();
	if (trimmed.length < MIN_QUERY_CHARS) throw new DeepSeekApiError("Search query must not be empty.");
	if (trimmed.length > MAX_QUERY_CHARS) {
		throw new DeepSeekApiError(
			`Search query is ${trimmed.length} characters; DeepSeek accepts at most ${MAX_QUERY_CHARS}.`,
		);
	}

	const count = Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(options.count ?? 10)));
	const body: Record<string, unknown> = { query: trimmed, count, need_content: options.needContent === true };
	if (options.oriQuestion?.trim()) body.ori_question = options.oriQuestion.trim();

	const started = Date.now();
	const response = await postJson<{ results?: RawSearchResult[] }>(SEARCH_PATH, body, "search", {
		...options,
		timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
	});
	const results = Array.isArray(response?.results) ? response.results.map(normalizeResult) : [];
	return { query: trimmed, results, elapsedMs: Date.now() - started };
}

// =============================================================================
// Fetch
// =============================================================================

export async function fetchPage(url: string, options: RequestOptions = {}): Promise<FetchedPage> {
	const target = url.trim();
	if (!/^https?:\/\/[^\s]+$/i.test(target)) {
		throw new DeepSeekApiError("URL must be an absolute http(s) URL.");
	}
	const started = Date.now();
	const response = await postJson<{ title?: unknown; content?: unknown }>(FETCH_PATH, { url: target }, "fetch", {
		...options,
		timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
	});
	const content = unescapeMarkdown(asString(response?.content));
	if (!content.trim()) {
		throw new DeepSeekApiError("DeepSeek returned an empty page.", 404);
	}
	return { url: target, title: asString(response?.title), content, elapsedMs: Date.now() - started };
}

// =============================================================================
// Local fallback fetch (used when DeepSeek declines a URL)
// =============================================================================

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	rsquo: "'",
	lsquo: "'",
	rdquo: '"',
	ldquo: '"',
};

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
		.replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/** Very small HTML-to-text conversion: headings, lists, code and paragraphs. */
export function htmlToMarkdown(html: string): string {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";

	let body = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, "")
		.replace(/<head[\s\S]*?<\/head>/gi, "");

	body = body
		.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\n\`\`\`\n${code.replace(/<[^>]+>/g, "")}\n\`\`\`\n\n`)
		.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, text: string) => {
			return `\n\n${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, "").trim()}\n\n`;
		})
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|header|footer|tr|ul|ol|blockquote|table)>/gi, "\n\n")
		.replace(/<[^>]+>/g, "");

	body = decodeEntities(body)
		.replace(/[ \t\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return title && !body.startsWith(`# ${title}`) ? `${body}\n\n<!-- title: ${title} -->` : body;
}

export interface LocalFetchResult {
	title: string;
	content: string;
	contentType: string;
}

/**
 * No-JS fallback: fetch the page directly and strip it down to text.
 * Used when DeepSeek's fetch refuses a URL (403/404/5xx) but the page itself
 * is still reachable from this machine.
 */
export async function fetchPageLocally(
	url: string,
	options: Pick<RequestOptions, "signal" | "fetchImpl"> & { timeoutMs?: number } = {},
): Promise<LocalFetchResult> {
	const timeoutMs = options.timeoutMs ?? 20_000;
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	const response = await fetchImpl(url, {
		headers: {
			// Some sites reject the default undici agent.
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
		},
		signal,
	});
	if (!response.ok) throw new DeepSeekApiError(`Local fetch returned HTTP ${response.status}.`, response.status);

	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	const raw = await response.text();
	const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw);
	if (!isHtml && !contentType.includes("text/") && !contentType.includes("json")) {
		throw new DeepSeekApiError(`Unsupported content type: ${contentType || "unknown"}.`);
	}

	const content = isHtml ? htmlToMarkdown(raw) : raw.trim();
	if (!content) throw new DeepSeekApiError("Local fetch extracted no text.", 404);

	let title = "";
	const match = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (match) title = decodeEntities(match[1]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
	return { title, content, contentType };
}
