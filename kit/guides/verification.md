# Verifying a generated plugin

The static verifier in this kit is a **gate, not a proof.** It catches the mistakes that fail silently. It
never claims a plugin boots — only a real `dsh` can tell you that.

This guide covers the layers in detail. [`../../docs/runtime-acceptance.md`](../../docs/runtime-acceptance.md)
is the map: the full ladder, the acceptance scenario, and the seven failure classes each layer exists to
catch — including the ones no layer above it can see.

## Layer 1 — static format

```sh
node scripts/verify-plugin.mjs <plugin-dir>
node scripts/verify-plugin.mjs --kit          # this kit's own structure
```

What it checks, and why each one matters:

| Check | Why it is here |
|---|---|
| The patch filename contains `cordis` | The gate's discovery glob is `**/*cordis*.yml\|yaml`. Any other name is invisible **and nothing warns you**. |
| `dsh.bundle.patch` is declared and the file exists | Without it, `dsh plugin add` installs the package as an inert dependency and activates no layer. `dsh plugin` prints a warning; nothing fails. |
| The patch basename is in `files[]` | The published tarball would otherwise omit its own patch layer. |
| A built package (`main` under `lib/`) also declares `exports["./cordis.patch.yml"]` | Node cannot resolve the patch by subpath without it. |
| The patch root is a YAML array and not comments-only | An empty or comments-only file parses to nothing, not to a list, and **throws at boot**. |
| `!!js` appears only under `config` or as the value of `disabled` | Anywhere else it is the error `!!js is not interpolated here`. |
| A bare row `name:` is in `dependencies` | The gate reports `must be declared in dependencies`. The package's own name is exempt — a bundle naming itself is the canonical case. |
| A function plugin has no default export and does export `name` | Mixing the forms makes the Loader discard the function plugin's namespace. |
| Presenters are pure | Presenters also run on replay; a clock read or an I/O call inside one makes replays nondeterministic. |

The verifier is itself tested: `node --test tests/verify-plugin.test.mjs` runs every check against a
single-field mutant that must fail. **A check that has never been observed rejecting anything is not
evidence.**

The purity check is a static approximation: it inspects `presentCall(...)` / `presentResult(...)` method
bodies for `Date.now`, `Math.random`, fs calls, `fetch(`, `process.env`, and `new Date(`. A presenter that
reaches impurity indirectly is not caught.

## Layer 2 — does the generated code compile?

This layer exists because Layer 1 passed code that did not compile.

```sh
cd bundle
pnpm install                                       # needs the real @deepseek-ai/* declarations
node --experimental-strip-types scripts/typecheck-example.mjs
npx tsc --noEmit -p tsconfig.json                  # the bundle itself
```

`typecheck-example.mjs` renders a bundle from the real templates and compiles it against the real
`@deepseek-ai/dsh-tools` types. It is the gate that catches a template edit producing code that **looks
right, passes the format gate, and does not compile**.

The historical failure it was written for is worth knowing, because it is the shape of mistake a format gate
cannot see: `presentResult(args, result)` was written as if `result` were the tool's canonical value. It is a
`ToolResult` — `{ content, isError, meta? }` — so `result.entries` and friends do not exist, and structured
data must be projected through `output.presentationMeta` into `result.meta`. Nothing about the generated
files looked wrong. ~28 errors across six modules, and no runtime symptom until a card misbehaved. See
`tool-contract.md` for the corrected pattern.

The gate is verified to reject: reintroducing that bug into the template makes this script fail with
`Property 'entries' does not exist on type 'ToolResult'`.

Two more things this layer covers:

- **The build must produce the artifact the manifest names.** Without `fixedExtension: false`, tsdown emits
  `lib/index.mjs` while `main` says `lib/index.js` — a green build and an unloadable package. CI asserts
  `main` exists after the build.
- **The dependency range must resolve.** `dsh` publishes no stable release, so `^0.1.5` matches nothing; the
  range needs the prerelease tag (`^0.1.5-rc.2`). `pnpm install` is what proves it.

## Layer 3 — composition (the real gate)

Only `dsh` can validate the composed tree:

```sh
export DSH_HOME=<an isolated home, so this does not touch ~/.dsh>
dsh plugin --profile dev add ./dsh-plugin-<target>
dsh --profile dev --dump-config
```

Look for two things:

1. A `# == dsh-plugin-<target>` layer header appears.
2. **Every patch id you wrote is present.** A patch that matches no row is a **stderr warning only** — a
   typo'd `id` silently does nothing. So grep for your ids explicitly rather than eyeballing the dump:

   ```sh
   dsh --profile dev --dump-config | grep -c '<your-row-id>'
   ```

### Loading, proven by where the failure lands

Composition is not loading. A cheap keyless way to prove the whole plugin tree settles — `apply` ran, nothing
threw — is to run one task **without** an API key and read *where* it fails:

