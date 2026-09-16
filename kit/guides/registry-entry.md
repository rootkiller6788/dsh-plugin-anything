# Getting a plugin discovered

**Do not build a hub.** One exists, and a second would fragment discovery.

## Three repositories, three jobs

Getting this wrong sends you editing the wrong file, so it is worth stating plainly. The registry layer is
split across three places, and only one of them is what a contributor touches.

| Repository | Owns | A contributor edits it? |
|---|---|---|
| **`awesome-dsh-plugin`** | The **list**: one YAML file per plugin under `data/plugins/`, plus a generated `README.md`. Data only — no install tooling. | **Yes. This is the one.** |
| `smart-plugin-market` | The **prober, market, and shipper**: `scripts/probe.mjs`, the `market` slash command, and install-by-shelling-out-to-`dsh plugin`. Ships a generated `data/registry.json`. | No |
| `dsh` (`packages/market/smart-plugin-market`) | A copy of the same package, mounted by the `dsh-web-app` bundle. | No |

`awesome-dsh-plugin` is an **awesome-list whose README is generated from its data directory**. There is no
install tooling in it, and no `probe.mjs` — that belongs to `smart-plugin-market`.

## The submission, step by step

`contributing.md`, verbatim:

> Open a PR that adds **one file**, named after your repo — `data/plugins/<owner>__<repo>.yml`
>
> Then regenerate both READMEs and commit them along with your YAML file

```sh
npm ci && node scripts/generate-readme.mjs
```

**The README regeneration is enforced, not advisory.** `pr-check.yml` runs
`node scripts/generate-readme.mjs --check` and fails with:

> `::error::The READMEs are generated from data/plugins/. Edit the YAML file, run 'node scripts/generate-readme.mjs', and commit both.`

And: *"If you're updating your own entry, change only your own entry."*

## What a contributor actually writes

One YAML file per plugin, `data/plugins/<owner>__<repo>.yml`, where the filename must equal `slugFor(url)`.
A monorepo entry — a `url` pointing at `/tree/<branch>/packages/x` — becomes
`<owner>__<repo>--packages-x.yml`.

The slug is **purely mechanical** — `scripts/lib/entries.mjs`, verbatim:

