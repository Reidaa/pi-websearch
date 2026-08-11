import { describe, expect, test, vi } from "vitest";

import websearchExtension, {
  DEFAULT_CONTEXT_MAX_CHARACTERS,
  NO_RESULTS,
  parseMcpResponse,
  providerOrder,
  search,
} from "../extensions/websearch.ts";

const mcpBody = (text: string) => JSON.stringify({ result: { content: [{ type: "text", text }] } });
const jsonResponse = (body: string, init?: ResponseInit) =>
  new Response(body, { headers: { "content-type": "application/json" }, ...init });

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
    const fetchImpl = vi.fn(async () => jsonResponse(mcpBody("exa results")));
    const result = await search(
      { query: "pi coding agent" },
      { env: { EXA_API_KEY: "secret" }, fetchImpl },
    );

    expect(result).toEqual({ provider: "exa", text: "exa results" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://mcp.exa.ai/mcp?exaApiKey=secret");
    expect(init.headers["user-agent"]).toBe("pi-websearch");
    expect(JSON.parse(init.body).params).toEqual({
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
    const fetchImpl = vi.fn(async () => jsonResponse(mcpBody("ok")));
    await search({ query: "q", contextMaxCharacters: 42 }, { env: {}, fetchImpl });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).params.arguments.contextMaxCharacters).toBe(
      42,
    );
  });

  test("calls the Parallel MCP endpoint with the session id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(mcpBody("parallel results")));
    const result = await search(
      { query: "latest news" },
      {
        env: { PI_WEBSEARCH_PROVIDER: "parallel", PARALLEL_API_KEY: "token" },
        sessionId: "session-1",
        fetchImpl,
      },
    );

    expect(result).toEqual({ provider: "parallel", text: "parallel results" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://search.parallel.ai/mcp");
    expect(init.headers.Authorization).toBe("Bearer token");
    expect(init.headers["user-agent"]).toBe("pi-websearch");
    expect(JSON.parse(init.body).params).toEqual({
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
  ui: { confirm: vi.fn(async () => true) },
  sessionManager: { getSessionId: () => "session-abc" },
  ...overrides,
});

describe("websearch tool", () => {
  test("executes a search and returns the provider in details", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(mcpBody("tool results")));
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
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).params.arguments.query).toBe("q");
    vi.unstubAllGlobals();
  });

  test("asks once per session before sending a query, and remembers the answer", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(mcpBody("ok")));

    const { tool, onSessionStart } = loadExtension();
    const ctx = toolContext({ hasUI: true });

    await tool.execute("call-1", { query: "first" }, undefined, undefined, ctx);
    await tool.execute("call-2", { query: "second" }, undefined, undefined, ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("first");

    onSessionStart();
    await tool.execute("call-3", { query: "third" }, undefined, undefined, ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
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
