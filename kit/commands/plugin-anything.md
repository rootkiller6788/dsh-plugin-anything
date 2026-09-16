# plugin-anything Command

Build a complete, installable DeepSeek Harness plugin bundle for any operable target — an external CLI, an HTTP/REST API, or a local service.

## CRITICAL: Read HARNESS.md First

**Before doing anything else, you MUST read `../HARNESS.md`.** It is the SOP this command executes: the three overriding rules (wrap the real system, decide render intent up front, keep presenters pure), the phase-by-phase procedure, and the prohibited list. Everything below names the artifact each phase must produce — HARNESS.md is the authority on how. Do not improvise.

## Usage

```bash
/plugin-anything <target-path-or-repo-or-url>
```

## Arguments

- `<target-path-or-repo-or-url>` — **Required.** One of:
  - A **local path** to the target's source tree or installation (e.g., `/usr/local/bin/ffmpeg`, `./my-service`)
  - A **Git repository URL** (e.g., `https://github.com/owner/tool`) — the agent clones it locally first, then works on the local copy
  - An **HTTP(S) endpoint** or an **MCP server URL**

  A bare product name (e.g. `ffmpeg`) is **not** accepted. The agent needs a tree to analyze or an endpoint it can actually call.

## What This Command Does

This command implements HARNESS.md Phases 0–7 to produce one dsh plugin package that a `dsh` agent can load, call, and still have after a restart. `dsh` is built on vendored Cordis, where everything is a plugin — so the deliverable is a plugin, not a command-line wrapper.

### Phase 0 — Target acquisition

- Classify the surface as exactly one of **CLI binary**, **HTTP/REST API**, or **MCP server**. The per-backend consequences of that choice are in [`../guides/backend-cli.md`](../guides/backend-cli.md) and [`../guides/backend-http.md`](../guides/backend-http.md).
- **Prove it is callable.** Run it. Record the literal invocation and its observed output. An assumed surface is not an acquired one.
- Derive the plugin name from the target: lowercase kebab, `dsh-plugin-<target>`.

**Stop condition.** If the target is already an MCP server, **generate nothing**. `dsh` already bridges MCP servers — `packages/mcp/mcp-client` runs one plugin instance per server and their tools arrive as ordinary `ctx.tools` entries named `mcp__<serverName>__<rawName>`. Tell the user to add an opt-in `@deepseek-ai/dsh-mcp-client` row to their `cordis.yml` instead. See [`../guides/backend-mcp.md`](../guides/backend-mcp.md).

### Phase 1 — Capability surface analysis

- Decide **seam vs Consumer**. Default to **Consumer**: register tools that call the target. Choose a seam only when more than one implementation is plausible, other plugins would consume the capability rather than the tool, and the roles genuinely evolve for different reasons. Getting this wrong in the seam direction is expensive and hard to undo — see [`../guides/seam-vs-consumer.md`](../guides/seam-vs-consumer.md).
- Map capabilities to tools: a 12-verb CLI becomes **one plugin registering 4–8 tools grouped by intent** — not 12 tools and not 1. The in-repo norm is one package registering several tools from one `apply`, with definitions in sibling modules.
- For each tool record: name, one-line description (this is what the model reads), parameters, the **render intent**, and the canonical output value. A tool without a decided output schema is not designed yet.
- Decide what state survives between calls. Prefer **none** — stateless tools are vastly easier to make correct. Persistent state belongs in the target's own storage or in session events, never in a module-level variable.

### Phase 2 — Plugin architecture design

- Choose the **form**. A **function plugin** — named exports `name`, `inject`, `Config`, `apply`, and **no default export** — is the default for tool plugins. A **service plugin** (`export default class X extends Service`) is for when you contribute a service others consume. **These must not be mixed**; mixing makes the Loader discard the function plugin's namespace.
- Declare `Config` with `@deepseek-ai/schemastery` and give **every field a default**, then narrow once inside `apply` with `config as Required<Config>`. Validate the values that would otherwise fail silently — misconfiguration must fail loud. Any value a deployment could reasonably vary is a validated `Config` field changeable from `cordis.yml`; a `DEFAULT_*` constant is not configurability.
- Design the `cordis.patch.yml` rows, respecting every rule listed below.
- Decide the skill. There is no skill-packaging mechanism in a bundle: if the plugin needs teaching, it ships `skills/<name>/SKILL.md` **and** mounts its own discovery row. Never assume the host provides skill discovery. See [`../guides/skill-authoring.md`](../guides/skill-authoring.md).

