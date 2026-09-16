# Agent Note: Reuse the existing plugin market instead of building a registry

Status: implemented

## Problem

This project is an isomorphic mirror of CLI-Anything, and CLI-Anything's distribution story is
`registry.json` plus a `cli-hub` package-manager CLI and web frontend. Mirroring it structurally suggests
building the same thing for `dsh`: a `plugin-anything-registry.json`, an installer package, a browsable hub.

Before writing any of that, the plan was to establish what `dsh` already had. Two findings changed the
answer:

1. `packages/market/smart-plugin-market` is a **complete, working plugin market**, not a stub. It reads a
   registry of ~1200 entries sourced from the `awesome-dsh-plugin` repository, exposes a `market` slash
   command (`recommend | list | search | install | remove`), and installs by shelling out to the official
   `dsh plugin` command — its own README states the principle: *"装/卸：复用官方 `dsh plugin` 命令（子进程转发
   pnpm + reconcile），不重造依赖管理"*.
2. `dsh` has **no need for a registry to install anything.** `dsh plugin add` is a pnpm forwarder over three
   channels — an npm name, `github:owner/repo#sha`, or a `pnpm pack` tarball — and all three resolve
   without a central index.

A second registry would therefore not fill a gap. It would duplicate a working one, fragment discovery
across two indexes, and inherit the maintenance cost of both.

## Decision

**Do not build a hub.** The distribution layer of this project is:

- Generated bundles carry a public repository with the `dsh-plugin` topic, which is how the existing prober
  finds them.
- Registry contributions reuse the existing `awesome-dsh-plugin` submission format and go through the
  existing install path.
- The one genuinely missing thing is **runtime metadata**. CLI-Anything's registry entry carries
  `requires`, `entry_point`, `skill_md`, and `version`; the awesome-list entry carries only
  `{url, name, category, description.{en,zh}, tarball?}`. Nothing in the pipeline states what a plugin
  exposes, what it needs installed, or which `dsh` version it was built against. That gap is what this
  project contributes to, incrementally, rather than replacing.

**Correction (same day, from reading the repositories).** An earlier draft of this note described the
submission format as `{url, name, category, description, owner, repo, installable, reason, probedAt}`. That
is the **probe output** in `smart-plugin-market`'s generated `data/registry.json`, not what a contributor
writes. The registry layer is three repositories with distinct jobs: `awesome-dsh-plugin` holds the list
(one YAML per plugin under `data/plugins/`, plus a generated README — data only, no tooling);
`smart-plugin-market` owns the prober, the market command, and the shipper; and `dsh` ships a copy of that
package. `installable` and `reason` are *observed by* the prober scanning a repository's `package.json` for
`dsh.bundle.patch` — a contributor neither writes nor can assert them. `guides/registry-entry.md` carries
the corrected format and states the trap explicitly.

## Alternatives considered

- **Build a parallel registry and hub, as CLI-Anything has.** Rejected: it duplicates a working system for
  no capability gain, and two indexes of the same ecosystem is a strictly worse user experience than one.
- **Contribute the missing fields to the existing format and nothing else.** Rejected as the whole answer,
  because the prober's `installable` / `reason` fields are derived by scanning repositories, not read from
  a declaration — so a plugin cannot simply assert its own runtime metadata into an entry. The metadata has
  to live in the package and be adoptable later.
- **Recommend only npm and tarball installs and skip discovery entirely.** Rejected: discoverability is not
  optional; it is the difference between a usable ecosystem and a pile of repositories.

## Consequences

- The project has no `cli-hub` analogue, and `HARNESS.md` §10 says so explicitly with the reason, so a
  future contributor does not "fix" the apparent omission.
- `guides/registry-entry.md` documents the existing format, the existing install path, and the metadata gap
  as the thing to contribute into.
- The git install channel carries a trust cost that has to be stated rather than hidden: it fetches sources
  rather than artifacts and requires an `allowBuilds` entry, which is permission to execute the package's
  code at install time outside any sandbox. `guides/bundle-distribution.md` recommends npm or a tarball and
  says plainly why.
- Nothing here is verified against a live market instance from this repository. The registry facts come
  from reading `packages/market/smart-plugin-market` in the `dsh` snapshot, and the exact submission path
  for `awesome-dsh-plugin` is still to be confirmed against that repository. That is recorded as
  unverified in the guide rather than asserted.

## Follow-up: how the entry is validated (same day)

The entry now exists at `registry/dsh-plugin-anything-bundle.yml`, with `scripts/validate-registry-entry.mjs`
checking it. Two decisions in that script are worth recording.

**It reads the upstream rules out of the source and evaluates them, rather than importing or copying them.**
The list's rules live in real code — `CAT_IDS` and `slugFor` in `scripts/lib/entries.mjs` — and neither
obvious approach works. Importing fails: that module's own top-level `import yaml from 'js-yaml'` does not
resolve without the upstream's `npm ci`. Copying the values is worse: a copy agrees with whatever it was
copied from, and this project has already been bitten twice by a confident copy of a format that had moved
(`private: true`, and the registry format itself — see the correction appended above). Reading the source
means an upstream change surfaces here as a failure instead of as silent divergence.

**A filename mismatch is reported differently depending on its cause.** The filename must equal
`slugFor(url)`, so with a placeholder `url` the expected name is *derived from the placeholder* and the
mismatch is a symptom of the unfinished url, not a second mistake. With a real url it is a genuine format
error. The validator separates **format errors** ("the entry is wrong") from **blockers** ("the entry is
right and the repository is not ready") for exactly this reason — reporting them the same way would tell a
reader to fix the wrong thing.

That distinction mirrors the list's own submission gate, which reports an inconclusive probe as
`ok: null` rather than as a rejection, on the stated grounds that *"a gate that cannot tell 'passed' from
'never ran' is worse than no gate."* The acceptance ladder adopts the same rule: it reports a **skip** for a
rung it could not run.

**The entry is format-complete and cannot be submitted.** There is no public repository, and the list
requires one at least a day old with at least ten commits, carrying the `dsh-plugin` topic. `registry/README.md`
lists the blockers; the validator prints them after the format checks pass.