```js
/** `https://github.com/o/r` -> `o__r`; `.../tree/main/packages/x` -> `o__r--packages-x` */
export function slugFor(url) {
  const p = url.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
  const repo = p.split('/').slice(0, 2).join('/')
  const sub = p.includes('/tree/') ? p.split('/tree/')[1].replace(/^[^/]+\//, '') : null
  const base = repo.replaceAll('/', '__')
  return sub ? `${base}--${sub.replaceAll('/', '-')}` : base
}
```

There is **no lowercasing, no sanitizing, no validation of the characters**. `https://github.com/Owner/My.Repo`
produces the filename `Owner__My.Repo.yml` — case and dots preserved exactly. So the filename is a direct
consequence of the URL, including a bad one: if your repository name contains characters that are awkward
in a filename, the entry file inherits them.

Nesting works at any depth (`/tree/main/a/b/c` → `<owner>__<repo>--a-b-c`), because everything after the
first `/tree/` has its branch segment stripped and its remaining slashes replaced. One quirk: a tree URL
pointing at a branch root with no subdirectory (`/tree/main`) yields `<owner>__<repo>--main`, since the
branch-stripping regex requires a following slash. Point the `url` at the repository, not at a branch.

```yaml
url: https://github.com/0nt-one/dsh-neo-skin
name: 0nt-one/dsh-neo-skin
category: theme
description:
  en: Neo-brutalism skin with two switchable schemes, light/dark theme support.
  zh: 新粗野主义换肤皮肤，浅色/深色自适应。
```

| Field | Required | Notes |
|---|---|---|
| `url` | yes | Must match `^https://github\.com/[^/]+/[^/]+` and be unique |
| `name` | yes | The link text |
| `category` | yes | Must be one of the 14 ids below |
| `description.en` | yes | A single line, non-empty |
| `description.zh` | no | Omit if empty — *"a missing translation is our work"* |
| `tarball` | no | `https` `.tgz` hosted on a GitHub release only |

```sh
node scripts/generate-readme.mjs      # then commit the regenerated READMEs
```

Validation is real code, not a schema file: `validateEntries()` in `scripts/lib/entries.mjs`.

### The 14 categories, in canonical order

```js
export const CAT_IDS = ['ui', 'usage', 'theme', 'model', 'session', 'memory', 'tools', 'vision', 'skill', 'workflow', 'notify', 'dev', 'market', 'fun']
```

The order is load-bearing, not alphabetical — the source comments it *"drives README section order, site
ordering, chips and the sitemap"*, and it is duplicated in `build-site.mjs` and the two `categories` blocks
in `site/locales.mjs`. Pick from the set; do not invent a category, and do not reorder the array.

`contributing.md` adds: *"This set is not fixed — see the note on categories under how submissions are
reviewed."*

## What the submission gate requires

Beyond the file format, `contributing.md` requires the **repository** to:

- declare a `dsh.bundle` manifest in its `package.json`, at the root or in a monorepo subpackage;
- contain real, working code;
- be **at least 1 day old and have at least 10 commits**;
- be actively maintained;
- carry the `dsh-plugin` GitHub topic;
- avoid superlatives and marketing language, and describe itself accurately against the code, with a
  category matching what it does.

`scripts/check-submission.mjs` enforces the mechanical half (`MIN_AGE_DAYS = 1`, `MIN_COMMITS = 10`,
`MAX_TREE_PKGS = 40`, `CONCURRENCY = 6`), with `GATE_EFFECTIVE_FROM` defaulting to `2026-08-16T00:00:00Z` so
the age and commit rules skip PRs older than the gate. The manifest check always applies.

Its rejection strings are worth reading before submitting, because they name the exact failure modes:

| Rejection | What it means for a generated bundle |
|---|---|
| `this is DeepSeek Harness itself, not a plugin for it` | `deepseek-ai/deepseek-harness` is a first-party repo and cannot be listed as a plugin |
| ``` `<sub>/package.json` has no `dsh.bundle` ``` | The manifest contract in `HARNESS.md` §6 — get `dsh.bundle.patch` right or nothing else matters |
| `declares only `dsh.client` — that alone is not installable` | A browser-only half is not a bundle |
| `no package.json anywhere in the repository` | — |
| `repository not found` / `repository is archived` | — |
| `repository is ${ageDays} days old (needs 1) — resubmit in about ${hours}h, nothing is held against a resubmission` | Submit the day after creating the repo |
| `repository has ${commits} commit(s) (needs 10)` | A squashed one-commit repository is rejected |

Two design choices in that script are worth copying into any gate this project writes:

- **Inconclusive is never a rejection, and is reported separately from passing.** A truncated tree gives
  `ok: null, why: 'the repository tree is too large for the API to return in full'`; a repository with more
  manifests than the cap is likewise inconclusive, not failed. The rationale is stated in the source: *"a
  gate that cannot tell 'passed' from 'never ran' is worse than no gate."* This is the same principle as
  `plugin_anything_verify` refusing to report a pass when it could not locate the verifier.
- **A repo lookup that returns non-200 skips rather than fails** — a transient API problem must not read as
  a bad submission.

`pr-check.yml` additionally runs a stale-fork guard (failing when a PR removes more than two entries and
`removed > added`), `npx awesome-lint`, and `scripts/build-site.mjs` for locale parity and date derivation.

## The two advisory scanners

Neither blocks anything; both exist because the mechanical gate passed a bad submission once.

- **`check-bleed.mjs`** — *reports, does not enforce* (`process.exit(0)` either way). Flags two entries
  sharing a 40-character run of squashed description text in the same locale, skipping same-owner pairs
  because *"siblings share boilerplate by design"*. It exists because of an issue where a PR appended its
  own sentence to an unrelated plugin and *"every existing check passed both times."*
- **`scan-decay.mjs`** — runs weekly and *flags, never removes*.

The lesson generalizes: a format gate cannot catch a description that is accurate in form and wrong in
substance. Read your own entry as a reviewer would.

> **The trap this guide previously fell into.** `registry.json` — the file with `installable`, `reason`,
> `owner`, `repo`, and `probedAt` — is **probe output, not a submission format**. Those fields are observed
> by `probe.mjs` scanning repositories, and a contributor neither writes nor can assert them. If you are
> looking at a file with `installable` in it, you are looking at the wrong file.

## What the prober measures

`smart-plugin-market`'s `probe.mjs` asks exactly one question of a repository: does its `package.json`
declare `dsh.bundle.patch`? That is the whole of `installable`.

- **Default (root mode):** fetch the root `package.json`. Missing → `installable: null`,
  `reason: 'no-root-package.json'`. Declares a bundle → `true`, `'root-bundle'`. Present without one →
  `null`, `'root-no-bundle'` (monorepos are deliberately not excluded).
- **`--deep` (needs a token):** enumerate the git tree and check up to the first 40 `package.json` blobs.

Because it is a probe of the repository, a plugin cannot declare its own way into an `installable: true`
entry. **Making `dsh.bundle.patch` correct in `package.json` is what makes a plugin discoverable** — which
is why `HARNESS.md` §6 treats that field as the whole manifest contract rather than one field among many.

## The metadata gap this project can fill

Compare the two ecosystems' registry formats:

| | CLI-Anything | `awesome-dsh-plugin` |
|---|---|---|
| Fields | `name, display_name, version, description, requires, homepage, source_url, install_cmd, entry_point, skill_md, category, contributors` | `url, name, category, description.{en,zh}, tarball` |

CLI-Anything's entry tells a user **what the tool is called, how to install it, what it needs at runtime,
and where its skill doc lives.** The awesome-list entry tells a reader where the repository is.

That is a deliberate difference — one is an install manifest, the other is a reading list — and the market
closes part of the gap by probing. What the probe still cannot answer:

- **What the plugin exposes** — its tool names and what each is for. `market recommend` matches a
  repository's prose description against a need; it cannot tell whether the tools that arrive are the ones
  the user wanted.
- **What it needs installed** — a binary on `PATH`, an API token, a running service. An `installable: true`
  plugin can still be useless on this machine.
- **Which `dsh` version it was built against.** `dsh` is in developer preview and says compatibility-breaking
  changes will land.

Contribute the first two from the package rather than trying to add them to the list's data: a
`plugin-metadata.json` beside your plugin, or a documented README section, listing `requires`, the tool
names with one-line purposes, and the `dsh` range you built against. A field the prober ignores is still
readable by anyone who wants it, and it can be adopted incrementally without breaking the list's existing
consumers.

## Verify before you announce

An entry is only useful if a real user on a machine that is not your checkout can install it:

```sh
dsh plugin --profile fresh add dsh-plugin-<target>
dsh --profile fresh --dump-config | grep '<your-row-id>'
dsh --profile fresh
```

Then restart and confirm the tools are still there. An entry pointing at a plugin that fails to load spends
the user's trust and the recommender's credibility at the same time.

## Still to confirm

**`scan-decay.mjs`'s criteria** were not read past "runs weekly, flags, never removes". It cannot reject a
submission, so this is informational rather than blocking.

Everything else in this guide was read from the source files it cites: `contributing.md`,
`scripts/lib/entries.mjs`, `scripts/check-submission.mjs`, `scripts/check-bleed.mjs`, and `pr-check.yml`.

## How this guide was corrected

The version that first shipped described the wrong file entirely — the probe's `registry.json` rather than
the submission YAML — and guessed at two `slugFor` edge cases, one of which (character sanitizing) turned
out to be the opposite of the truth: the slug is purely mechanical and sanitizes nothing.

Both errors were caught by reading the source, which is the standing rule: `contributing.md` and
`scripts/lib/entries.mjs` are the authority, and a summary — including this one — is not. The same rule
caught the `private: true` drift in `dsh`; see `in-tree-vs-out-of-tree.md`. It is worth naming the shape of
the failure: **a plausible summary of a format is more dangerous than no summary**, because it is specific
enough to act on and wrong enough to waste the attempt.
