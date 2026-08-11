import { describe, expect, test, vi } from "vitest";

import websearchExtension, {
  CACHE_TTL_MS,
  DEFAULT_CONTEXT_MAX_CHARACTERS,
  NO_RESULTS,
  parseMcpResponse,
  providerOrder,
  search,
} from "../extensions/websearch.ts";

const mcpBody = (text: string) => JSON.stringify({ result: { content: [{ type: "text", text }] } });
const jsonResponse = (body: string, init?: ResponseInit) =>
  new Response(body, { headers: { "content-type": "application/json" }, ...init });

/** A fetch stub that answers every call with the same body. */
const fetchStub = (body: string, init?: ResponseInit) =>
  vi.fn<typeof fetch>(async () => jsonResponse(body, init));

/** Unpacks one recorded fetch call into the parts the assertions care about. */
function requestAt(fetchImpl: ReturnType<typeof fetchStub>, index = 0) {
  const call = fetchImpl.mock.calls[index];
  if (!call) throw new Error(`no fetch call recorded at index ${index}`);
  const [url, init = {}] = call;
  return {
    url: String(url),
    headers: (init.headers ?? {}) as Record<string, string>,
    params: JSON.parse(String(init.body)).params as {
      name: string;
      arguments: Record<string, unknown>;
    },
  };
}

describe("parseMcpResponse", () => {
  test("reads a plain JSON-RPC body", () => {
    expect(parseMcpResponse(mcpBody("hello"))).toBe("hello");
  });

  test("reads the text from an SSE stream", () => {
    expect(parseMcpResponse(`event: message\ndata: ${mcpBody("from sse")}\n\n`)).toBe("from sse");
  });

  test("returns undefined for unusable bodies", () => {
    expect(parseMcpResponse("")).toBeUndefined();
    expect(parseMcpResponse("not json")).toBeUndefined();
    expect(parseMcpResponse(JSON.stringify({ error: { message: "boom" } }))).toBeUndefined();
  });
});

describe("providerOrder", () => {
  test("honours the explicit override, then the available key", () => {
    expect(providerOrder({ PI_WEBSEARCH_PROVIDER: "parallel", EXA_API_KEY: "x" })[0]).toBe(
      "parallel",
    );
    expect(providerOrder({ PI_WEBSEARCH_PROVIDER: "nonsense" })[0]).toBe("exa");
    expect(providerOrder({ PARALLEL_API_KEY: "p" })[0]).toBe("parallel");
    expect(providerOrder({ EXA_API_KEY: "e", PARALLEL_API_KEY: "p" })[0]).toBe("exa");
    expect(providerOrder({})).toEqual(["exa", "parallel"]);
  });

  test("always keeps the other provider as a fallback", () => {
    expect(providerOrder({ PI_WEBSEARCH_PROVIDER: "parallel" })).toEqual(["parallel", "exa"]);
  });
});

