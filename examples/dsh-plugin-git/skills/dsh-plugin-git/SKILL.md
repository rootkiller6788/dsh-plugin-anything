---
name: dsh-plugin-git
description: Drive git from dsh: Inspect a git repository: status, history, and diffs.
---

# git

This skill covers driving git through the `dsh-plugin-git` tools.

## Prerequisites

- `git` is installed and on `PATH`, or its absolute path is supplied as the plugin's
  `command` config.

## Tools

| Tool | Use it for |
|---|---|
| `git_status` | Show the working tree status of a repository. |
| `git_log` | List recent commits from a repository. |
| `git_diff` | Show the diff for a repository. |

## Notes

- Every tool passes its arguments to the real `git` binary. The plugin never reimplements it.
