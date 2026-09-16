# Registry

What this plugin contributes to `awesome-dsh-plugin`, and why it is not submitted yet.

## The list, and why this is not a hub

`dsh` needs no registry to install a plugin — `dsh plugin add` resolves an npm name, a git spec, or a
tarball directly. Discovery is a separate layer, split across three repositories:

| Repository | Owns | A contributor edits it? |
|---|---|---|
| **`awesome-dsh-plugin`** | The list: one YAML per plugin under `data/plugins/`, plus a generated `README.md`. Data only — no install tooling. | **Yes** |
| `smart-plugin-market` | The prober, the `market` slash command, and the shipper. Ships a derived `registry.json`. | No |
| `dsh` | A copy of that package, mounted by `dsh-web-app`. | No |

`registry.json` — the file carrying `installable`, `reason`, and `probedAt` — is **probe output**. A
contributor neither writes nor can assert it. The file a contributor writes is
`data/plugins/<owner>__<repo>.yml`, and its filename must equal `slugFor(url)`.

## Files here

| File | What it is |
|---|---|
| `dsh-plugin-anything-bundle.yml` | The entry, in the list's submission format. **Not submittable yet** — see below. |
| `plugin-metadata.json` | Runtime metadata the entry format does not carry: `requires`, the tool list with purposes, the `dsh` range built against, and where the skill lives. Nothing reads it yet; that is deliberate. |

## Validate

```sh
node scripts/validate-registry-entry.mjs
node scripts/validate-registry-entry.mjs --upstream /path/to/awesome-dsh-plugin
```

The validator reads `CAT_IDS` and `slugFor` **out of the upstream source and evaluates them**, rather than
importing the module or copying the values. Importing fails — that module's own top-level
`import yaml from 'js-yaml'` does not resolve without the upstream's `npm ci`. Copying is worse: a copy
agrees with whatever it was copied from, which is a failure mode this project has already hit twice. If
upstream changes either definition, this validator fails rather than quietly following.

It separates two things that look alike and are not:

- **Format errors** — the entry is wrong. Invalid category, a non-GitHub url, a filename that does not match
  `slugFor(url)`, a missing required field.
- **Blockers** — the entry is right and the *repository* is not ready.

## Blocked on the repository, not the file

The entry satisfies every rule the list enforces mechanically. It cannot be submitted because there is no
public repository, and the list's `contributing.md` requires one that is:

- **at least 1 day old with at least 10 commits** (`check-submission.mjs`: `MIN_AGE_DAYS = 1`,
  `MIN_COMMITS = 10`) — a squashed one-commit repository is rejected outright, and a repository created
  today cannot satisfy this no matter how good the plugin is;
- carrying the **`dsh-plugin`** GitHub topic;
- declaring **`dsh.bundle`** in its `package.json` — a plugin declaring only `dsh.client` is rejected as
  *"that alone is not installable"*;
- not `deepseek-ai/deepseek-harness` itself, which is first-party rather than a plugin for `dsh`.

Once the repository exists, the submission is: set `url`, rename the file to `slugFor(url).yml`, open a PR
adding that one file, run `npm ci && node scripts/generate-readme.mjs` upstream, and commit both READMEs
with it. **Touch only your own entry.**

## The metadata gap this fills

The entry format is probe output, so `market recommend` can match a repository's prose description against
a need but cannot answer:

- **what the plugin exposes** — its tool names and what each is for, so a user knows whether the tools they
  get are the ones they asked for;
- **what it needs installed** — an `installable: true` plugin can still be useless on this machine;
- **which `dsh` version it was built against** — `dsh` is in developer preview and warns that
  compatibility-breaking changes will land.

`plugin-metadata.json` carries all three, in the package rather than in the list, so the entry format can
adopt the fields incrementally without breaking its existing consumers.

## Verify before announcing

An entry is only useful if a real user, on a machine that is not your checkout, can install it:

```sh
dsh plugin --profile fresh add dsh-plugin-anything-bundle
dsh --profile fresh --dump-config | grep '<your-row-id>'
dsh --profile fresh
```

Then restart and confirm the tools are still there. An entry pointing at a plugin that fails to load spends
the user's trust and the recommender's credibility at the same time.
