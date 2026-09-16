# Agent Note: Six failures no gate in this repo could see, all found by compiling, booting, and calling

Status: implemented

## Problem

The kit's static gate passed, every one of its checks was proven to reject a mutant, a bundle rendered from
the templates satisfied all of them, and all tests were green. Then the generated code was compiled,
installed into a real `dsh`, and called by a real model — and **six defects surfaced**, none of them of a
kind any gate in this repository could detect by construction.

1. **`presentResult` was written against the wrong type.** The templates and all five of the bundle's own
   tools read `result.entries`, `result.root`, `result.ok`, `result.output` — as if `result` were the tool's
   canonical value. It is a `ToolResult`: `{ content, isError, meta? }`. The canonical value is not on the
   wire at all; structured data must be projected by `output.presentationMeta` into `result.meta` and
   narrowed back out. ~28 `TS2339` errors across six modules. Nothing about the generated files looked wrong,
   and there is no runtime symptom until a card misbehaves.

2. **The build produced an artifact the manifest did not point at.** `main` said `lib/index.js`; tsdown
   emitted `lib/index.mjs`. Without `fixedExtension: false` the build reports success and produces something
   unloadable.

3. **The dependency range matched nothing that exists.** `^0.1.5` desugars to `>=0.1.5 <0.2.0` with no
   prerelease tag, and semver only lets a prerelease version satisfy a range when a comparator carries a
   prerelease on the **same** `major.minor.patch`. `dsh` publishes no stable release, so every version is a
   prerelease and `^0.1.5` resolves to a 404. Every bundle this kit generated was uninstallable.

4. **`promote` called a service and a method that do not exist.** It used `cordisInspect.self(pluginId,
   packageId)`. `cordisInspect` is real — it is the read-only *capability query* registry, `list()` and
   `query(...)` — but it carries no package source. The source lives on `ctx.dynamicCordisRunner` under
   `inspectPackage(agent, pluginId, packageId)`, nested at `code.host` / `code.client`, with the owning
   `Agent` as the **first** argument. The original shape came from the `cordis-plugin-development` skill's
   description of the model-facing *tool* `cordis_inspect_self`, which is not the service. **A typecheck
   cannot catch this**: the interface was declared locally, so it agreed with itself.

5. **The probe reported a PATH-installed tool as missing.** A real model turn asked it about `git` and got
   `callable: false, "git was not found on disk"` — because `probeTarget` only ran `isFile` on the raw
   string. Every correctly installed CLI on `PATH` was reported unavailable.

6. **A presenter's rendered text disagreed with its schema.** The probe's `render` printed `surface:` while
   the field is `kind`. The model noticed and reconciled it in prose, which is exactly the wasted turn the
   output format exists to avoid.

7. **`promote` wrote the sandbox body into `src/`.** The body is a sandbox *function body*: it opens with a
   top-level `return`, valid where it ran and a compile error anywhere else. Placing it in `src/` made the
   generated bundle fail its own typecheck before any conversion had happened, which reads as "promotion
   produced broken code" rather than "promotion produced an intermediate artifact". Found by running the
   conversion for real: the typecheck said `TS1108: A 'return' statement can only be used within a function
   body`.

Two smaller defects came from the same discipline rather than from a gate. `scripts/typecheck-example.mjs`
called `process.exit(1)` from inside its `try`, and `process.exit` does not run `finally` blocks — so it
leaked a temp directory on every failure. And `scripts/acceptance.mjs` set `shell: true` unconditionally on
Windows, where a shell splits `D:\Program Files\nodejs\node.exe` on the space and every rung invoking
`process.execPath` failed with `'D:\Program' is not recognized`.

## Decision

Fix all four at their source, and add the layer that finds this class of defect:

- **`presentResult` correctness** — `presentationMeta` on every tool definition, presenters narrowed through
  per-tool `xFromMeta` helpers that decline to `undefined` rather than assert, mirroring `tool-fs`'s
  `diffsFromMeta` / `readMetaFromMeta`. Documented in `guides/tool-contract.md` under
  "`presentResult` does NOT receive your canonical value", and enforced by a typecheck rather than by prose.
- **`fixedExtension: false`** in `tsdown.config.ts`, both in the bundle and in the template, and CI asserts
  the manifest's `main` exists after a build.
