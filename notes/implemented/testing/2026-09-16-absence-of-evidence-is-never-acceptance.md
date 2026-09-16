# Agent Note: Absence of evidence is never evidence of acceptance

Status: implemented

## Problem

The acceptance verdict had a shape that only showed up when it was written down as an enumeration:

```
PASS      → accepted
FAIL      → rejected
SKIPPED   → incomplete
[]        → incomplete
```

The last line is the one that matters. `[].every(predicate)` is `true`, so the obvious implementation —

```ts
const accepted = stages.every((stage) => stage.verdict === 'pass')
```

— accepts a run in which **nothing happened**. Not a partition of the stages that ran: all of them. A
verdict function whose answer for "we did not check" is "yes" is worse than no verdict, because it is the
one a release decision gets made on.

The same defect appeared a second time, one level up: `judgePackage` returned `pass` for a manifest with no
`files` list. Nothing was missing, because nothing was compared — and reporting that as a clean pass is the
identical mistake wearing a different hat.

## Decision

**A stage that did not run is never a pass**, and it is stated as its own assertion so the reason is legible
next to it:

```ts
test('absence of evidence is never evidence of acceptance', () => {
  assert.equal(decide([]).verdict, 'incomplete')
  // and every shape of "some evidence, some silence"
})
```

Three consequences follow from taking it seriously:

- **The precedence is deliberate.** A failure dominates a skip — a known defect beats a known hole — so
  `[fail, skip]` is `rejected` and `[skip]` is `incomplete`. Collapsing them would lose the distinction
  between "it is broken" and "we did not look", and the two need different responses.
- **The reason names every skipped stage.** "Some stages were skipped" is not actionable. A reader deciding
  whether to release needs the list.
- **A check that could not run says so.** `judgePackage` with no `files` list reports *"no files[] list to
  check against"* rather than `pass`; the acceptance ladder reports a **skip** for a rung it could not run
  (an absent upstream list, a profile that does not exist) rather than a pass.

## Alternatives considered

- **`every(pass)` with a comment.** Rejected: the empty case is not an edge — it is the first thing that
  happens when a run fails to start, and a comment does not stop it being accepted.
- **Treat a skip as a failure.** Rejected: a skip is often environmental (no model key, no profile), and
  making it a failure trains people to work around the gate. `incomplete` is a third answer, and it is the
  honest one.
- **Let the caller decide what a skip means.** Rejected: the caller is a release decision, and the point is
  that this decision should not be available.
- **Only check the stages that ran.** Rejected — that is the defect, restated.

## Consequences

- `bundle/tests/failure-injection.test.mjs` enumerates every combination of outcomes across three stages
  (27 assignments) and asserts the rule for each, because a hand-picked example can miss the combination
  that breaks it — and the rule's whole value is that it holds for the one nobody thought of.
- Nine named defect injections each require the specific verdict they deserve, with the mapping stated per
  case: `wrong main` and `missing packaged template` are `rejected`; `tool undiscoverable` and `malformed
  presenter meta` are `incomplete`. The distinction is not cosmetic — one means the artifact is broken, the
  other means the claim is unproven.
- The rule is the same one this project applies at three other layers, which is why it is worth naming
  rather than leaving implicit: the registry's submission gate reports an inconclusive probe as `ok: null`
  rather than a rejection; the acceptance ladder reports an unrunnable rung as **skipped**; and `verify`
  reports a failure rather than a pass when it cannot find the gate it runs.
- **The failure-injection suite is what makes `accepted` mean something.** Without it, the verdict is a
  function that has only ever been observed saying yes.
