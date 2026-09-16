# Agent Note: Runtime acceptance as the top of the ladder

Status: implemented

## Problem

After the first round of verification, this project had four gates, all green, and **six defects had slipped
past every one of them**. Reading the six together showed they were not scattered: each was invisible to a
particular gate *by construction*, and two were invisible to all of them.

- A locally declared interface for an external service passes a typecheck, because it agrees with itself.
- A tool that misresolves its target passes every gate; only a call reveals it.
- `--dump-config` composes without detecting duplicate row ids, so the composition gate had a hole in itself.

The deeper problem was one of framing. The gates were being read as a strength ladder — "more green means
more correct" — when they are not: they see **disjoint** things. Four greens said much less than four greens
appeared to say.

## Decision

**Add runtime acceptance as the top rung, and make the ladder's limits explicit rather than implied.**

`docs/runtime-acceptance.md` records:

- the ladder, in order: static → link → type → build → contract → composition → boot → runtime acceptance →
  replay;
- seven named **failure classes** (F1–F7), each a defect this project actually shipped, each annotated with
  the gate that catches it *and the gate that let it through*;
- the acceptance scenario, as a numbered list from "profile boots" to "the model calls the promoted
  capability and the result is semantically correct";
- a table of what each gate is still blind to.

`scripts/acceptance.mjs` runs every deterministic rung and then prints exactly where the keyed steps begin,
with the command for each. It stops honestly rather than pretending to cover what needs a model.

## Alternatives considered

- **Keep the gates but do not write down their blind spots.** Rejected: the six defects are the argument. A
  green suite that is read as more than it is, is worse than a smaller suite that is read accurately.
- **Add more unit tests.** Rejected as the response to *these* defects. Every one of the six would have
  passed a larger unit suite; the failures were at boundaries between components, and a test that mocks the
  boundary mocks away the defect.
- **Automate the keyed steps with a scripted model.** Rejected for now. The scenario is genuinely agentic —
  define, run, verify, promote, convert, reinstall, restart, call — and a scripted stand-in would test the
  script. The acceptance profile plus the printed commands keep it reproducible by a human or an agent.
- **Run the whole ladder in CI.** Rejected: the composition and boot rungs need a `dsh` and a profile. They
  live in their own CI job against a real dsh, and the deterministic rungs run everywhere.

## Consequences

- `scripts/acceptance.mjs` reports 15/15 deterministic rungs on a healthy tree, and names the six keyed
  steps it cannot run.
- The ladder's top rung was exercised for real. A model created a dynamic cordis package via
  `cordis_define`, ran it, and called it (`dynamic-ok`); a restart made it **disappear**;
  `plugin_anything_promote` read it through `dynamicCordisRunner.inspectPackage`; the source was converted,
  installed, and after another restart the model called the promoted tool and got `dynamic-ok`. The contrast
  — gone after one restart, present after the next — is what makes the scenario evidence rather than a
  smoke test.
- Completion is now defined by the agent's use of the artifact, not by the gates: **a generated plugin is
  done when an agent has used it.**
- **The ladder is not a proof of correctness, and saying so is the point.** Its top rung is only as strong
  as its scenario — anything requiring a restart is unchecked unless the scenario includes one, which is
  exactly the gap that made the promote chain necessary in the first place.
