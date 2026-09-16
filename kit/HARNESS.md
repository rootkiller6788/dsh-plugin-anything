# Agent Harness: Anything-to-Plugin for DeepSeek Harness

## Purpose

This harness is the standard operating procedure (SOP) for turning **an arbitrary target** — an external
CLI, an HTTP/REST API, a local service, a file format, a device, anything with an operable surface — into a
**DeepSeek Harness plugin bundle** that a `dsh` agent can load, call, and keep using after a restart.

The target is not "a CLI". `dsh` is built on vendored Cordis, where **everything is a plugin**: the model
adapter, the tool registry, the session log, and the agent loop itself are all plugins, with no privileged
core. So the unit of delivery here is a plugin, and the question this harness answers is not
"how do I wrap this in a command line" but **"which plugin shape does this target deserve, and how do I
emit one that actually loads"**.

This SOP is a deliberate structural mirror of CLI-Anything's `HARNESS.md`. Every phase here has a
counterpart there; §1 records the mapping so the two stay comparable.

## Read this first

Three rules override everything else in this document.

### Rule 1 — Wrap the real system. Never reimplement it.

The generated plugin MUST drive the actual target: spawn the actual binary, call the actual endpoint.
The target is a **hard dependency**, and its absence is a loud failure, not a degraded mode.

There must be **exactly one module in the generated plugin that touches the outside world**. Every other
module is pure logic. This is the isomorphic counterpart of CLI-Anything's
`utils/<software>_backend.py` and it is the single most important structural constraint here, because it
is what makes the plugin testable without a live target.

### Rule 2 — Render intent is part of the design. Decide it up front.

`dsh`'s `AGENTS.md` is explicit:

> A tool's UI render intent is part of its design, decided up front (`generic`/`terminal`/`diff`, `locations`).

Never pick a card style after the fact. A plugin wrapping a CLI defaults to a `terminal` call card; one that
produces or edits files defaults to `diff` with populated `locations`; everything else is `generic`.
This is the isomorphic counterpart of CLI-Anything's "Rendering Gap" rule.

### Rule 3 — The presenter is a pure function. It also runs on replay.

`presentCall` and `presentResult` execute on live streaming **and** when a session log is replayed. No I/O,
no session state, no clock, no randomness. If you want the file's old content or the working directory
inside a presenter, you have picked the wrong place — that belongs in durable result metadata or the UI
adapter. A malformed historical argument returns `undefined` (generic fallback); it never throws.

## §1 Mapping to CLI-Anything

| CLI-Anything phase | This harness | What changes |
|---|---|---|
| 0 Source acquisition | **0 Target acquisition** | Clone/verify a source tree → establish that a callable surface exists and actually call it |
| 1 Codebase analysis | **1 Capability surface analysis** | "Find the backend engine, map GUI actions to API calls" → decide **seam vs Consumer** and map capabilities to tools |
| 2 CLI architecture design | **2 Plugin architecture design** | "REPL vs subcommand, command groups, `--json`" → plugin **form**, `Config` fields, tool set, render intents, patch rows |
| 3 Implementation | **3 Implementation** | `core/` + `utils/backend.py` → `src/` + `src/provider.ts`; `click` groups → `defineTool` |
| 4 Test planning | **4 Test planning** | `TEST.md` → keyless **snapshot** plan |
| 5 Test implementation | **5 Test implementation** | `test_core.py` + `test_full_e2e.py` → unit + snapshot + e2e |
| 6 Test documentation | **6 Test documentation** | Append pytest output → append snapshot replay result |
| 6.5 SKILL.md generation | **6.5 SKILL.md generation** | Same idea, dsh frontmatter rules |
| 7 PyPI publishing | **7 Bundle distribution** | `setup.py` + PyPI → `package.json` + three install channels |
| `registry.json` + `cli-hub` | **Registry contribution** | **Reuse `awesome-dsh-plugin`; do not build a hub** |

## §2 Phase 0 — Target acquisition

Establish three things before designing anything.