### Phase 3 — Implementation

Build in this order; each step is complete before the next.

1. **`src/provider.ts`** — the **one** module that touches the outside world. No tool definitions here; it exposes plain async functions and MUST honor the abort signal it is handed.
2. **`src/<tool>.ts`** — one module per tool, each exporting an `apply<Name>Tool(ctx, …)` function that registers exactly one definition.
3. **`src/index.ts`** — named exports, `Config`, `apply` wiring the tool modules, fail-loud `assert*` checks, and any `ctx.inject([...], …)` conditional registration.
4. **`cordis.patch.yml`** — the rows from Phase 2.
5. **`package.json`** — the bundle manifest (Phase 7).
6. **`README.md`** — the target's prerequisites and the literal commands to install and verify.

Tools register through `ctx.tools.register(defineTool({ … }))`. Four things are commonly assumed wrong, and all four are covered in [`../guides/tool-contract.md`](../guides/tool-contract.md): the input schema is a purpose-built DSL (not Schemastery, not raw JSON Schema); `execute` is `(args, exec)` with **no `ctx` parameter**; `execute` returns the canonical JSON value declared by `output.schema`, not content blocks; and `defineTool` validates the model's arguments before `execute` runs.

Registration is an effect: a `ctx.tools.register(...)` called on a `ctx` obtained inside `apply` is already owned by that fiber and needs no manual cleanup. **Never move a registration to module scope.**

### Phase 3.5 — Render intent

Render intent is part of the design, decided up front, never picked after the fact:

| Target kind | Call card | Notes |
|---|---|---|
| Wraps a CLI | `terminal` | `title` is the command, plus `cwd` where it matters |
| Produces or edits files | `diff` | populate `locations` with `FileLocation[]` |
| Everything else | `generic` | the fallback |

Attach `presentCall` / `presentResult` to the definition; returning `undefined` or omitting the method selects the generic fallback. Both run on live streaming **and** on session-log replay, so they are pure functions: no I/O, no session state, no clock, no randomness. A malformed historical argument returns `undefined` and never throws. UI-only formatting — a fenced console block, a diff, a relativized path — never belongs in the canonical value or the Native content.

### Phase 4 — Test planning

Write `tests/TEST.md` **before** writing tests. Plan three layers — unit (no target, no API key), **keyless snapshot**, and e2e (real target, plus `DEEPSEEK_API_KEY` where a model is involved).

The snapshot layer is mandatory and is **not** satisfied by unit tests: dsh's policy requires a keyless snapshot of a **real runnable example's** full transcript for every model- or user-visible behavior change. Package tests, e2e-only assertions, and mock-only fixtures do not substitute for it. See [`../guides/snapshot-testing.md`](../guides/snapshot-testing.md).

### Phase 5 — Test implementation

- Unit tests over the pure logic and the provider's argument construction, with no target present.
- The keyless snapshot, produced by really running the tool — never a hand-written fixture. Fixtures must replay on macOS and Linux: fix the fixture, never the normalizer.
- A presenter test that replays a log with deliberately malformed arguments and asserts the generic fallback.
- E2E tests that call the real target.
- An HMR-safety test: dispose the contributing fiber and assert cleanup.

### Phase 6 — Test documentation

Run the suites, then append the actual output to `tests/TEST.md` alongside the plan. Document coverage and any gaps. The [`test`](./test.md) command is the repeatable form of this phase and leaves `TEST.md` untouched on failure.

### Phase 6.5 — SKILL.md generation

Emit frontmatter that opens with a line that is **exactly** `---` and closes with another, no BOM and no leading blank line. Required: `name` matching `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` and a non-empty `description`. Legacy camelCase keys (`disableModelInvocation`, `modelInvocable`, `userInvocable`) **throw**. Recursive `**/SKILL.md` is unsupported.

Emit it in both places: the canonical `skills/dsh-plugin-<target>/SKILL.md` at repo root, and the packaged compatibility copy inside the plugin at `skills/<name>/SKILL.md`.

### Phase 7 — Bundle distribution

Everything the out-of-tree manifest requires, and nothing more:

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

A TypeScript package is built, so it also needs the resolution pair **together**: `exports["./cordis.patch.yml"]` and the patch's basename in `files[]`.

Ship through one of the three channels, and prefer npm or a tarball:

