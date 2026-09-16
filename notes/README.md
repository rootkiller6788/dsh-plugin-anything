# Agent Notes

The record of decisions that are not derivable from the code. The code records *what*; these record *why*,
and what was rejected on the way.

The convention is `dsh`'s, adopted deliberately — see
`kit/guides/agent-notes.md` for the full rules.

## Layout

```
notes/{lifecycle}/{class}/yyyy-mm-dd-topic-title.md
```

**Lifecycle:** `proposed/` · `implemented/` · `rejected/`
**Class:** `feature` · `bug-fix` · `simplification` · `architecture` · `process` · `testing`

## Format

```markdown
# Agent Note: <title>

Status: implemented
```

Three legal statuses: `proposed`, `implemented`, or `rejected — <why, in one line>`. The status must match
the folder.

Bodies, per lifecycle:

- `proposed/` — `## Problem` → `## Proposal` → *bespoke* → `## Alternatives considered` → `## Acceptance criteria` → `## Risks`
- `implemented/` — `## Problem` → `## Decision` → *bespoke* → `## Alternatives considered` → `## Consequences`

**`## Alternatives considered` is mandatory.** An `implemented/` note may not contain `## Proposal`,
`## Plan`, `## Migration plan`, or `## Acceptance criteria` — their presence means the note was never
updated to describe what actually shipped.

## Current notes

| Note | What it records |
|---|---|
| [`implemented/architecture/2026-09-16-reuse-the-existing-plugin-market.md`](implemented/architecture/2026-09-16-reuse-the-existing-plugin-market.md) | Why this project has no `cli-hub` analogue: a working market already exists, and `dsh` needs no registry to install |
| [`implemented/bug-fix/2026-09-16-baseurl-is-not-the-package-directory.md`](implemented/bug-fix/2026-09-16-baseurl-is-not-the-package-directory.md) | Why the agent-preset skill-path idiom fails silently in a bundle patch, and what replaced it |
| [`implemented/bug-fix/2026-09-16-six-failures-no-gate-in-this-repo-could-see.md`](implemented/bug-fix/2026-09-16-six-failures-no-gate-in-this-repo-could-see.md) | Seven defects across four gates — the `ToolResult` presenter contract, the `.mjs`/`.js` build mismatch, the prerelease semver range, `promote`'s non-existent service method, the probe's PATH resolution, a render/schema name mismatch, and the sandbox body written into `src/` |
| [`implemented/architecture/2026-09-16-runtime-acceptance-as-the-top-gate.md`](implemented/architecture/2026-09-16-runtime-acceptance-as-the-top-gate.md) | Why the ladder exists, why gates do not compose into a strength ladder, and the vertical slice that closed the promote chain |
| [`implemented/architecture/2026-09-16-the-pipeline-is-the-unit-not-the-tool.md`](implemented/architecture/2026-09-16-the-pipeline-is-the-unit-not-the-tool.md) | Why the tool count was the wrong question, the pipeline as data, and the IR that makes it a compiler |
| [`implemented/testing/2026-09-16-absence-of-evidence-is-never-acceptance.md`](implemented/testing/2026-09-16-absence-of-evidence-is-never-acceptance.md) | The four verdict rules, why `every(pass)` accepts an empty run, and the nine injections that make `accepted` mean something |
