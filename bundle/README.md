# dsh-plugin-anything-bundle

The native `dsh` bundle that turns the kit's methodology into tools the model can call directly.

## Install

```sh
dsh plugin --profile <profile> add dsh-plugin-anything-bundle
dsh --profile <profile> --dump-config | grep -A3 'plugin-anything'
```

For local development against a checkout, `add ./bundle` from this repository's root.

## Tools

In pipeline order. A tool that is absent here is a gap a user cannot see.

| Tool | Use it for |
|---|---|
| `plugin_anything_probe` | Classify a target as a CLI, an HTTP API, or an MCP server, and gather the evidence that it is actually callable. **Run this first** — an MCP target should not get a plugin at all. |
| `plugin_anything_inspect` | Collect what a target actually offers, as normalised evidence: version, subcommands with their verbatim help text, top-level flags. It gathers facts and reports what it could not determine — it does not summarise or choose capabilities. |
| `plugin_anything_scaffold` | Write a bundle skeleton from the kit's templates. Existing files are never overwritten. |
| `plugin_anything_compile` | Compile a Capability IR into plugin source. The backend reads capabilities, not sources, so it produces the same code whoever wrote the IR — and reports what it declined, and why. |
| `plugin_anything_verify` | Run the kit's static gate over a bundle. Catches what is otherwise silent: a patch the gate never discovers, a row that matches nothing, an entry the Loader discards, an impure presenter. A pass is not proof the plugin boots. |
| `plugin_anything_install` | Install a bundle into a profile and prove the layer composed. The dump is inspected rather than trusted, because a misspelled patch row id produces only a warning. |
| `plugin_anything_accept` | Run the acceptance tail — build, compose, boot, discover, invoke, present, replay — and return **one verdict**. Each stage catches what the last one cannot, and a stage that could not run yields `incomplete`, never a pass. |
| `plugin_anything_package` | Produce the distribution artifact and check it carries what the manifest promises. A `files` list that has drifted from what the code reads works locally and fails for every user. |
| `plugin_anything_promote` | Freeze a live dynamic cordis package into source on disk. It writes an intermediate artifact, not a finished bundle. |

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
    # Optional. Defaults to the gate this package ships; set it to use another copy.
    verifierPath: ''
    outputDir: !!js dshHomePath('plugin-anything')
    profile: 'dev'
    timeoutMs: 120000
```

`verifierPath` is empty by default, and the verify tool then runs the copy **this package ships** at
`scripts/verify-plugin.mjs`. An installed bundle therefore needs no configuration to verify — an earlier
revision defaulted to a sibling `kit/` directory, which resolves only inside this repository, so for anyone
who installed from a tarball the gate could never be found and `verify` could never pass.

Point `verifierPath` at the kit's original only when working in a checkout and you want the gate as the kit
holds it; the two copies are kept identical by `scripts/check-shipped-copies.mjs`. Whichever path is in play,
one that does not resolve is **reported as a failure**, never as a pass the tool did not perform.

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
