# plugin-anything:validate Command

Audit a generated dsh plugin bundle against HARNESS.md.

**This command is read-only. It writes nothing** — no manifest edits, no build output, no report file. It prints the report to the conversation and stops.

## CRITICAL: Read HARNESS.md First

**Before validating, read `../HARNESS.md`.** It is the single source of truth for every check below — the rules in "Read this first", the patch hard rules in §4, the tool contract in §5, the manifest in §6, the test policy in §8, and the checklist in §11. Do not invent checks that HARNESS.md does not require, and do not soften one that it does.

## Usage

```bash
/plugin-anything:validate <plugin-path-or-repo>
```

## Arguments

- `<plugin-path-or-repo>` — **Required.** Either:
  - A **local path** to the generated bundle directory
  - A **Git repository URL** — cloned locally first, then audited on the local copy

  The audit targets the package directory itself (the one holding `package.json`), not its parent.

## What This Command Validates

### 1. Bundle Manifest (7 checks)

- `package.json` parses as JSON
- `name` is `dsh-plugin-<target>`, lowercase kebab
- `type` is `"module"`
- `dsh.bundle.patch` is declared and a non-empty string — without it the package installs as a plain dependency and activates no layer
- the patch path resolves to a file that exists
- the patch basename appears in `files[]`, so the tarball ships its own layer
- a built package (`main` under `lib/`) also declares `exports["./cordis.patch.yml"]`

### 2. Patch Layer (6 checks)

- the patch filename contains `cordis` — the gate's glob is `**/*cordis*.yml|yaml`
- the first significant line is a list item (or the file is `[]`), so the root is a top-level YAML array
- the file is not empty and not comments-only — that parses to nothing, not to a list, and throws at boot
- `!!js` appears only under `config` (any depth) or as the value of `disabled`; anywhere else it is `!!js is not interpolated here`
- every bare row `name:` is declared in `dependencies` — the package's own name, relative paths, and `@deepseek-ai/*` are exempt
- every row id actually resolves: `dsh --profile <p> --dump-config | grep <row-id>` — a patch matching no row is only a stderr warning, so a typo'd id silently does nothing

### 3. Plugin Form (5 checks)

- `src/index.ts` exports `name`
- it has **no default export** — a function plugin with a default export has its namespace discarded by the Loader
- it exports `apply`
- it exports `Config` when the plugin accepts configuration
- it names required services in `inject` rather than relying on row order

  A service plugin (`export default class X extends Service`) is the other valid form. The two must not be mixed.

### 4. Config & Schemastery (6 checks)

- `Config` is declared with `z` from `@deepseek-ai/schemastery`
- every field carries a `.default(...)`, so omitting `config:` entirely is valid
- `apply` narrows once with `config as Required<Config>`
- values that would otherwise fail silently are validated and throw from `apply` — misconfiguration fails loud
- no deployment-varying value is a hardcoded `DEFAULT_*` constant
- every config key in the patch rows maps 1:1 onto an exported `Config` field

### 5. Single Egress Module (4 checks)

- **exactly one** module touches the outside world (`src/provider.ts`)
- the provider exposes plain async functions and defines no tools
- the provider honors the abort signal it is handed
- the target is a hard dependency: its absence is a loud failure, not a degraded mode

### 6. Tool Contract (8 checks)

- every tool registers through `ctx.tools.register(defineTool({ … }))`
- one tool per `src/<tool>.ts`, each exporting `apply<Name>Tool(ctx, …)` and wired from `apply`
- every tool has a one-line `description` — this is what the model reads
- `parameters` use the `ParameterSchemaSpec` / `ValueSchemaSpec` DSL, not Schemastery and not raw JSON Schema
- every explicit DSL object declares `additionalProperties`
- `output.schema` declares the canonical JSON value
- `execute` is `(args, exec)` with **no `ctx` parameter**, and it returns that canonical value rather than content blocks
- registration happens inside `apply`; nothing registers at module scope

### 7. Render Intent (6 checks)

- every tool has a render intent that was decided during design, not picked afterwards
- a CLI-shaped call uses a `terminal` call card with the command as `title`
- a call that produces or edits files uses `diff` with populated `locations`
- everything else uses `generic`
- `presentCall` / `presentResult` are pure — no `Date.now`, `Math.random`, filesystem access, `fetch(`, or `process.env`
- a deliberately malformed historical argument returns `undefined` and does not throw

### 8. Tests, Verifier & Docs (10 checks)

- `tests/TEST.md` holds the plan, written before the tests
- `tests/TEST.md` holds the appended results
- the unit layer runs with no target present and no API key
- a keyless snapshot exists and was produced by **really running** the tool, not a hand-written fixture
- the snapshot replays on macOS and Linux — the fixture was fixed, never the normalizer
- the e2e layer exercises the real target
- an HMR-safety test disposes the contributing fiber and asserts cleanup
- `node scripts/verify-plugin.mjs <plugin-dir>` exits 0 (the script is at [`../scripts/verify-plugin.mjs`](../scripts/verify-plugin.mjs))
- `README.md` documents the target's prerequisites and the literal install and verify commands
- `SKILL.md` opens with an exact `---` fence, has a kebab-case `name` and a non-empty `description`, and is emitted at both the repo-root canonical path and the packaged compatibility path

## Negative Cases

A gate that has never been observed rejecting anything is not evidence. Where the plugin is on disk and the verifier is available, re-run the mutations from HARNESS.md §11 one at a time and confirm the verifier fails each: rename `cordis.patch.yml` to `patch.yml` (discovery rule), point `name:` at a relative path (package-name rule), drop the bare plugin from `dependencies` (dependencies rule), and move `!!js` onto `id` (interpolation rule). Revert each mutation before the next. If a mutation passes, that check is not doing its job — report it.

## Validation Report

```
dsh Plugin Bundle Validation Report
Target: ffmpeg
Path: /projects/tools/dsh-plugin-ffmpeg

Bundle Manifest (7/7 checks passed)
Patch Layer (6/6 checks passed)
Plugin Form (5/5 checks passed)
Config & Schemastery (6/6 checks passed)
Single Egress Module (4/4 checks passed)
Tool Contract (8/8 checks passed)
Render Intent (6/6 checks passed)
Tests, Verifier & Docs (10/10 checks passed)

Overall: PASS (52/52 checks)
```

Each category prints `n/n checks passed`, or `n/m checks passed` with the failing checks and the file and line that caused each one. A category with a failure makes the overall verdict `FAIL`, regardless of the other totals.

## Example

```bash
# Audit a locally generated bundle
/plugin-anything:validate ./dsh-plugin-ffmpeg

# Audit a bundle from its repository
/plugin-anything:validate https://github.com/owner/dsh-plugin-ffmpeg
```

## Success Criteria

- The report prints all eight categories with counts, and a total in the form `Overall: PASS (52/52 checks)`.
- Every failure cites the file and the offending line, and points at the HARNESS.md rule it violates.
- Nothing was written, and the plugin directory is byte-identical to how it was found.

## Notes

- A category total below its maximum is a finding, not a rounding error. Report it.
- Static confirmation is not a boot. `validate` never claims a plugin loads; that claim belongs to `dsh --profile <p> --dump-config` showing the bundle's layer and to the model actually calling its tools.
- If the audit is run against the kit itself rather than a generated bundle, additionally run `node scripts/verify-plugin.mjs --kit` and `node --test tests/`.
