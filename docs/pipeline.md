|  |  | `plugin_anything_accept` | implemented ||  |  | `plugin_anything_accept` | implemented ||  |  | `plugin_anything_accept` | implemented ||  |  | `plugin_anything_accept` | implemented ||  |  | `plugin_anything_accept` | implemented ||  |  | `plugin_anything_accept` | implemented ||  |  | `plugin_anything_accept` | implemented |# The pipeline

This is the project. Not the tools — the tools are mechanizations of its stages, and arguing about them
before the pipeline is defined is how a pipeline ends up shaped like whatever got built first.

The definition lives in [`bundle/src/pipeline.ts`](../bundle/src/pipeline.ts) as data, and the tests in
`bundle/tests/ir.test.mjs` hold it to its own invariants. This document is the view of it.

## Why the pipeline is the unit, not the tool

An earlier version of this project judged each tool by whether an agent could have used `bash` instead. That
measures the **implementation** and says nothing about whether the **stage** belongs. An agent that
hand-rolls a stage in one run has not shown the stage is unnecessary; it has shown the stage is currently
unmechanized. Both facts are worth knowing, and only one of them is a reason to delete something.

So the question is never "how many tools". It is **which stages have no owner** — and the answer is computed:

```sh
node --experimental-strip-types -e "import('./bundle/src/pipeline.ts').then(p => console.log(p.coverage()))"
```

## Stage ownership

| Owner | Meaning | If it has no tool |
|---|---|---|
| `agent` | Requires judgement: reading an interface, extracting what matters, deciding a mapping | **Correct.** Mechanizing it replaces intelligence with a heuristic, and the heuristic will be wrong on the target nobody anticipated |
| `deterministic` | Has a correct answer, or a contract that cannot be re-derived per run | **A hole.** Nothing guarantees it happens the same way twice |
| `runtime` | The capability exists only inside a running harness | **A hole.** No amount of shell access substitutes |
| `external` | Owned outside this project, named so the pipeline has no silent gap | Nothing — it is named so it cannot be forgotten |

An `agent` stage *may* still carry a tool that gathers structured evidence for the judgement. The tool
supports the decision; it does not make it.

## The twenty stages

| # | Stage | Owner | Tool | Status |
|---|---|---|---|---|
| 1 | Detect | deterministic | `plugin_anything_probe` | implemented |
| 2 | Inspect | agent | `plugin_anything_inspect` | implemented |
| 3 | Capability extract | agent | — | **absent** |
| 4 | Capability IR | agent | — | **absent** — writing it is the judgement; `compile` consumes it |
| 5 | Plan / map | agent | — | **absent** |
| 6 | Scaffold | deterministic | `plugin_anything_scaffold` | implemented |
| 7 | Implement | deterministic | `plugin_anything_compile` | implemented |
| 8 | Build | deterministic | — | partial |
| 9 | Verify | deterministic | `plugin_anything_verify` | implemented |
| 10 | Install | deterministic | `plugin_anything_install` | implemented |
| 11 | Compose | deterministic | — | partial |
| 12 | Boot | deterministic | — | partial |
| 13 | Discover | runtime | — | **absent** |
| 14 | Invoke | runtime | — | **absent** |
| 15 | Present | deterministic | — | partial |
| 16 | Replay | deterministic | — | partial |
| 17 | Scan | external | — | external |
| 18 | Promote | runtime | `plugin_anything_promote` | implemented |
| 19 | Package | deterministic | `plugin_anything_package` | implemented |
| 20 | Publish | external | — | external |

**Fourteen mechanized. **No stage is owed.** Four owned by judgement. Two owned elsewhere.**

The seven that exist are coverage, not a tool set — and reading them as "the tool set" is what made an earlier
draft propose cutting one.

## Paths are subgraphs

Not every input needs every stage. A user who already has a working dynamic cordis package does not need
detection, inspection, or scaffolding; they need promotion.

| Input | Path |
|---|---|
| `cli` | 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → *tail* |
| `http` | same as `cli`; inspection may consume OpenAPI instead of prose |
| `mcp` | **1 only — a terminal path.** See below |
| `dynamic-package` | 18 → *tail* |
| `plugin-source` | *tail* |

**The tail is the acceptance contract**, and every non-terminal path ends in it:

```
verify → install → compose → boot → discover → invoke → present → replay
```

Whatever produced the artifact, it is not done until an agent has used it. A path that reaches this tail and
skips part of it is an unfinished run, not a shortcut. `bundle/tests/ir.test.mjs` asserts this for every
non-terminal path, so a future edit cannot quietly shorten one.

### `mcp` is terminal, and that is load-bearing

An MCP server already has a supported route into `dsh`. The correct output of that path is a **config row**,
not an artifact. The test suite pins this, because "it has no plugin yet, so let's generate one" is a
plausible-looking mistake that duplicates a working path.

## The compiler shape

The reason the stages above are a pipeline rather than a checklist is the IR in the middle:

```
   Frontends                    IR                  Backend
   cli      ─┐                                      ┌─ dsh plugin bundle
   http     ─┤                                      │
   mcp      ─┼──>  CapabilitySet  ──>  policy  ────>─┤
   openapi  ─┤      (ir.ts)                         │
   repo     ─┘                                      └─ (a future host)
```

Two properties make it a compiler instead of a serialization:

- **The backend never learns which frontend ran.** It reads capabilities, not sources. A backend that
  branches on the frontend means the IR has stopped being one.
- **`evidence` and `confidence` are first-class.** A capability confirmed by running it and one inferred from
  a flag name are different facts. This project's other gates already refuse to conflate "passed" with
  "never ran"; an IR that flattened them would undo that in the middle of the pipeline.

See [`bundle/src/ir.ts`](../bundle/src/ir.ts) for the shape, and
[`runtime-acceptance.md`](runtime-acceptance.md) for the ladder that verifies the artifact this produces.

## What this changes about the tools

Nothing yet — and that is the point. The pipeline is now defined, so a change to the tool set can be
justified by naming the stage it serves and the coverage it adds. The next work is the stage list above, in
the order the gaps hurt:

1. **Inspect (§2)** — nothing downstream can start without evidence, and today the agent re-derives it per run.
2. **Compile (§4→§7)** — IR in, plugin source out. The IR exists; the backend does not.
3. **Accept (§11–§16)** — the tail, mechanized as one verdict instead of five manual steps.

`probe` stays, and gets clarified: its job is §1, classification, not inspection. Those were conflated in the
earlier draft, which is part of why cutting it looked plausible.
