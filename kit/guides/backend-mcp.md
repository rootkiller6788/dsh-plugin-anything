# Backend: an MCP server (usually, do not generate a plugin)

If the target already speaks Model Context Protocol, **generating a plugin duplicates a path that already
works.** Stop and hand the user a config row instead.

## Why

`packages/mcp/mcp-client` bridges MCP servers into ordinary tools. One plugin instance per server; its tools
arrive as normal `ctx.tools` entries under native names, so the model sees them exactly as it sees a
hand-written tool — no wrapper package, no build, no publishing.

## What to give the user

An opt-in row in their `cordis.yml` (or their profile's `cordis.patch.yml`):

```yaml
- id: mcp-<serverName>
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: '<serverName>'          # required; this is the tool-name namespace
    transport: streamable-http          # or: stdio
    url: 'https://example.com/mcp'      # for streamable-http
    # command: 'npx'                    # for stdio
    # args: ['-y', '@some/mcp-server']
    # cwd: '/path'
    # env: { TOKEN: !!js process.env.SOME_TOKEN }
    # headers: { Authorization: !!js `Bearer ${process.env.SOME_TOKEN}` }
    toolCallTimeoutMs: 60000            # default
    failOnStartupError: false           # default
    # reconnect: { enabled: true, initialDelayMs: …, maxDelayMs: …, maxAttempts: … }
```

It is **not** mounted by any bundle or preset — it is deliberately opt-in, so the row is required.

## Tool naming

Tools register as `mcp__<serverName>__<rawName>` — *"the same server-qualified shape Claude Code and Codex
use"* — normalized to the 64-character `[A-Za-z0-9_-]` function-name contract, with a deterministic 12-hex
hash of `(serverName, rawName)` appended when normalization changes the name.

Names are pure functions of those two strings, so a reconnect never renames a tool. Registration happens
before the first turn; `notifications/tools/list_changed` re-syncs, and a registration conflict rolls back
the whole generation.

**Only Tools are bridged** — Resources and Prompts are deferred. If the target's value is in its Resources,
an MCP row does not get you there and a plugin may be justified after all.

## When a plugin IS justified despite MCP

- The target's value is in Resources or Prompts, not Tools.
- You need the MCP server's tools **plus** additional behavior: argument reshaping, a second backend, a
  different render intent, or a policy gate. The bridge is a faithful pass-through; anything the model
  needs beyond a faithful pass-through belongs in a plugin that either wraps the same API directly or
  composes with the bridge's tools.
- The MCP server is unavailable as a server and only its underlying API is reachable.

## Deciding

Ask, in order:

1. Does it expose MCP Tools that cover what the user needs? → config row. Done.
2. Does it expose MCP but only Resources/Prompts? → plugin, calling the same API those resources come from.
3. No MCP? → see `backend-cli.md` or `backend-http.md`.
