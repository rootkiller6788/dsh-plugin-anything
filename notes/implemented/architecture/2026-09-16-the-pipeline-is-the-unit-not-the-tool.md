# Agent Note: The pipeline is the unit, and the tool count was never the question

Status: implemented

## Problem

An earlier round of this project tried to decide the tool set by asking, of each tool, whether an agent
could have used `bash` instead. `probe` was substitutable, `install` was a thin wrapper, `scaffold` was
optional — so the proposal was to cut them.

That measurement is real, and it answers the wrong question. It measures the **implementation**; it says
nothing about whether the **stage** belongs to the pipeline. An agent that hand-rolls a stage in one run has
not shown the stage is unnecessary — it has shown the stage is currently unmechanized. And a pipeline whose
nodes are deleted whenever someone happens to do them by hand is a pipeline that erodes into a habit.

The deeper problem was that "how many tools" was being asked before "what is the pipeline". The answer to the
first question is unconstrained until the second is written down, which is how a project's shape ends up
being whatever got built first.

## Decision

**Define the pipeline first, as data, and compute coverage from it.** `bundle/src/pipeline.ts` carries
twenty stages, each with an `owner` (`agent` / `deterministic` / `runtime` / `external`) and a `rationale`
naming why that owner; five named paths through it for different inputs; and an `ACCEPTANCE_TAIL` every
non-terminal path must end in. `coverage()` returns four mutually exclusive groups, and `tests/ir.test.mjs`
asserts they partition the stages by id.

The tool question then answers itself: a stage whose owner is `deterministic` or `runtime` and which has no
tool is **owed**. An `agent` stage with no tool is correct — that is the design, and mechanizing it replaces
judgement with a heuristic that will be wrong on the target nobody anticipated.

Result: **14 stages owed, 14 mechanized, 8 tools.** The tools do not correspond one-to-one with stages
because `accept` mechanizes seven of them as a single verdict; the coverage number is the thing to watch,
not the tool count.

## Alternatives considered

- **Keep the burn-down list of "tools to cut".** Rejected: it optimizes the implementation and leaves the
  pipeline undefined, so the next person re-derives the shape and reaches a different answer.
- **One tool per stage.** Rejected: the seven acceptance stages are one decision made of seven checks.
  Seven tools would let a caller run five of them and believe they had accepted something.
- **Mechanize the agent stages too** — generate capabilities from a target without a reader. Rejected: this
  is the whole reason the project is not a code generator. Inspection gathers evidence; deciding what
  matters is the judgement that the pipeline exists to preserve.
- **Treat `scan` and `publish` as gaps.** Rejected: both have owners outside this project, and naming them
  as `external` is what stops them being forgotten rather than what fills them.

## Consequences

- **The IR (`bundle/src/ir.ts`) is what makes this a compiler rather than a checklist.** Frontends compile
  into it, the backend compiles out of it, and `tests/compile.test.mjs` pins the invariant that the backend
  never learns which frontend ran — two IRs differing only in provenance must compile to identical source.
- **§7 Implement was reclassified from `agent` to `deterministic`** once the IR existed. Everything a tool
  module needs is decided before it reaches the compiler; asking an agent to write the file by hand after
  that is transcription, and transcription is where details go wrong.
- **`accept`'s rule is the point of the acceptance stage**: a stage that did not run is never a pass. The
  precedence is deliberate — a failure dominates a skip (a known defect beats a known hole) — but a skip
  with no failure is `incomplete`, and `decide([])` is `incomplete` too, because a naive `every(pass)`
  accepts the empty run by vacuous truth. An acceptance that could have come from a run where nothing
  happened is worse than no acceptance: it is the one a release decision is made on.
- **The pipeline is now the thing a change is justified against.** A tool is added, removed, or merged by
  naming the stage it serves and the coverage it changes. That is a conversation with a computable answer.
- What remains unmechanized is unmechanized on purpose: three agent stages with no tool, one with a tool
  that gathers evidence, and two stages owned elsewhere.
