# dsh-plugin-anything-bundle

The native `dsh` bundle that turns the kit's methodology into tools the model can call directly.

## Install

```sh
dsh plugin --profile <profile> add dsh-plugin-anything-bundle
dsh --profile <profile> --dump-config | grep -A3 'plugin-anything'
```

For local development against a checkout, `add ./bundle` from this repository's root.

## Tools

| Tool | Use it for |
|---|---|
| `plugin_anything_probe` | Classify a target as a CLI, an HTTP API, or an MCP server, and gather the evidence that it is actually callable. **Run this first** — an MCP target should not get a plugin at all. |
| `plugin_anything_scaffold` | Write a bundle skeleton from the kit's templates. Existing files are never overwritten. |
| `plugin_anything_verify` | Run the kit's static gate over a bundle. |
| `plugin_anything_install` | Install into a profile and confirm the layer composed. |
| `plugin_anything_promote` | Freeze a live dynamic cordis package into a bundle on disk. |

`plugin_anything_promote` registers **only where the cordis runtime is mounted**. `cordis-host-runner` lives
in the `dsh-web-app` bundle and is absent from `dsh-base`, so a headless profile has no dynamic packages for
it to read and does not get the tool. A tool that exists and always fails is worse than one that is not
there.

## Config

Every field has a default; state only what you override.

```yaml
- id: plugin-anything
  name: 'dsh-plugin-anything-bundle'
  config:
    verifierPath: '/abs/path/to/kit/scripts/verify-plugin.mjs'
    outputDir: !!js dshHomePath('plugin-anything')
    profile: 'dev'
    timeoutMs: 120000
```

`verifierPath` is empty by default, in which case the verify tool falls back to the sibling
`kit/` directory. A separately-installed bundle must set it — and if neither path
resolves, the tool **reports the failure** rather than reporting a pass it did not perform.

## What this bundle does not do

It does not reimplement the kit's rules. The static gate stays in
`kit/scripts/verify-plugin.mjs` and this plugin shells out to it, so there is one
implementation of each rule rather than two that drift.

`plugin_anything_promote` writes the package body it read; it does not invent the surrounding manifest and
patch. That is `plugin_anything_scaffold`'s job, so the template story keeps a single source of truth.

## Development

```sh
# Pure logic — runs without @deepseek-ai/* installed, because nothing under test imports it.
node --experimental-strip-types --test tests/scaffold.test.mjs

# Render from the real templates and run the real gate over the result.
node --experimental-strip-types --test tests/pipeline.test.mjs

# Render the committed example.
node --experimental-strip-types scripts/render-example.mjs git
```

`src/backend.ts` is the **only** module here that touches the filesystem or spawns a process. That is the
same rule this project enforces on the bundles it generates (`HARNESS.md` rule 1), applied to itself.
