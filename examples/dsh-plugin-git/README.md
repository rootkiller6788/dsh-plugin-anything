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

```sh
node scripts/verify-plugin.mjs .
node --test tests/
```