- **`DEFAULT_DSH_RANGE = '^0.1.5-rc.2'`**, defined once in `scaffold.ts` with the semver rule written out,
  and `plugin_anything_scaffold` now takes an explicit `dshRange` because the range is line-specific —
  `^0.1.5-rc.2` does not admit `0.1.6-alpha.1`.
- **`bundle/scripts/typecheck-example.mjs`** — renders a bundle from the real templates and compiles it
  against the real `@deepseek-ai/dsh-tools` declarations. Wired into CI. The exit-code leak is fixed by
  recording a status and letting `finally` run before exiting.
- **`promote` reads the runner's shipped declarations**, and `bundle/tests/promote.test.mjs` pins the
  service name, the method name, and the **argument order**. The lesson generalized into a rule: a
  hand-declared interface for an external service must be checked against that service's `.d.ts`, because
  a locally declared interface will agree with whatever the author assumed.
- **`probeTarget` resolves a bare command name through `where`/`which`** before deciding a target is
  missing, and the probe's `render` now prints `kind:`, matching its schema.

## Alternatives considered

- **Extend the static verifier to catch these.** Rejected: it is a regex-and-structure checker with no type
  information and no build. Detecting `result.entries` requires knowing `ToolResult`'s fields; detecting the
  `.mjs` mismatch requires building. Adding heuristics for either would produce a checker that is wrong
  often enough to be ignored.
- **Pin the exact `dsh` version instead of using a range.** Rejected as the default, because it forces a new
  plugin release for every `dsh` prerelease. Kept as the escape hatch via the tool's explicit `dshRange`.
- **Bundle from `tsc`'s JavaScript emit rather than from `src/`.** That is what the dsh repo's
  `dsh-context-compressor` does, and it works — but it needs `tsc` to emit JavaScript into `lib/types/`,
  which conflicts with this project's `emitDeclarationOnly` arrangement. Compiling directly from `src/` with
  `fixedExtension: false` reaches the same artifact with one fewer moving part.
- **Skip the real-`dsh` verification because no API key was available.** Rejected: most of the chain turned
  out to be provable without one. Composition, loading, registration and persistence all have keyless
  evidence; only the model turn does not.

## Consequences

- `guides/verification.md` now documents six layers, with Layer 2 (does it compile) existing specifically
  because Layer 1 passed code that did not.
- Two new CI jobs: one that compiles a rendered bundle and checks the built artifact matches the manifest,
  and one that installs the bundle into a real `dsh` and asserts the layer composes, the row id resolves,
  and the tree settles (proven by the failure landing on `MISSING_CREDENTIAL` rather than on our plugin).
- `bundle/tests/registration.test.mjs` asserts the built `apply` registers the documented tools, that the
  entry is a function plugin with no default export, that every definition carries `presentationMeta`, and
  that `promote` stays out of a host without `cordisInspect`.
- **The general lesson, which is the reason this note exists:** four gates — format, types, build, and
  composition — each find a class of defect the others cannot, and **none of them finds the class that only
  a real call finds**. `promote`'s wrong service name survived all four: it is not a format violation, it
  typechecks (against a local interface), it builds, and it composes. It would have failed on the first
  user who tried it. And defect 5 is only visible when a real model asks about a real tool on a real machine.
- **Evidence now exists for what was previously listed as unproven**: the model sees and calls the tools
  (a real turn listed all four and called `plugin_anything_probe` on `git`, yielding `kind: cli,
  callable: true`); a presenter renders from a real logged `tool/result`; and a bundle ships its own skill,
  discovered through `createRequire` and listed by the model from `<available_skills>`.
- What remains unproven is now much narrower: promotion against a **live** dynamic package (the contract is
  verified, the code path has not run against a real `code.host`), `presentCall` on replay (only
  determinism is asserted, not a logged counterpart), and the general guarantee that a generated
  `output.schema` describes what its `execute` returns.
- **One gate got weaker, not stronger, from this work.** `--dump-config` was treated as proof of
  composition. It is not: it does not detect duplicate loader entry ids, so a profile can dump cleanly and
  fail at boot. `verification.md` now says so and CI boot the profile rather than trusting the dump.
