/**
 * websearch — a web search tool for pi, ported from opencode's v2 tool.
 *
 * It talks to a hosted MCP search endpoint (Exa or Parallel) over a single
 * JSON-RPC `tools/call` request, so there is no MCP client or session to
 * manage. Both endpoints answer with either a plain JSON body or an SSE
 * stream, and both wrap the answer in `result.content[].text`.
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export const NO_RESULTS = "No search results found. Please try a different query.";
export const EXA_URL = "https://mcp.exa.ai/mcp";
export const PARALLEL_URL = "https://search.parallel.ai/mcp";
export const MAX_NUM_RESULTS = 20;
export const MAX_CONTEXT_CHARACTERS = 50_000;
/** Keeps a single search from eating the context window when the model does not ask for a limit. */
export const DEFAULT_CONTEXT_MAX_CHARACTERS = 10_000;
/** How long an identical query keeps returning the same results within a session. */
export const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 25_000;
const USER_AGENT = "pi-websearch";

export type Provider = "exa" | "parallel";
export type Env = Record<string, string | undefined>;

export interface SearchInput {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
}

/**
 * Providers to try, in order. Both endpoints answer without a key, so the only
 * question is which one goes first; the other one is the fallback.
 */
export function providerOrder(env: Env): Provider[] {
  const override = env.PI_WEBSEARCH_PROVIDER;
  const preferred: Provider =
    override === "exa" || override === "parallel"
      ? override
      : env.PARALLEL_API_KEY && !env.EXA_API_KEY
        ? "parallel"
        : "exa";
  return preferred === "exa" ? ["exa", "parallel"] : ["parallel", "exa"];
}

/** Pulls the first non-empty content text out of a JSON-RPC body or an SSE stream. */
export function parseMcpResponse(body: string): string | undefined {
  const payloads = body.trimStart().startsWith("{")
    ? [body]
    : body.split("\n").flatMap((line) => (line.startsWith("data: ") ? [line.slice(6)] : []));

  for (const payload of payloads) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const content = (parsed as { result?: { content?: Array<{ text?: string }> } })?.result
      ?.content;
    const text = content?.find((item) => item?.text)?.text;
    if (text) return text;
  }
  return undefined;
}