```sh
dsh --profile <p> "hi"
# dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; …
```

That error comes from the model request, which happens **after** the Loader settles every entry. So reaching
it means every plugin, yours included, loaded and ran. A load failure would surface earlier and name the
plugin. CI asserts exactly this: the output must contain `MISSING_CREDENTIAL` and must **not** mention your
plugin.

Note also what the profile manifests look like once the install lands — both halves must agree, or the
package is installed-but-inert:

```
$DSH_HOME/profiles/<p>/package.json
{ "dependencies":        { "dsh-plugin-anything-bundle": "link:…" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-anything-bundle"] } } }
```

## Layer 4 — behavior, and the restart

```sh
dsh --profile dev
# ask the model to list its tools, then call one
```

Then **restart `dsh` and repeat.** That is the property a dynamic `cordis` package cannot have — it is the
whole reason this harness exists, so it is the one assertion that must never be assumed.

The persistence half is provable without a key: run `--dump-config` in several **separate processes** and
confirm the layer is present in each. Installation is on disk, so each boot recomposes it from the profile
rather than from anything in memory. What still needs a key is the model actually seeing and calling the
tools.

## Layer 5 — registration, replay, and the runner API, without a model

Between "the tree settled" and "the model called a tool" sit three questions that can all be answered
against the built artifact, with no model, no key, and no profile:

```sh
cd bundle && npx tsdown
node --test tests/registration.test.mjs      # did apply register the tools?
node --test tests/presenter-replay.test.mjs  # do the cards render from a real logged result?
node --test tests/promote.test.mjs           # does promote match the runner's actual API?
```

- **`registration.test.mjs`** calls the built `apply` with a recording context and asserts the tool names,
  that the entry is a function plugin with no default export, that `presentationMeta` is present on every
  definition, and that `promote` registers **only** when the cordis runner resolves.
- **`presenter-replay.test.mjs`** replays a `tool/result` event a **real** session logged — the transcript
  is the fixture, per dsh's own testing policy — and asserts the card is derived from `result.meta`,
  that replaying twice is identical, and that an unrecognisable `meta` declines to the generic fallback
  rather than throwing.
- **`promote.test.mjs`** pins the runner's service name, method name, and **argument order**. A locally
  declared interface cannot catch a wrong API — it agrees with itself. Only comparing against the shipped
  package can, and the first version of this tool got all three wrong.

## Layer 6 — negative cases

For every acceptance path you changed, prove it rejects an invalid input. Change one thing at a time and
confirm the expected failure:

| Break this | Expect |
|---|---|
| Rename `cordis.patch.yml` to `patch.yml` | The discovery rule fires (and the layer silently vanishes from a real boot) |
| Delete `dsh.bundle.patch` | The manifest rule fires |
| Change a row's `name:` to a relative path | The package-name rule fires; the row fails to resolve at boot |
| Remove a bare plugin from `dependencies` | The dependencies rule fires |
| Move `!!js` onto `id` | The interpolation rule fires |
| Add `export default` beside `export const name` | The plugin-form rule fires |
| Put `Date.now()` inside a presenter | The purity rule fires |

## A hole in Layer 3, found the hard way

`--dump-config` composes and prints the patch layers, but it does **not** detect duplicate loader entry ids.
A profile combining `@deepseek-ai/dsh-web-app` with `@deepseek-ai/dsh-headless` alongside a third-party
bundle dumps cleanly and then fails at boot with:

```
duplicate loader entry id: code-runtime
```

Both bundles insert that row. The shipped headless template survives it only because `loadProfile`
normalizes an **exact** installation-owned bundle tuple back to its template — and appending your own bundle
makes the list user-owned, so the normalization stops applying.

**So a clean `--dump-config` is necessary and not sufficient.** Always boot the profile.

## What is genuinely unverified

Be honest about the boundary. As of the last run of this project, the following have **no evidence**:

- **Promotion against a live dynamic package.** The API contract is now read from the shipped declarations
  and pinned by a test, and `promote` is asserted to stay out of a host without the runner. But no real
  `code.host` produced by `cordis_define` has ever been read through it — the code path from
  `inspectPackage` to a written file has not executed against a real package.
- **Semantic correctness of an `!!js` expression.** The verifier checks *placement*, not that the
  expression evaluates. A syntactically valid expression referencing a name that is not in scope fails at
  boot, not here.
- **Whether your `output.schema` describes what `execute` returns.** Only a real call proves that. One real
  call has been made (`plugin_anything_probe`), which is not a general guarantee.
- **`presentCall` on replay.** The replay test covers `presentResult` against a logged `tool/result`.
  `presentCall` has no logged counterpart in the same fixture — it is asserted for determinism only.

Evidence that now exists, having previously been on this list: the model **does** see and call the tools; a
presenter **does** render from a real logged result; a bundle **can** ship its own skill, resolved through
`createRequire` rather than the agent-preset `baseUrl` idiom.