```sh
dsh plugin --profile <p> add ./dsh-plugin-<target>            # local checkout
dsh plugin --profile <p> add dsh-plugin-<target>              # npm
dsh plugin --profile <p> add github:you/dsh-plugin-<target>   # git, optionally #<sha>
dsh --profile <p> --dump-config                               # verify: look for "# == <bundle>"
```

The git channel fetches **sources, not built artifacts**, and pnpm ≥10 refuses to run a git dependency's `prepare` until the user adds it to `allowBuilds` in the profile's `pnpm-workspace.yaml` — which is permission to execute that package's code on the user's machine at install time. Recommend npm or a tarball; if git is genuinely required, pin a commit and say the risk out loud.

Full channel notes are in [`../guides/bundle-distribution.md`](../guides/bundle-distribution.md).

Registry contribution reuses `awesome-dsh-plugin` in its existing format. **Do not build a hub.** See [`../guides/registry-entry.md`](../guides/registry-entry.md).

## Hard rules for `cordis.patch.yml`

Each is enforced by a gate in the dsh repo and mirrored by [`../scripts/verify-plugin.mjs`](../scripts/verify-plugin.mjs).

1. **The filename must contain `cordis`** — the gate's discovery glob is `**/*cordis*.yml|yaml`.
2. **The root is a top-level YAML array.** An empty or comments-only file parses to nothing and **throws**; use `[]` to disable a layer.
3. **`!!js` is valid only under `config` (any depth) and as the value of `disabled`.** The path from the entry root decides this, not the nearest key. In scope: `process`, `ctx`, and `dshHomePath(...)`.
4. **`name:` is the package name, never a relative path** — Node resolution is what finds the installed code.
5. **A bare plugin name must be declared in the bundle's `package.json` `dependencies`**; the package's own name is exempt.
6. **Row order carries no load semantics.** Sequence plugins with `inject`, never by listing order.
7. **A patch that matches no row is only a stderr warning.** A typo'd `id` silently does nothing — check it with `dsh --profile <p> --dump-config`.

## Output Structure

```
dsh-plugin-<target>/
├── package.json           # dsh.bundle.patch + files[] + exports pair
├── cordis.patch.yml       # the rows from Phase 2
├── tsconfig.json
├── tsdown.config.ts
├── README.md              # prerequisites + literal install/verify commands
├── src/
│   ├── index.ts           # name / inject / Config / apply — no default export
│   ├── provider.ts        # the ONLY module that touches the target
│   └── <tool>.ts          # one module per tool
├── skills/
│   └── dsh-plugin-<target>/SKILL.md
└── tests/
    ├── TEST.md            # plan first, results appended in Phase 6
    ├── <tool>.test.ts     # unit
    └── snapshot/          # the keyless runnable-example transcript
```

Canonical repo-root skill output:

```
skills/
└── dsh-plugin-<target>/
    └── SKILL.md
```

## Example

```bash
# Build a plugin for a CLI binary on this machine
/plugin-anything /usr/local/bin/ffmpeg

# Build from a Git repository
/plugin-anything https://github.com/owner/tool

# Build against a local HTTP service
/plugin-anything ./services/notes-api
```

## Success Criteria

The command succeeds when:

1. Phase 0 recorded a literal invocation and its real observed output.
2. Exactly one module (`src/provider.ts`) touches the outside world, and the target is a hard dependency whose absence is a loud failure.
3. `src/index.ts` is a function plugin: named `name`/`inject`/`Config`/`apply`, **no default export**.
4. Every `Config` field has a Schemastery default, and values that would fail silently are validated in `apply`.
5. Every registered tool uses `defineTool`, declares `output.schema`, and returns a canonical value rather than content blocks.
6. Every tool has a decided render intent, and every presenter is pure.
7. The keyless snapshot comes from really running the tool and replays on macOS and Linux.
8. `node scripts/verify-plugin.mjs <plugin-dir>` exits 0 (the script is at [`../scripts/verify-plugin.mjs`](../scripts/verify-plugin.mjs)).
9. `dsh --profile <p> --dump-config` shows both the `# == dsh-plugin-<target>` layer and every row id from the patch.
10. The tools are visible and callable, and still are after a restart.
11. `tests/TEST.md` holds both the plan and the appended results; `README.md` documents prerequisites and the literal install/verify commands.
12. `SKILL.md` is emitted at both the repo-root canonical path and the packaged compatibility path.
