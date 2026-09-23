# dsh-plugin-git

Inspect a git repository: status, history, and diffs.

## Prerequisites

- `git` on `PATH`, or set the `command` config to an absolute path.

## Install

```sh
dsh plugin --profile <profile> add dsh-plugin-git
dsh --profile <profile> --dump-config | grep -A3 '# == dsh-plugin-git'
```

## Tools

| Tool | Use it for |
|---|---|
| `git_status` | Show the working tree status of a repository. |
| `git_log` | List recent commits from a repository. |
| `git_diff` | Show the diff for a repository. |

## Verify

The kit's static gate is not part of this bundle — copying it in would be a second copy to keep in step
with the kit's own. Run it from the kit that generated this bundle, or through the toolset, which runs
the same gate:

```sh
node <path-to-kit>/scripts/verify-plugin.mjs .
# or, with plugin_anything installed:
#   plugin_anything_verify({ path: '.' })
```

Then this bundle's own tests. `test` is this package's script, so the runner is whatever
`package.json` names rather than a second command written out here:

```sh
pnpm test
```