/** Reads the body but refuses anything past the cap, since the endpoint is untrusted. */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new Error(`websearch response too large (> ${MAX_RESPONSE_BYTES} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  params: { name: string; arguments: Record<string, unknown> };
}

/** Builds the endpoint, JSON-RPC params and headers for one provider. */
function requestFor(
  provider: Provider,
  input: SearchInput,
  env: Env,
  sessionId: string,
): ProviderRequest {
  if (provider === "exa") {
    const url = new URL(EXA_URL);
    if (env.EXA_API_KEY) url.searchParams.set("exaApiKey", env.EXA_API_KEY);
    return {
      url: url.toString(),
      headers: {},
      params: {
        name: "web_search_exa",
        arguments: {
          query: input.query,
          type: input.type ?? "auto",
          numResults: input.numResults ?? 8,
          livecrawl: input.livecrawl ?? "fallback",
          contextMaxCharacters: input.contextMaxCharacters ?? DEFAULT_CONTEXT_MAX_CHARACTERS,
        },
      },
    };
  }
  return {
    url: PARALLEL_URL,
    headers: env.PARALLEL_API_KEY ? { Authorization: `Bearer ${env.PARALLEL_API_KEY}` } : {},
    // Parallel takes an objective and derives its own result budget, so the
    // Exa-only tuning parameters have no equivalent here.
    params: {
      name: "web_search",
      arguments: {
        objective: input.query,
        search_queries: [input.query],
        session_id: sessionId,
      },
    },
  };
}

async function callProvider(
  provider: Provider,
  input: SearchInput,
  env: Env,
  sessionId: string,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<string> {
  const { url, headers, params } = requestFor(provider, input, env, sessionId);

  const response = await doFetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": USER_AGENT,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
  });

  const body = await readBounded(response);
  if (!response.ok) {
    // Keep a slice of the body: provider errors explain themselves there, and
    // an opaque status code makes a broken request impossible to diagnose.
    throw new Error(
      `${provider} search failed with HTTP ${response.status}: ${body.slice(0, 500).trim()}`,
    );
  }
  return parseMcpResponse(body) ?? NO_RESULTS;
}

export interface SearchOptions {
  env?: Env;
  sessionId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Runs the search, falling back to the other provider when the first one fails.
 * The keyless Exa endpoint is a courtesy service that rate-limits, so a single
 * failure should not lose a search when another provider is available.
 */
export interface SearchResult {
  provider: Provider;
  text: string;
}

export async function search(
  input: SearchInput,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const env = options.env ?? process.env;
  const doFetch = options.fetchImpl ?? fetch;
  const sessionId = options.sessionId ?? "pi";

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let lastError: unknown;
  for (const provider of providerOrder(env)) {
    try {
      return {
        provider,
        text: await callProvider(provider, input, env, sessionId, signal, doFetch),
      };
    } catch (error) {
      // A cancelled or timed-out search is the user's decision, not a provider
      // fault, so retrying elsewhere would only waste more of their time.
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("No web search provider available");
}

const description = `Search the web for current information beyond the knowledge cutoff.

Backed by a hosted search provider. With Exa (the default) the optional parameters tune result count, live crawling, search depth, and returned context size; with Parallel they are ignored because it derives its own result budget from the query.

The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`;

const parameters = Type.Object({
  query: Type.String({ description: "Search query" }),
  numResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_NUM_RESULTS,
      description: `Exa only. Number of results to return (default: 8, maximum: ${MAX_NUM_RESULTS})`,
    }),
  ),
  livecrawl: Type.Optional(
    StringEnum(["fallback", "preferred"] as const, {
      description:
        "Exa only. Live crawl mode - 'fallback': crawl only when no cached page exists, 'preferred': prioritize live crawling (default: 'fallback')",
    }),
  ),
  type: Type.Optional(
    StringEnum(["auto", "fast", "deep"] as const, {
      description:
        "Exa only. Search type - 'auto': balanced (default), 'fast': quick results, 'deep': comprehensive",
    }),
  ),
  contextMaxCharacters: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_CONTEXT_CHARACTERS,
      description: `Exa only. Maximum characters of context to return (default: ${DEFAULT_CONTEXT_MAX_CHARACTERS}, maximum: ${MAX_CONTEXT_CHARACTERS})`,
    }),
  ),
});

export default function websearchExtension(pi: ExtensionAPI) {
  // Models re-ask the same question while working through a task. Serving the
  // repeat from memory saves a round trip and a hit against the rate limit.
  // Results expire so a long session does not answer from stale news.
  let cache = new Map<string, { at: number; result: SearchResult }>();

  pi.on("session_start", () => {
    cache = new Map();
  });

  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description,
    promptSnippet: "Search the web for current information beyond the knowledge cutoff",
    promptGuidelines: [
      "Use websearch when the answer depends on current events, recent releases, or anything past the knowledge cutoff.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const key = JSON.stringify(params);
      const hit = cache.get(key);
      let result = hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.result : undefined;

      if (!result) {
        // A failed search throws here, so only real results reach the cache.
        result = await search(params, { sessionId: ctx.sessionManager.getSessionId(), signal });
        cache.set(key, { at: Date.now(), result });
      }
      const { provider, text } = result;

      return {
        content: [{ type: "text", text }],
        details: { provider, query: params.query },
      };
    },

    // Show the query next to the call, so the search is readable at a glance.
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Web Search ")) +
          theme.fg("accent", truncateLine(args.query, 100).text),
        0,
        0,
      );
    },
  });
}