describe("search", () => {
  test("calls the Exa MCP endpoint with defaults applied", async () => {
    const fetchImpl = fetchStub(mcpBody("exa results"));
    const result = await search(
      { query: "pi coding agent" },
      { env: { EXA_API_KEY: "secret" }, fetchImpl },
    );

    expect(result).toEqual({ provider: "exa", text: "exa results" });
    const request = requestAt(fetchImpl);
    expect(request.url).toBe("https://mcp.exa.ai/mcp?exaApiKey=secret");
    expect(request.headers["user-agent"]).toBe("pi-websearch");
    expect(request.params).toEqual({
      name: "web_search_exa",
      arguments: {
        query: "pi coding agent",
        type: "auto",
        numResults: 8,
        livecrawl: "fallback",
        contextMaxCharacters: DEFAULT_CONTEXT_MAX_CHARACTERS,
      },
    });
  });

  test("passes an explicit context limit through", async () => {
    const fetchImpl = fetchStub(mcpBody("ok"));
    await search({ query: "q", contextMaxCharacters: 42 }, { env: {}, fetchImpl });

    expect(requestAt(fetchImpl).params.arguments.contextMaxCharacters).toBe(42);
  });

  test("calls the Parallel MCP endpoint with the session id", async () => {
    const fetchImpl = fetchStub(mcpBody("parallel results"));
    const result = await search(
      { query: "latest news" },
      {
        env: { PI_WEBSEARCH_PROVIDER: "parallel", PARALLEL_API_KEY: "token" },
        sessionId: "session-1",
        fetchImpl,
      },
    );

    expect(result).toEqual({ provider: "parallel", text: "parallel results" });
    const request = requestAt(fetchImpl);
    expect(request.url).toBe("https://search.parallel.ai/mcp");
    expect(request.headers.Authorization).toBe("Bearer token");
    expect(request.headers["user-agent"]).toBe("pi-websearch");
    expect(request.params).toEqual({
      name: "web_search",
      arguments: {
        objective: "latest news",
        search_queries: ["latest news"],
        session_id: "session-1",
      },
    });
  });

  test("falls back to the other provider when the first one fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(mcpBody("second try")));

    const result = await search({ query: "q" }, { env: {}, fetchImpl });

    expect(result).toEqual({ provider: "parallel", text: "second try" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("reports the last failure when every provider fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("upstream exploded", { status: 500 }));

    await expect(search({ query: "boom" }, { env: {}, fetchImpl })).rejects.toThrow(
      /parallel search failed with HTTP 500: upstream exploded/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does not retry after the caller aborts", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    await expect(
      search({ query: "q" }, { env: {}, fetchImpl, signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("reports no results instead of failing on an empty payload", async () => {
    const result = await search(
      { query: "nothing" },
      { env: {}, fetchImpl: async () => jsonResponse(mcpBody("")) },
    );
    expect(result.text).toBe(NO_RESULTS);
  });

  test("rejects a response body larger than the cap", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("x".repeat(300 * 1024)));
    await expect(search({ query: "huge" }, { env: {}, fetchImpl })).rejects.toThrow(/too large/);
  });
});

/** Registers the extension and returns the tool plus the captured session_start handler. */
function loadExtension() {
  let tool: any;
  let onSessionStart = () => {};
  websearchExtension({
    registerTool: (definition: any) => {
      tool = definition;
    },
    on: (event: string, handler: () => void) => {
      if (event === "session_start") onSessionStart = handler;
    },
  } as any);
  return { tool, onSessionStart };
}

const toolContext = (overrides: Record<string, any> = {}) => ({
  hasUI: false,
  ui: { confirm: vi.fn<(title: string, message: string) => Promise<boolean>>(async () => true) },
  sessionManager: { getSessionId: () => "session-abc" },
  ...overrides,
});

describe("websearch tool", () => {
  test("executes a search and returns the provider in details", async () => {
    const fetchImpl = fetchStub(mcpBody("tool results"));
    vi.stubGlobal("fetch", fetchImpl);

    const { tool } = loadExtension();
    const result = await tool.execute(
      "call-1",
      { query: "q" },
      undefined,
      undefined,
      toolContext(),
    );

    expect(result.content).toEqual([{ type: "text", text: "tool results" }]);
    expect(result.details).toEqual({ provider: "exa", query: "q" });
    expect(requestAt(fetchImpl).params.arguments.query).toBe("q");
    vi.unstubAllGlobals();
  });

  test("asks once per session before sending a query, and remembers the answer", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(mcpBody("ok")));

    const { tool, onSessionStart } = loadExtension();
    const ctx = toolContext({ hasUI: true });

    await tool.execute("call-1", { query: "first" }, undefined, undefined, ctx);
    await tool.execute("call-2", { query: "second" }, undefined, undefined, ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.ui.confirm.mock.calls[0]?.[1]).toContain("first");

    onSessionStart();
    await tool.execute("call-3", { query: "third" }, undefined, undefined, ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  test("serves a repeated query from the cache", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(mcpBody("cached results")));
    vi.stubGlobal("fetch", fetchImpl);

    const { tool } = loadExtension();
    const ctx = toolContext();

    const first = await tool.execute("call-1", { query: "q" }, undefined, undefined, ctx);
    const second = await tool.execute("call-2", { query: "q" }, undefined, undefined, ctx);

    expect(second.content).toEqual(first.content);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Different parameters are a different search.
    await tool.execute("call-3", { query: "q", numResults: 3 }, undefined, undefined, ctx);
    await tool.execute("call-4", { query: "other" }, undefined, undefined, ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  test("refetches a stale result, and drops the cache on a new session", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => jsonResponse(mcpBody("results")));
    vi.stubGlobal("fetch", fetchImpl);

    const { tool, onSessionStart } = loadExtension();
    const ctx = toolContext();

    await tool.execute("call-1", { query: "q" }, undefined, undefined, ctx);
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    await tool.execute("call-2", { query: "q" }, undefined, undefined, ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    onSessionStart();
    await tool.execute("call-3", { query: "q" }, undefined, undefined, ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("does not cache a failed search", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse("down", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse("down", { status: 500 }))
      .mockResolvedValue(jsonResponse(mcpBody("finally")));
    vi.stubGlobal("fetch", fetchImpl);

    const { tool } = loadExtension();
    const ctx = toolContext();

    await expect(tool.execute("call-1", { query: "q" }, undefined, undefined, ctx)).rejects.toThrow(
      /HTTP 500/,
    );
    const retry = await tool.execute("call-2", { query: "q" }, undefined, undefined, ctx);

    expect(retry.content).toEqual([{ type: "text", text: "finally" }]);
    vi.unstubAllGlobals();
  });

  test("fails the tool call when the user declines", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const { tool } = loadExtension();
    const ctx = toolContext({ hasUI: true, ui: { confirm: vi.fn(async () => false) } });

    await expect(tool.execute("call-1", { query: "q" }, undefined, undefined, ctx)).rejects.toThrow(
      /declined/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
