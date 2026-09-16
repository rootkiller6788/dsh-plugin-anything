# Distributing a bundle

There is **no plugin registry**. Three channels reach a user's profile, all resolved by pnpm.

```sh
dsh plugin --profile <p> add ./dsh-plugin-<target>           # local checkout (link:)
dsh plugin --profile <p> add dsh-plugin-<target>             # npm
dsh plugin --profile <p> add github:you/dsh-plugin-<target>  # git, optionally #<sha>
dsh plugin --profile <p> add ./dsh-plugin-<target>-0.1.0.tgz # a `pnpm pack` tarball
dsh plugin --profile <p> remove dsh-plugin-<target>
```

## What `dsh plugin` actually does

`apps/cli/src/plugin.ts` is a thin pnpm forwarder: it initializes the profile on first use, runs
`spawnSync('pnpm', args, { cwd: profileDir, stdio: 'inherit', shell: process.platform === 'win32' })`, then
reconciles the `dsh.profile.bundles` layer list against the installed state — a dependency resolving to a
package that declares `dsh.bundle` joins the layer stack; a removed or bundle-less one leaves it. Every
pnpm verb works (`add`, `remove`, `why`, `update`).

Relative path specs are rewritten against the invoking cwd first, so `add .` from a checkout does not
self-link the profile.

A package **without** `dsh.bundle` still installs, but only as a plain dependency: `dsh plugin` prints a
warning and activates no layer. That is the right format for a library your plugin imports.

## Profiles on disk

`$DSH_HOME/profiles/<name>/`, where `resolveDshHome()` is `$DSH_HOME` else `~/.dsh`:

```
profiles/<name>/
├── package.json          # dependencies + dsh.profile.bundles
├── cordis.patch.yml      # the user's own layer
└── pnpm-workspace.yaml
```

Layer order, over the empty root:

1. Each bundle patch named in `dsh.profile.bundles`, in list order — `@deepseek-ai/dsh-base` first.
2. The profile's own `cordis.patch.yml`.
3. The home-level `$DSH_HOME/cordis.patch.yml` — machine-local, and therefore **outranks** the per-profile one.
4. Each `--patch <path>` overlay, in argv order.

Verify with:

```sh
dsh --profile <p> --dump-config           # the composed tree, including the user layer and overlays
dsh --profile <p> --dump-default-config   # bundle layers only
```

`--dump-config` labels each layer, so you should see a `# == dsh-plugin-<target>` section.

## Prefer npm or a tarball

The git channel fetches **sources, not built artifacts** — nothing runs your `build` script. Two things
must then happen, one on each side:

- **The author** ships a `prepare` script that pnpm runs after a git install, building the published entry
  points from source. It must be self-contained: it may not assume dev-only context such as a sibling
  monorepo checkout.
- **The user** allowlists the build. pnpm ≥10 refuses to run a git dependency's `prepare` until it is
  explicitly allowed, so the first `add` fails. The fix is to copy the package key pnpm printed into the
  profile's `pnpm-workspace.yaml`:

  ```yaml
  allowBuilds:
    dsh-plugin-<target>: true
  ```

  and re-run the `add`.

Frame that allowance honestly when you recommend it:

> Treat it as permission to execute the package's code on your machine at install time, **outside any
> sandbox the agent runs under**. Only allow packages whose source you trust, and pin a commit
> (`github:you/repo#<sha>`) so a later push cannot silently change what runs.

Neither the npm nor the tarball channel needs any build permission:

- **npm** — build `lib/` at `pnpm publish` time; `dsh plugin add <pkg>` installs prebuilt code.
- **tarball** — `pnpm pack`, then `dsh plugin add ./<pkg>-<version>.tgz`.

**Default to one of those two.** Reach for git only when there is no other option, and then pin the commit.

## Pre-release churn

`dsh` is in developer preview and says so: *"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."* Backends
reject old on-disk formats. A plugin that peers on `@deepseek-ai/dsh-tools` should track the installed
`dsh` version deliberately rather than assuming a wide range is safe.

Note also that the published dist-tags are not what you might expect: at the time of writing,
`@deepseek-ai/dsh-tools`'s `latest` tag points at an old `0.0.1-rc.x` while the live line sits under
`next` / `alpha`. A bare `npm install @deepseek-ai/dsh-tools` therefore installs the wrong thing. Pin an
explicit range and check `npm view <pkg> dist-tags` rather than trusting `latest`.
