# plugin-anything:refine Command

Expand an existing dsh plugin bundle so it covers more of the target's capability surface.

## CRITICAL: Read HARNESS.md First

**Before refining, read `../HARNESS.md`.** Every tool you add must satisfy the same rules the original build did — the one-egress-module rule, the function-plugin form, the `defineTool` contract, render intent, and the keyless-snapshot policy. HARNESS.md is the single source of truth. Refining is not a licence to relax any of it.

## Usage

```bash
/plugin-anything:refine <plugin-path> [focus]
```

## Arguments

- `<plugin-path>` — **Required.** Local path to the generated bundle directory (the one holding `package.json` with `dsh.bundle.patch`), e.g. `/projects/tools/dsh-plugin-ffmpeg`. **Local paths only.** To work from a repository URL, run `/plugin-anything <url>` first, then refine the checkout.
- `[focus]` — **Optional.** A natural-language description of the capability area to target. When supplied, step 2 narrows to that area and step 3 compares only the focused capabilities — but the findings are still presented before anything is implemented.

  Examples:
  - `/plugin-anything:refine ./dsh-plugin-ffmpeg "audio stream mapping and loudness normalization"`
  - `/plugin-anything:refine ./dsh-plugin-notes-api "pagination and partial-update endpoints"`
  - `/plugin-anything:refine ./dsh-plugin-blender "headless render jobs and frame ranges"`

## What This Command Does

This command runs **after** `/plugin-anything` has produced a working bundle. It finds the gap between what the target can do and what the plugin exposes, then widens coverage — without ever removing an existing tool.

### Step 1 — Inventory current coverage

- Read `src/index.ts` and **every** `src/<tool>.ts` module. List each registered tool with its `description`, its `parameters`, its `output.schema`, and its render intent.
- Confirm exactly one module (`src/provider.ts`) touches the outside world; note every function it exposes.
- Read `cordis.patch.yml` and the `Config` interface: which values are already configurable, and which rows the bundle ships.
- Read `tests/TEST.md` and the test files. Build a coverage map: `{ capability: covered | not_covered | partially_covered }`.

### Step 2 — Re-analyze the target's capability surface

- Re-run the target itself — its `--help`, its subcommand tree, its API's discovery endpoint — and record real invocations, exactly as Phase 0 did. An assumed surface is not an acquired one.
- Categorize capabilities by domain (streams, filters, jobs, records, …), not by the target's own flag ordering.
- With `[focus]` present, restrict this step to the named area.
- If the gap turns out to need more than one implementation of a capability, revisit the seam decision in [`../guides/seam-vs-consumer.md`](../guides/seam-vs-consumer.md) before writing code.

### Step 3 — Gap analysis, presented before implementation

Compare the capability inventory against the coverage map and rank the gaps:

1. **High impact** — capabilities the model would reach for constantly and cannot reach at all.
2. **Easy wins** — capabilities whose arguments map onto an existing provider function.
3. **Composability** — capabilities that unlock new workflows when combined with tools already registered.

**Present this report and stop.** Let the user steer which gaps to close. The one exception is the pathological case where a gap makes an existing tool misleading — call it out explicitly, but still get agreement before changing behavior.

Grouping guidance: a new capability area usually earns its own `src/<tool>.ts` module and one tool, not one tool per flag. The norm is one plugin registering 4–8 tools grouped by intent.

### Step 4 — Implement the new tools

For each agreed gap:

- Add the target call to `src/provider.ts`. If the call needs a new option, expose it as a parameter, not a hardcoded constant; if it needs a new deployment-varying value, expose it as a `Config` field with a Schemastery default.
- Add `src/<tool>.ts` exporting an `apply<Name>Tool(ctx, …)` function, and wire it from `apply` in `src/index.ts`.
- Decide the render intent **up front**: `terminal` for a CLI-shaped call, `diff` with populated `locations` for one that produces or edits files, `generic` otherwise. Remember that a presenter runs on replay too — no I/O, no clock, no randomness, and a malformed historical argument returns `undefined`.
- Return a canonical JSON value from `execute`, not content blocks, and declare it in `output.schema`.
- Update `cordis.patch.yml` only if the bundle gains a dependency or a new mounting row. A new tool inside an existing package needs no new row.
- **Never remove or rename an existing tool.** Refine is additive.

### Step 5 — Expand the tests

- Unit tests for every new provider function and every new tool's argument construction, with no target present and no API key.
- **A new keyless snapshot** through a real runnable example that exercises the new tool. Unit tests do not substitute, and a hand-written fixture does not either. Confirm it replays on macOS and Linux by fixing the fixture, never the normalizer.
- E2E coverage for the real call.
- Re-run the **whole** suite — kit tests with `node --test tests/`, the bundle's own tests with its `test` script — and confirm no regressions.

### Step 6 — Update the documentation

- `README.md` — the new tools, with the literal commands to install and verify.
- `tests/TEST.md` — append the new plan entries and the fresh results.
- `skills/dsh-plugin-<target>/SKILL.md` **and** the packaged compatibility copy — keep them in step; a skill that documents tools that no longer match the code is worse than none.
- Re-run the verifier: `node scripts/verify-plugin.mjs <plugin-path>` (the script is at [`../scripts/verify-plugin.mjs`](../scripts/verify-plugin.mjs)).

## Example

```bash
# Broad refinement — the agent hunts for gaps across all capabilities
/plugin-anything:refine ./dsh-plugin-ffmpeg

# Focused refinement — the agent targets one capability area
/plugin-anything:refine ./dsh-plugin-ffmpeg "audio stream mapping and loudness normalization"
/plugin-anything:refine ./dsh-plugin-notes-api "pagination and partial-update endpoints"
/plugin-anything:refine ./dsh-plugin-blender "headless render jobs and frame ranges"
```

## Success Criteria

- The gap report was presented **before** any implementation.
- Every pre-existing tool still exists, still has its original name, and its tests still pass.
- New tools follow the same architectural patterns as the originals, per HARNESS.md.
- The new keyless snapshot was produced by really running the tool.
- `node scripts/verify-plugin.mjs <plugin-path>` exits 0, and `dsh --profile <p> --dump-config` still shows every patch row id.
- Both SKILL.md copies and `README.md` describe the plugin as it now is.

## Notes

- Refine is incremental. Run it repeatedly, one coherent capability area at a time.
- The most common failure mode is adding a tool whose arguments mirror the target's flags instead of the model's intent. Design from the intent, then map onto the flags.
- Adding a tool is cheap; adding a second module that touches the outside world is not. If a new capability seems to need its own egress module, that is a signal the provider abstraction is wrong — fix the provider, do not fork it.
- If the gap analysis concludes that no seam change is warranted, say so. Not every refinement needs a new tool.
