---
name: dsh-plugin-anything-bundle
description: Build a real, installable DeepSeek Harness plugin bundle for any target — an external CLI, an HTTP API, a local service — and promote a live dynamic cordis package to disk. Use when the user wants some tool or service turned into a dsh plugin, or an existing plugin bundle verified or installed.
whenToUse: The user asks to turn a tool, CLI, or service into a dsh plugin, or to verify, install, or promote one.
---

# Building a dsh plugin bundle

This is the procedure. Read it, then work through the phases with your ordinary tools — `read`, `write`,
`edit`, `bash`. **Most of this is not tool work.** Two steps must go through a tool, and this document says
which and why.

## First: read the SOP

The full procedure ships inside this package at:

```
sop/SOP.md
```

**Find the package, not the file.** This skill has no reliable way to know its own install path, so locate
the directory instead:

```sh
# From a dsh profile directory, this resolves. Elsewhere, search for it.
node -e "console.log(require('node:path').dirname(require.resolve('dsh-plugin-anything-bundle/package.json')))"
```

If that fails, search for the package by name — `**/dsh-plugin-anything-bundle/sop/SOP.md`. Do **not** go
looking for a file called `HARNESS.md`: that is the *authoring kit's* own SOP, a different document that
happens to cover the same ground. If you find both, the one inside `dsh-plugin-anything-bundle` is yours,
and the kit's is not installed with this plugin.

**If you cannot find the SOP at all**, say so and proceed using the rules inlined in this document. Do not
improvise around the gap silently — the SOP carries contract details (the patch rules, the manifest, the
testing policy) that are not repeated here, and a bundle built without them will look right and fail to
load.

Also in the package: `templates/` (what a bundle is assembled from) and `scripts/verify-plugin.mjs` (the
gate).

## What you are producing

One **plugin bundle** — a directory with a `package.json` declaring `dsh.bundle.patch`, a `cordis.patch.yml`,
and compiled `lib/`. A user installs it with `dsh plugin add` and keeps it across restarts.

Three rules override everything:

1. **Wrap the real system. Never reimplement it.** Exactly one module in the bundle touches the outside
   world (`src/provider.ts`); every other module is pure logic that tests without the backend installed.
2. **Render intent is part of the design.** Decide `generic` / `terminal` / `diff` and `locations` up front.
3. **Presenters are pure.** `presentCall` and `presentResult` run on live streaming *and* on replay — no I/O,
   no clock, no randomness. `presentResult` receives a `ToolResult` (`{ content, isError, meta? }`), **not**
   your canonical value; project what a card needs through `output.presentationMeta`.

## The phases

| # | Do this | Produces |
|---|---|---|
| 0 | Establish that the target is callable. **If it speaks MCP, stop** — see below. | evidence |
| 1 | Decide **Consumer or seam** (default: Consumer). Map the target's capabilities to 4–8 tools. | a tool list |
| 2 | Decide plugin form, `Config` fields, render intents, and the patch rows. | a design |
| 3 | Write `src/provider.ts`, one module per tool, `src/index.ts`, `cordis.patch.yml`, `package.json`. | source |
| 4–6 | Plan tests **before** writing them, then unit + a keyless snapshot. | `tests/` |
| 6.5 | Write `skills/<name>/SKILL.md` and mount it. | a skill |
| 7 | Build, then install. | a running plugin |

### Phase 0 — the MCP stop condition

If the target exposes an MCP endpoint, **do not build a plugin.** `dsh` already bridges MCP servers and
their tools arrive as ordinary `ctx.tools` entries. Tell the user to add this to their profile's
`cordis.patch.yml` instead:

```yaml
- insert:
    - id: mcp-<serverName>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: '<serverName>'
        transport: streamable-http
        url: 'https://…'
```

Generating a plugin for an MCP server duplicates a path that already works.

## Where a tool is required, and where it is not

You can do most of the phases yourself. Two cannot be done any other way:

### `plugin_anything_verify` — required after every edit to generated files

The gate is deterministic and it is not re-derivable. Run it; do not reimplement its checks from the
description:

```
plugin_anything_verify({ path: '<the bundle directory>' })
```

It reads the gate shipped in this package. If it reports it cannot find the gate, **that is a failure, not a
pass** — set the `verifierPath` config to the absolute path of
`<package root>/scripts/verify-plugin.mjs`.

The kinds of mistake it catches are the ones that fail **silently**: a patch file the loader's glob never
sees, `!!js` in a position it is not interpolated, a row whose `name` does not resolve, a function plugin the
Loader discards. A bundle can look perfectly correct and do nothing.

### `plugin_anything_promote` — required to freeze a live dynamic package

If the user already has something working as a **dynamic cordis package** (created by `cordis_define` and
activated by `cordis_run`), do not rebuild it from scratch. It dies on restart; promotion is how it survives:

```
plugin_anything_promote({ pluginId, packageId, target, outputDir })
```

It reads the package through `ctx.dynamicCordisRunner.inspectPackage(agent, pluginId, packageId)` — a service
you cannot reach with bash. It registers only where that runtime is mounted (`dsh-web-app` provides it;
`dsh-base` does not), so its absence from your tool list means this profile cannot promote, not that you
should look for another route.

**It writes an intermediate artifact, not a finished bundle.** The body is a sandbox function body: it uses
globals the sandbox provided and opens with a top-level `return`. Your job is the conversion — real imports,
`Config` fields, load-time validation — and it will not compile until you do it. Keep the original file: it
is the record of what actually ran.

### Everything else you do yourself

- **Probing the target** — `which`, `--help`, a `curl`, reading its source.
- **Writing the files** — `templates/` in this package shows the exact shape of each one, including the
  contract as comments. `plugin_anything_scaffold` will render them for you if you prefer a starting point,
  but it fills only what it can derive and leaves `TODO(...)` markers for the rest.
- **Building** — `npx tsdown` in the bundle directory. **The build must produce the file `main` names.**
- **Installing** — `dsh plugin --profile <p> add <path-or-package>`, then `--dump-config`.
- **Testing** — unit tests for logic, and a keyless snapshot through a real runnable example. A hand-written
  fixture is not a substitute. `HARNESS.md` §8 owns this policy.

## Verify in the order that actually catches things

Each of these catches what the one before it cannot:

```sh
# 1. The gate. Catches silent contract violations.
plugin_anything_verify({ path: '<bundle>' })

# 2. The build produced what the manifest names.
cd <bundle> && npx tsdown && test -f "$(node -p "require('./package.json').main")"

# 3. It composes — necessary, NOT sufficient.
dsh plugin --profile <p> add <bundle>
dsh --profile <p> --dump-config | grep '<your-row-id>'

# 4. It BOOTS. --dump-config does not detect duplicate loader entry ids, so a clean dump can still fail here.
dsh --profile <p> "reply with: BOOT-OK"

# 5. The agent can actually use it.
dsh --profile <p> "call <your tool> and report the result"

# 6. RESTART, then repeat 5. Surviving a restart is the whole point.
```

Step 3 passing is the most likely thing to fool you. A patch that matches no row is only a stderr warning;
a profile can dump cleanly and fail at boot.

## Prohibited

- Reimplementing the target instead of driving it.
- More than one module touching the outside world.
- `export default` on a function plugin — the Loader discards its namespace.
- Content blocks returned from `execute`; that is `output.render`'s job.
- I/O, clocks, or randomness inside a presenter.
- Hand-written fixtures standing in for a snapshot.
- Writing a bundle from `git:` install instructions without saying that it runs the package's code at install
  time, outside any sandbox.
