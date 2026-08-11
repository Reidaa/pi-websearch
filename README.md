# pi-websearch

A `websearch` tool for [pi](https://pi.dev), ported from opencode's v2 web search tool.
It sends one JSON-RPC `tools/call` request to a hosted MCP search endpoint, so there
is no MCP client to run and no API key needed to get started.

## Install

```bash
pi install npm:pi-websearch
# or, to try it without installing
pi -e ./extensions/websearch.ts
```

## Usage

The model calls the tool itself:

```
> what changed in Node 26?
```

Parameters: `query` (required), plus `numResults` (default 8, max 20), `livecrawl`
(`fallback` | `preferred`), `type` (`auto` | `fast` | `deep`), and
`contextMaxCharacters` (default 10000, max 50000). The optional four apply to Exa
only; Parallel derives its own result budget from the query.

Before the first search of a session, pi asks you to approve sending queries to an
external provider. The answer is remembered until the session restarts. Headless
runs (`pi -p ...`) never prompt.

## Providers

| Env var                 | Effect                                                         |
| ----------------------- | -------------------------------------------------------------- |
| `PI_WEBSEARCH_PROVIDER` | Force `exa` or `parallel`                                      |
| `EXA_API_KEY`           | Use your own Exa quota (Exa also works without a key)          |
| `PARALLEL_API_KEY`      | Required for Parallel; selects Parallel when no Exa key is set |

Default is Exa. Both endpoints work unauthenticated, and a key only buys you your
own quota. If the chosen provider fails, the other one is tried once, because the
keyless endpoints rate-limit.

## Development

```bash
npm run check   # oxfmt --check, oxlint, vitest
npm run format  # oxfmt in place
npm test        # vitest
```
