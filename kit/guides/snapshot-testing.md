# Testing a generated plugin

`dsh`'s testing policy is stricter than CLI-Anything's, and it is the requirement most likely to be skipped
because the package-level tests pass without it. The policy is `docs/testing.md` in the `dsh` repo; this
guide is the part that applies to a generated plugin.

## dsh's tiers, for reference

These are the monorepo's own runners. Read them to understand what each tier is *for* — you will not run
any of them, because they resolve workspace imports through the monorepo's tsconfig paths and the
monorepo's suite factories.

| Tier | `dsh` runner | What it proves | Key |
|---|---|---|---|
| Unit | `pnpm run test` | Package specs under `tests/**`; every registry gets an HMR-safety test | no |
| Coverage | `pnpm run test:coverage` | Per-file 100% on `packages/*/*/src` — **the CI gate, not `test`** | no |
| Real-API e2e | `pnpm run test:e2e` | Live provider behavior | yes, self-skips |
| Snapshot | `pnpm run test:snapshot` | Keyless expected outputs from a real runnable example | **no** |
| Web browser | `pnpm run test:web` | Replayed browser output | no |

## What you must build instead

Out-of-tree, none of those runners apply. The **policy** behind them does. Three layers, and the middle one
is the one that gets skipped:

| Layer | How you run it | What it covers |
|---|---|---|
| Unit | your package's `test` script (`vitest`), or `node --test` for a dependency-free kit | Tool logic against a stubbed egress module, HMR safety, config failure paths |
| **Snapshot** | your own keyless scenario, replaying a real run's transcript | **The model- and user-visible behavior. Mandatory, and not satisfiable by unit tests.** |
| e2e | your own with-key suite, self-skipping without `DEEPSEEK_API_KEY` | The real backend |

The snapshot layer is why this guide exists. Everything else here is context for it.

**Do not cite the monorepo's runner names in your own docs** — `pnpm run test:snapshot` will not exist in
your package, and a reader who tries it will conclude the policy is inapplicable rather than that they need
to write the scenario.

## The mandatory rule

> Every non-trivial model-, protocol-, or human-visible change adds or updates a keyless scenario in the
> same PR through a runnable example's owning snapshot suite. Package tests, e2e assertions, mock/test-only
> compositions, and PR rationale **do not replace the assembled transcript**.

So a tool the model can see requires a snapshot produced by really running it. A hand-written fixture is not
a substitute, and neither is a unit test that asserts your provider builds the right argv.

## "Verify the world, not the self-report"

The single most important testing rule here:

> An e2e assertion re-runs the command or re-reads the file externally; a keyword probe on the agent's own
> output lets a cheating agent pass. Assert untouched files are byte-identical.

Concretely, for a generated tool: do not assert that the transcript *says* the widget was built. Assert the
artifact is on disk, with the expected content, by reading it in the test.

## "A guard only guards if the regression actually fails it"

A test that stays green when you break the thing it guards is not evidence. The `dsh` repo states the
procedure explicitly:

> add an explicit `expect('default' in mod).toBe(false)` plus an `unwrapExports` round-trip assertion, and
> prove it: **introduce the regression, watch red, revert.**

This is why `scripts/verify-plugin.mjs` in this kit has `tests/verify-plugin.test.mjs`: every check is
exercised against a single-field mutant that must fail. Apply the same discipline to your own tests.

That specific `expect('default' in mod).toBe(false)` assertion matters for a **plugin without `inject`**
(a bundle or composition plugin): a Loader smoke stays green when a default export replaces the required
named exports, because the Loader simply discards the function plugin's namespace. Assert it directly.

## Test the real entry path

> Product-visible plugins require a non-unit REAL-composition test. Hand-built `ctx.plugin(...)` suites are
> insufficient: boot test-only `cordis.yml` through Loader and app/process, mock only external services or
> nondeterministic inputs, and assert model-visible request/log, durable state, or user-visible output.
> Keep opt-ins out of shipped defaults.

Practically: write a test-only `cordis.yml` that mounts your bundle, boot it, and assert what the world
says. Do not construct a `ctx` by hand and call `apply` — that proves your function runs, not that your
bundle loads.

## Prefer the real implementation over a mock

> Mock only the expensive or non-deterministic boundary (LLM adapter, network, clock); keep everything
> downstream real.

For a CLI-backed plugin this means: in unit tests, stub the process spawn at the `provider.ts` boundary —
never the tool's logic. The tool's schema, validation, and rendering should all be exercised for real.

## Recording and replaying

The mode idea is what transfers, not the variable. The `dsh` repo's lanes select a mode through an
environment variable and separate recording from replaying:

| Mode | When |
|---|---|
| record | a model transcript changed — rewrite the expected output |
| refresh | replay input is still valid, but derived output moved |
| replay | CI. **Read-only: it never writes expected outputs.** |

Adopt that shape with whatever variable name fits your package (the `dsh` repo uses `DSH_SNAPSHOT`, which
is its own convention and not a contract you inherit). The two rules worth copying exactly:

- **Recording stays local; CI only replays.** A CI job that can write its own expected output will
  eventually bless a regression.
- **Every JSONL and expected-output diff is reviewed.** A snapshot diff is a behavioral change; rubber-
  stamping a large one defeats the entire tier.

## What to write, in order

1. **`tests/TEST.md` first** — the plan: the scenario list, what each asserts about the world, and which
   tier covers it. Writing tests before the plan is how the assembled transcript gets skipped.
2. **Unit tests** — the tool modules against a stubbed `provider.ts`; the HMR-safety test (dispose the
   contributing fiber, assert cleanup); the config validation failure paths.
3. **The keyless snapshot** — a runnable example that boots your bundle through Loader and produces the
   transcript.
4. **`tests/TEST.md` again** — append the actual output and the summary.

Leave `TEST.md` untouched on failure; a test report that records a failing run as a result is worse than no
report.