1. **What kind of surface does the target have?** Classify as exactly one of:
   - **CLI binary** — has an executable that accepts arguments (`git`, `ffmpeg`, `blender --background`).
   - **HTTP/REST API** — has endpoints reachable over the network.
   - **MCP server** — already speaks Model Context Protocol.
2. **Prove it is callable.** Run it. Record the literal invocation and its observed output. An assumed
   surface is not an acquired one.
3. **Derive the plugin name.** Lowercase, kebab-case, from the target: `dsh-plugin-<target>`.

### If a dynamic package already exists

There is a second way into this harness: the user may already have a working plugin that lives only in
`dsh`'s process memory, produced by the `cordis` preset's `cordis_define` / `cordis_run` tools. That code
runs today and disappears on restart.

Do not regenerate it from scratch. **Promote** it — a source transformation from the dynamic package into a
real bundle, which is what `plugin_anything_promote` does. It is a transformation rather than a copy, and it
carries a real escalation of trust: sandboxed in-memory code becomes unsandboxed code on disk. Read
`guides/static-promotion.md` before promoting anything.

### Stop condition: the target is already an MCP server

If the target exposes an MCP endpoint, **do not generate a plugin**. `dsh` already bridges MCP servers:
`packages/mcp/mcp-client` runs one plugin instance per server, and their tools arrive as ordinary
`ctx.tools` entries under native names `mcp__<serverName>__<rawName>`.

Tell the user to add an opt-in row to their `cordis.yml` instead:

```yaml
- id: mcp-<serverName>
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: '<serverName>'
    transport: streamable-http
    url: 'https://…'
```

Generating a plugin for an MCP server duplicates a path that already works. See `guides/backend-mcp.md`
for the config row to hand the user instead, and for the cases where a plugin is justified anyway.

For the other two surfaces: **`guides/backend-cli.md`** (spawning a binary, the `terminal` render intent,
exit-status-as-data) and **`guides/backend-http.md`** (credentials as `Config`, pagination, response
validation).

## §3 Phase 1 — Capability surface analysis

### Decide the shape: seam or Consumer

A **capability seam** comprises three roles — Service Definition, Service Provider, Consumer — and it is
complete, never one role. Split the roles only when they evolve independently. The full decision criteria,
and the promotion path if a second implementation later appears, are in **`guides/seam-vs-consumer.md`**.

For almost every target, the answer is **Consumer only**: register tools that call the target. You do not
need a seam, because the target is not a capability other plugins will provide alternative implementations of.

Choose **seam** only when all of these hold:
- More than one implementation is plausible (`git`, `hg`, and `jj` behind one version-control capability).
- Other plugins would consume the capability rather than the tool.
- The roles genuinely change for different reasons.

Getting this wrong in the seam direction is expensive and hard to undo. Default to Consumer.

### Map capabilities to tools

List what the target can do, then group it. The in-repo norm (`packages/fs/tool-fs/src/index.ts`) is:

> **One plugin package registers several tools from one `apply`, with the definitions in sibling modules.**

So a 12-verb CLI becomes one plugin registering 4–8 tools grouped by intent, not 12 tools and not 1.

For each tool record: name, one-line description (this is what the model reads), parameters, the **render
intent**, and the canonical output value. A tool without a decided output schema is not designed yet.

### Identify the data model and state

- What state must survive between calls? Prefer **nothing**: stateless tools are vastly easier to make
  correct. State that must persist belongs in the target's own storage or in session events, not in a
  module-level variable (module-scope side effects are prohibited).
- How does the target serialize its data? Reuse its native format rather than inventing a parallel one.

## §4 Phase 2 — Plugin architecture design

### Choose the plugin form

| Form | Export shape | When |
|---|---|---|
| **Function plugin** | `export const name`, `export const inject`, `export const Config`, `export function apply` — **no default export** | Default choice for tool plugins |
| **Service plugin** | `export default class X extends Service` | Only when you are contributing a service others consume |

**These must not be mixed.** `packages/AGENTS.md`:

