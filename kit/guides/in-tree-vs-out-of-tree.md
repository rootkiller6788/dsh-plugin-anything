# In-tree package vs out-of-tree plugin

`dsh` has **two different plugin contracts**, and a generator that confuses them produces something that
either fails the monorepo's gates or fails to load at all. Decide which one you are writing before anything
else. The default for this harness is **out-of-tree**.

| | In-tree `packages/<group>/<pkg>` | **Out-of-tree plugin** |
|---|---|---|
| Name | Must be `@deepseek-ai/dsh-<name>` | Anything (`dsh-plugin-<target>`) |
| `private` | Must **not** be `true` | Omit when publishing |
| `publishConfig.access` | Must be `"public"` | Not required |
| `repository` | Must match the published URL, with `directory` equal to the package dir | Not required |
| `version` | Must equal the root `package.json` version | Free |
| `@deepseek-ai/cordis` | In **both** `peerDependencies` and `devDependencies`, identical range | Only if you import it |
| `./invariant` export | Required, and must declare `types` + `default` as a pair | Not required |
| `files` | Must equal the gate's computed list **exactly** | Free |
| Per-file 100% coverage | Required (`test:coverage`, not `test`, is the CI gate) | Not required |
| Workspace registration | `tsconfig.host.json` / `client.json` refs, `knip.json` | None |
| Install | Part of the monorepo | `dsh plugin --profile <p> add <pkg>` |

Everything in the right column is why this harness targets out-of-tree: the generator's job shrinks to a
six-field manifest and a three-file package.

## The stale-doc trap

`dsh`'s `docs/cookbook/adding-a-package.md` states that in-tree packages require `"private": true`.

**That is wrong.** `scripts/check-workspace-constraints.ts` currently does the opposite. The relevant
branch:

```ts
const releaseMemberDirectory = /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+|vendor\/[^/]+)$/
...
} else if (releaseMemberDirectory.test(dir)) {
  // Release members state that they are publishable: npm refuses a private
  // package, and the repository field is how a consumer finds the source of
  // the package it installed.
  if (manifest.private === true) {
    errors.push(`${label}: release member must not set "private": true`)
  }
  if (manifest.publishConfig?.access !== 'public') {
    errors.push(`${label}: release member must set publishConfig.access to "public"`)
  }
  if (manifest.repository?.type !== 'git'
    || manifest.repository.url !== publishedRepositoryUrl
    || manifest.repository.directory !== dir) {
    errors.push(`${label}: release member repository must use ${publishedRepositoryUrl} with directory ${dir}`)
  }
} else if (manifest.private !== true) {
  errors.push(`${label}: package.json must set "private": true`)
}
```

So `packages/*/*`, `apps/*`, and `vendor/*` must be **publishable-shaped**, and `private: true` is only the
fallback for directories outside those three prefixes. Verified empirically: zero manifests under
`packages/*/*` set it.

**Lesson for this harness: trust the gate source, not the prose.** The gates in the `dsh` repo are the
specification; the cookbook is a summary that drifts. When they disagree, read
`scripts/check-workspace-constraints.ts` and `scripts/verify-cordis-config.ts`.

## Where `private: true` actually belongs

On a **profile** manifest — never a package. A profile is never published:

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": { "dsh-plugin-widget": "link:/path/to/dsh-plugin-widget" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-widget"] } }
}
```

## Bundle vs profile — nothing is both

> A bundle is what you author and distribute; a profile is what a user boots with `dsh --profile <name>`.
> **Nothing is both.**

Your plugin is a **bundle**: it declares `dsh.bundle.patch`. A profile is the user's composition that
*lists* bundles. Do not put `dsh.profile` on a package you intend to publish.

A manifest may technically declare both keys — `app-boot` says so explicitly — but that is for in-repo
apps, not for something you ship to users.

## No deeper nesting

`checkHierarchyShape()` enforces that `packages/<group>/` must **not** contain a `package.json`, and
`packages/<group>/<pkg>/package.json` must exist. The hierarchy is exactly `packages/<group>/<pkg>`.

## If you really are contributing in-tree

Read, in this order: `docs/cookbook/adding-a-package.md` (as a starting point, not as truth),
`packages/AGENTS.md`, `docs/development.md`, and the gate sources. Expect to add an **Agent Note** (see
`agent-notes.md`) and a keyless snapshot in the same PR, and expect `pnpm run hygiene` and
`pnpm run test:coverage` to be the things that decide whether your change is acceptable.
