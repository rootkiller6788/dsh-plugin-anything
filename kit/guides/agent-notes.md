# Agent Notes

`dsh` requires that a non-trivial change carry an Agent Note in the same PR. This harness adopts the same
institution, for the same reason: the *why* behind a decision is the thing that decays, and the code only
records the *what*.

## Layout

Notes live under `notes/` with **two axes encoded in the path**:

```
notes/{lifecycle}/{class}/yyyy-mm-dd-topic-title.md
```

Lifecycle folders:

- **`proposed/`** — proposals reviewed before implementation; not yet built, or only partly.
- **`implemented/`** — the decision shipped. The file records what was decided and what was rejected, and is
  **kept current with what actually shipped**.
- **`rejected/`** — considered and declined. Keep it only while its rationale prevents a tempting,
  meaningful mistake; otherwise delete the triplet.
- **`archived/`** — a frozen, append-only tree. Archived notes are never edited and never treated as current
  authority.

Classes (closed set): `feature`, `bug-fix`, `simplification`, `architecture`, `process`, `testing`.

## When one is required

> Every non-trivial change MUST add or update at least one Agent Note in the same PR. A change is
> non-trivial when it alters behavior, architecture, a contract shared across files or packages, process or
> tooling, testing strategy, an on-disk, wire, or configuration format, or another decision a maintainer may
> reasonably revisit.

Only mechanical or local edits are exempt.

For this project, that means at minimum: adding a tool, changing the plugin contract, changing a template
that generated output derives from, or changing what `verify-plugin.mjs` enforces.

## Format

```markdown
# Agent Note: <title>

Status: <status>
```

Exactly three legal statuses, and the gate cross-checks status against the folder:

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <why, in one line>`

### Body skeletons

`proposed/` — `## Problem` → `## Proposal` → *bespoke sections* → `## Alternatives considered` →
`## Acceptance criteria` → `## Risks`

`implemented/` — `## Problem` → `## Decision` → *bespoke sections* → `## Alternatives considered` →
`## Consequences`

**`## Alternatives considered` is mandatory in every note.** A note that records only the chosen option
cannot be revisited later, because the reason the alternatives lost is exactly what a future maintainer
needs in order to know whether their situation is different.

An `implemented/` note may **not** contain `## Proposal`, `## Plan`, `## Migration plan`, or
`## Acceptance criteria` — those are the vocabulary of a proposal, and their presence means the note was
never updated to describe what shipped.

## Writing one well

- State the problem in terms of an observed failure or a concrete constraint, not a preference.
- Record what was **rejected and why**. This is the part that has value.
- Keep it current. An `implemented/` note that no longer describes the code is worse than none, because it
  is authoritative-looking and wrong.
- If you learned that a published doc contradicts the code, write that down. This project already has one
  such case — see `in-tree-vs-out-of-tree.md` — and the note is what stopped it from being rediscovered.