> Service packages default-export their service class; function plugins named-export `name`/`inject`/`Config`/`apply`
> and have no default export. Mixing the forms makes the Loader discard the function plugin's namespace.

See `docs/postmortem/0001-acp-default-export-drops-inject.md` in the dsh repo for the incident that produced this rule.

### Declare `Config` with Schemastery — and give every field a default

```ts
export interface Config { timeoutMs?: number }
export const Config: z<Config> = z.object({ timeoutMs: z.number().default(30_000) })
```

Then, inside `apply`, narrow once:

```ts
const resolved = config as Required<Config>   // Schemastery already filled every defaulted field.
```

Validate the values that would fail silently. `packages/fs/tool-fs/src/index.ts` throws from `apply` via an
`assertPositiveInteger` helper, because a non-positive integer would make window arithmetic misbehave
without erroring. **Misconfiguration fails loud.**

Any value a deployment could reasonably vary is a validated `Config` field changeable from `cordis.yml`.
A `DEFAULT_*` constant or a test hook is not configurability.

### Design the patch rows

Your bundle ships a `cordis.patch.yml`. Two row kinds matter:

```yaml
# Disable a shipped row you are replacing. A patch replaces the target row's
# whole `config`, so if you only wanted to change one key, restate all of them.
- id: <shipped-row-id>
  disabled: true

# Insert your own rows.
- insert:
    - id: <your-row-id>
      name: '<your-package-name>'
      config: { /* … */ }
```

Hard rules for this file — each is enforced by a gate in the dsh repo, and this repo mirrors them:

1. **The filename must contain `cordis`.** The gate's discovery glob is `**/*cordis*.yml|yaml`; a file
   named `plugin.yml` is invisible to it.
2. **The root is a top-level YAML array.** An empty or comments-only file **throws** — it parses to nothing,
   not to a list. Use `[]` to disable a layer.
3. **`!!js` is valid only under `config` (any depth) and under `disabled`.** Everywhere else it is the error
   `!!js is not interpolated here`. In scope: `process`, `ctx` (the row's own context, so `ctx.<injectedName>`),
   and `dshHomePath(...)`.
4. **`name:` must be the package name, never a relative path.** Node resolution is what finds the installed
   code.
5. **A bare plugin name must be declared in your bundle's `package.json` `dependencies`**, or the gate
   reports `<file>: <pkg> must be declared in <manifest> dependencies`.
6. **Row order carries no load semantics.** Activation is service-availability driven — sequence plugins with
   `inject`, never by listing order.
7. **A patch that matches no row is only a stderr warning.** A typo'd `id` silently does nothing. Verify with
   `dsh --profile <name> --dump-config`.

### Decide the skill

Skills are plain files wired by a config row; there is no skill-packaging mechanism in a bundle, and no
in-repo package ships one. If your plugin needs teaching, ship `skills/<name>/SKILL.md` and add a
`skill-filesystem` row pointing at it (see `guides/skill-authoring.md`).

**Do not assume the host provides skill discovery.** `dsh-base` inserts `skill-filesystem` + `tool-skill`,
then `dsh-web-app` disables both so presets own local discovery; only the `cordis` preset re-mounts
`tool-skill`. Ship your own mounting row.

## §5 Phase 3 — Implementation

Build in this order. Each step is complete before the next.

1. **`src/provider.ts`** — the one module that touches the target. No tool definitions here; it exposes
   plain async functions. It MUST honor the abort signal it is handed.
2. **`src/<tool>.ts`** — one module per tool, each exporting an `apply<Name>Tool(ctx, …)` function that
   registers one definition, mirroring `tool-fs`'s `read.ts`/`write.ts`/`edit.ts` split.
3. **`src/index.ts`** — named exports, `Config`, `apply` wiring the tool modules, plus fail-loud `assert*`
   checks and any `ctx.inject([...], …)` conditional registration.
4. **`cordis.patch.yml`** — the rows from Phase 2.
5. **`package.json`** — see §6.
6. **`README.md`** — the target's prerequisites and the literal commands to install and verify.

### Tool definition contract

`ctx.tools.register(definition)` where `definition` comes from `defineTool`. The full option set is in
`guides/tool-contract.md`; the load-bearing parts:

```ts
ctx.tools.register(defineTool({
  name: 'target_do_thing',
  description: 'One line the model reads.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute path' },
    limit: { type: 'number' },                       // optional by default
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
}))
```

Four things that are commonly assumed wrong:

1. **The tool input schema is neither Schemastery nor raw JSON Schema.** It is a purpose-built DSL
   (`ParameterSchemaSpec` for the implicit open parameter object, `ValueSchemaSpec` for the output root),
   supporting `string`, `number`, `integer`, `boolean`, `null`, `array`, `object`, author-only `json`, and
   exact-one `oneOf`. Every explicit DSL object declares `additionalProperties: true | false`.
   **Two different schema languages in one file is the normal case, not a mistake.**
2. **`execute` has no `ctx` parameter.** It is `(args, exec)`. The body closes over `apply`'s `ctx`
   lexically. `exec` is the execution record — `{ token, callId, name, arguments, signal, agent?, parent? }`
   plus `deferContext(context)`. **`exec.signal` is the abort signal and must be honored.**
3. **`execute` returns the canonical JSON value declared by `output.schema`, not content blocks.**
   The registry snapshots it as lossless JSON, validates it, freezes it, then calls `output.render(args, value)`
   — that `ContentBlock[]` is what the model sees. Do not return prose from the body, and do not make
   callers parse text for ids and fields.
4. **`defineTool` validates the model's `arguments` before `execute` runs**, throwing `ToolArgsError`
   (`INVALID_ARGS`). `args` is typed from `parameters`; the return type is inferred from `output.schema`.

### Render intent

Attach presenters to the definition. Returning `undefined`, or omitting the method, selects the generic
fallback (title = tool name, raw args as input).

```ts
presentCall(args) { return { card: 'terminal', title: `git ${args.args.join(' ')}`, cwd: args.cwd } }
presentResult(args, result) { return { card: 'terminal', title: 'git', output: result.stdout } }
```

Call cards: `generic` (`title`, optional `kind`, `rawInput`, `content`, `locations`), `terminal`
(`title` = the command, optional `description`, `cwd`), `diff` (`title`, `diffs`, `locations`).
Result cards: `generic`, `terminal`, `diff`, `search`, `read`, `web`. `locations` is `FileLocation[]`
(`{ path, line? }`) — the files this call reads or modifies, so a capable editor follows along.

**UI-only formatting stays out of the model result.** A fenced ```` ```console ```` block, a diff, or a
relativized path never belongs in the canonical value or the Native content merely to serve a UI.

### Registration is an effect

Every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer.
A `ctx.tools.register(...)` called on a `ctx` obtained inside `apply` is already owned by that fiber and is
disposed with it — you need **no manual cleanup**. Correspondingly, a registry that contributes must come
with an HMR-safety test: dispose the contributing fiber and assert cleanup.

Never move a registration to module scope. Module-scope side effects are prohibited.

## §6 Phase 7 (package) — The bundle manifest

The out-of-tree contract is dramatically smaller than the in-tree one. There are exactly two shapes; pick
one, and do not mix fields between them.

### Shape A — plain JavaScript, no build step

Everything required is these six fields. `dsh`'s own `publish.md` walkthrough uses this shape.

```json
{
  "name": "dsh-plugin-<target>",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

No `exports` map is needed, because the patch is resolved from the package directory rather than by subpath.
This is the shape with the fewest ways to go wrong: nothing to build, no `prepare` script, and it installs
from npm or a tarball with no build permission.

### Shape B — TypeScript, built

`this` kit's `templates/package.json.template` is Shape B, because the tool DSL and `Config` types are
intricate enough that type checking is how you get them right.

```json
{
  "name": "dsh-plugin-<target>",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**The `exports["./cordis.patch.yml"]` entry is required in Shape B and only in Shape B.** Once `main` moves
under `lib/`, the package root is no longer a path Node will resolve through, so the patch has to be
declared as a subpath. Omitting it produces a bundle that installs, contains its patch, and cannot be
resolved. `scripts/verify-plugin.mjs` enforces the conditional: it requires the `exports` entry exactly
when `main` starts with `lib/`.

Either shape is correct. What is not correct is Shape A's `main` with Shape B's `files`, or vice versa.

**The in-tree contract does not apply here.** If you are contributing to the `dsh` monorepo instead, a
different and much stricter set applies — see `guides/in-tree-vs-out-of-tree.md`. Do not mix the two.

> **Documentation warning.** `dsh`'s `docs/cookbook/adding-a-package.md` states that in-tree packages
> require `"private": true`. That is **stale**. `scripts/check-workspace-constraints.ts` currently requires
> `packages/*/*`, `apps/*`, and `vendor/*` to be publishable-shaped — no `private`, plus
> `publishConfig.access: "public"` and an exact `repository.directory`. `private: true` is the fallback for
> directories outside those three prefixes. Verified: zero manifests under `packages/*/*` set it.
> **Trust the gate source, not the prose.** (`private: true` belongs only on a *profile* manifest.)

## §7 Phase 7 (distribution) — Ship it

Three channels. There is no plugin registry to publish to.

```sh
dsh plugin --profile <p> add ./dsh-plugin-<target>          # local checkout (link:)
dsh plugin --profile <p> add dsh-plugin-<target>            # npm
dsh plugin --profile <p> add github:you/dsh-plugin-<target> # git, optionally #<sha>
dsh plugin --profile <p> add ./dsh-plugin-<target>-0.1.0.tgz # pnpm pack
dsh --profile <p> --dump-config                             # verify: look for "# == <bundle>"
```

`dsh plugin` is a thin pnpm forwarder: it runs `pnpm <args>` in the profile directory, then reconciles
`dsh.profile.bundles` against the installed state.

### What "installed" looks like on disk

The profile directory is `$DSH_HOME/profiles/<name>/`, where `$DSH_HOME` falls back to `~/.dsh`. It holds
three files, and the reconciled state is in the first:

```
$DSH_HOME/profiles/<name>/
├── package.json        # dependencies + dsh.profile.bundles — the reconciliation target
├── cordis.patch.yml    # the USER's own layer, applied after every bundle layer
└── pnpm-workspace.yaml # written on init; also where a git install's allowBuilds entry goes
```

After an install the manifest records both the dependency and the layer, and these two must agree:

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": { "dsh-plugin-<target>": "link:/path/to/dsh-plugin-<target>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-<target>"] } }
}
```

**`private: true` belongs here and nowhere else.** A profile is never published; a package that is
published must not set it (§6). This is a useful thing to audit rather than resolve: a bundle whose profile
manifest is missing the package from either `dependencies` or `bundles` is installed-but-inert, and
`dsh --profile <p> --dump-config` will silently lack its layer.

**Prefer the npm or tarball channel.** The git channel fetches *sources, not built artifacts*, so it requires
a self-contained `prepare` script that must not assume a sibling monorepo — and pnpm ≥10 refuses to run a git
dependency's `prepare` until the user adds it to `allowBuilds` in the profile's `pnpm-workspace.yaml`. That
allowance is **permission to execute the package's code on the user's machine at install time, outside any
sandbox the agent runs under.** Treat it that way: recommend npm or a tarball, and if git is genuinely
required, pin a commit and say the risk out loud.

Full detail — what `dsh plugin` actually does, the layer order, the profile layout, and the published
dist-tag trap that makes a bare `npm install` fetch the wrong version — is in `guides/bundle-distribution.md`.

## §8 Phases 4–6 — Testing

Plan tests **before** writing them. The dsh testing policy is stricter than CLI-Anything's and it is the part
most likely to be skipped.

| Layer | Runs with | Covers |
|---|---|---|
| **Unit** | No target, no API key | Pure logic and provider argument construction |
| **Snapshot** | No API key | The model- and user-visible behavior: a real runnable example's full transcript |
| **E2E** | Real target (+ `DEEPSEEK_API_KEY` where a model is involved) | The actual backend call |

**The snapshot layer is mandatory and is not satisfied by unit tests.** `dsh`'s policy:

> Every non-trivial model- or product-user-visible behavior change adds or updates a keyless snapshot through
> a real runnable example in the same PR; package tests, e2e-only assertions, and mock-only fixtures do not
> substitute for the assembled application transcript.

So: a tool that the model can see requires a snapshot produced by really running it, not a hand-written
fixture. Fixtures must replay on macOS and Linux — fix the fixture, never the normalizer. A presenter must be
exercised against a replayed log with deliberately malformed arguments, asserting the generic fallback.

Write `tests/TEST.md` first (the plan), then the tests, then append the actual output. The `test` command
leaves `TEST.md` untouched on failure.

Two rules from the dsh policy that decide whether your tests are evidence at all: **verify the world, not
the self-report** (re-run the command or re-read the file externally — a keyword probe on the model's own
output lets a cheating agent pass), and **a guard only guards if the regression actually fails it**
(introduce the regression, watch red, revert). Both are worked through, with the real-composition
requirement for product-visible plugins, in `guides/snapshot-testing.md`.

## §9 Phase 6.5 — SKILL.md generation

Frontmatter rules, verified against `packages/skill/skill-filesystem/src/index.ts`:

- The file must open with a line that is **exactly** `---`, closed by another `---` line. No BOM, no leading blank.
- **Required**: `name` matching `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, and a non-empty `description`.
- **Optional**: `whenToUse` (string), `metadata` (opaque object), `disable-model-invocation`, `user-invocable`.
- **Legacy camelCase keys throw** (`disableModelInvocation`, `modelInvocable`, `userInvocable`).
- Booleans accept `true/false`, `1/0`, `true|yes|on` / `false|no|off`.
- Two accepted shapes: a directory bundle `<name>/SKILL.md` or a flat `<name>.md`.
  **Recursive `**/SKILL.md` is unsupported.**
- Invalid frontmatter is logged and skipped — never fatal.

```markdown
---
name: dsh-plugin-<target>
description: One line describing when this skill applies.
---

Body: what the target is, its prerequisites, and the tools this plugin exposes.
```

Ship it **inside the plugin package**, at `skills/<skill-name>/SKILL.md`, listed in the package's `files` and
mounted by a `skill-filesystem` row — that is the copy that ships, gets found, and is loaded.

CLI-Anything mirrors its skill to a `skills/` directory at its repository root as well, so that its own
`npx skills add` distribution can find it. **Do that only if your repository is itself a skill-distribution
point.** A generated bundle is not: the root copy would be a second file to keep in step with the packaged
one, and this project's reference bundle deliberately omits it rather than carry a directory nothing reads.

## §10 Registry contribution

`dsh` needs **no registry to install a plugin** — `dsh plugin add` resolves npm names, git specs, and
tarballs directly. Discovery is a separate, existing layer spread over three repositories:

| Repository | Owns | You edit it? |
|---|---|---|
| **`awesome-dsh-plugin`** | The **list**: one YAML per plugin under `data/plugins/`, plus a generated `README.md`. Data only. | **Yes** |
| `smart-plugin-market` | The **prober**, the `market` slash command (`recommend \| list \| search \| install \| remove`), and the shipper. Ships a derived `registry.json`. | No |
| `dsh` | A copy of that package, mounted by `dsh-web-app`. | No |

**Do not build a hub.** Add one YAML file to the list instead, and regenerate the README.

Two things decide whether that works, and both are easy to get wrong:

1. **The file you write and the file you may have seen are different files.** A contributor writes
   `data/plugins/<owner>__<repo>.yml` with `{url, name, category, description.{en,zh}, tarball?}`. The
   `registry.json` carrying `installable` / `reason` / `probedAt` is **probe output** — observed by scanning
   a repository, not declared by anyone.
2. **Discoverability is a property of your manifest, not your entry.** The prober asks exactly one question:
   does the repository's `package.json` declare `dsh.bundle.patch`? That is why §6 treats that field as the
   whole contract rather than one field among many.

The list's format carries no runtime metadata (`requires`, the tools exposed, the `dsh` version built
against) — the "metadata gap" section of `guides/registry-entry.md` proposes where to contribute that.
That guide also carries the field table, the filename rule including the monorepo case, the 14 categories,
and the submission steps.

### Discovery has repository-level requirements, not just a file

Say this to the user **before** they plan around being listed, because a freshly generated plugin cannot be
listed today:

- the repository must be **at least 1 day old with at least 10 commits** — a squashed one-commit
  repository is rejected outright;
- it must carry the `dsh-plugin` GitHub topic;
- the manifest must declare `dsh.bundle` — a plugin declaring only `dsh.client` is rejected as *"that alone
  is not installable"*;
- the `dsh`/`deepseek-ai/deepseek-harness` repository itself cannot be listed (it is first-party, not a
  plugin for `dsh`);
- adding a file to the list also means regenerating and committing its READMEs in the same PR, and touching
  only your own entry.

So "make it discoverable" is a multi-day process with a commit-history prerequisite. An installable,
verifiable bundle that is not yet listable is the normal end state of a fresh generation run, and the agent
should present it as such rather than as an incomplete task.

## §11 Verification checklist

A generated plugin is not done until every line passes. `guides/verification.md` explains what each check
proves, which layer catches what, and — importantly — what remains genuinely unverified at each stage.
The ladder has a map, and it names the failure classes each rung exists to catch:
[`docs/runtime-acceptance.md`](../docs/runtime-acceptance.md).

**A generated plugin is not done when the checks pass. It is done when an agent has used it.** Compiling is
not loading; composing is not booting; a clean `--dump-config` is not a boot; a loaded plugin is not a tool
the model can see; and a tool the model can see is not one it can successfully call. Each of those gaps was
a real defect in this project.

Static gate first:

```sh
node scripts/verify-plugin.mjs <plugin-dir>
node scripts/verify-plugin.mjs --kit
```

```sh
# 1. It loads and its layer appears.
dsh plugin --profile dev add ./dsh-plugin-<target>
dsh --profile dev --dump-config            # expect a "# == dsh-plugin-<target>" layer

# 2. Every patch id resolved (a typo is only a warning, so check explicitly).
dsh --profile dev --dump-config | grep -c '<your-row-id>'

# 3. The tools are visible and callable.
dsh --profile dev                          # then ask the model to list and call them

# 4. It survives a restart.
#    Restart dsh and repeat 3. This is the property a dynamic cordis package cannot have.

# 5. Negative cases are rejected. Change one thing at a time and confirm the verifier fails:
#    - "name:" to a relative path          -> package-name rule
#    - drop the bare plugin from deps      -> dependencies rule
#    - move !!js onto "id"                 -> interpolation rule
#    - rename cordis.patch.yml to patch.yml -> discovery rule
```

## §12 House rules

Anything non-trivial — a new tool, a change to the plugin contract, a template edit that generated output
derives from, a change to what the verifier enforces — carries an **Agent Note** in the same change. The
format is `# Agent Note: <title>` + `Status: <status>` under `notes/{lifecycle}/{class}/`, and
`## Alternatives considered` is mandatory in every note. See `guides/agent-notes.md`.

## §13 Prohibited

- Reimplementing the target instead of driving it.
- More than one module touching the outside world.
- A `default export` on a function plugin.
- Content blocks returned from `execute`.
- I/O, clocks, or randomness inside a presenter.
- Module-scope side effects.
- UI formatting inside the canonical value or Native content.
- Hand-written fixtures standing in for a snapshot.
- Publishing to `private: true` machinery — that flag belongs to profile manifests only.
