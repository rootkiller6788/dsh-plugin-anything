# plugin-anything:list Command

List all available plugin-anything bundles — both installed into a dsh profile and generated on disk.

**This command is read-only. It writes nothing.** No install, no build, no manifest edit, no cache directory.

## Usage

```bash
/plugin-anything:list [--path <directory>] [--depth <n>] [--json]
```

## Options

- `--path <directory>` — Directory to search for generated bundles (default: current directory)
- `--depth <n>` — Maximum recursion depth for scanning (default: unlimited). Use `0` for the current directory only, `1` for one level deep, etc.
- `--json` — Output in JSON format for machine parsing

## What This Command Does

### 1. Installed bundles

A bundle is "installed" when a dsh profile lists it in `dsh.profile.bundles`. `dsh plugin` is a thin pnpm forwarder: it runs `pnpm` in `$DSH_HOME/profiles/<p>/` and then reconciles `dsh.profile.bundles` against the installed state. So both halves of that state are readable from the filesystem, and neither requires calling `dsh`:

- `$DSH_HOME/profiles/<p>/package.json` → the `dsh.profile.bundles` array lists the activated bundles
- `$DSH_HOME/profiles/<p>/node_modules/<name>/` → where the installed code actually lives

Resolve `DSH_HOME` from the environment; when it is unset, report that no installed bundles could be discovered rather than guessing a path.

```js
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dshHome = process.env.DSH_HOME
const profilesRoot = dshHome === undefined ? undefined : join(dshHome, 'profiles')

// Per profile: read package.json, take dsh.profile.bundles, and confirm each entry
// resolves under node_modules/.
```

### 2. Generated bundles

A directory is a generated bundle when it holds a `package.json` that declares `dsh.bundle.patch` — that field, not a directory name, is the marker. A manifest without it installs as a plain dependency and activates no layer.

- Pattern: `**/package.json`, filtered by `dsh.bundle.patch` being a non-empty string
- Extract: bundle name, version, the patch path, and whether that patch file actually exists
- Status: `generated`; `installed` when the same name also appears in a profile

Depth behaves exactly as in the table below: `--depth 2` finds bundles at depth 0, 1, **and** 2, not only at 2.

```js
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Walk at most `maxDepth` levels under `base`, yielding every package.json found.
 * @param {string} base - directory to scan.
 * @param {number} maxDepth - levels to descend; `Infinity` for unlimited.
 * @param {number} level - current depth, supplied by recursion.
 */
function* manifests(base, maxDepth, level = 0) {
  const manifest = join(base, 'package.json')
  if (existsSync(manifest)) yield manifest
  if (level >= maxDepth) return
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    yield* manifests(join(base, entry.name), maxDepth, level + 1)
  }
}
```

Skip `node_modules` while walking — it is where installed copies live, and those are reported by the installed scan, not by the generated one.

### 3. Merge results

- Key by bundle name so a name appears once.
- When a name is both installed and generated, report `installed` and keep the generated `source` path, which is where the checkouts are.
- Prefer relative paths in the table for readability; keep absolute paths in `--json`, where a consumer may need to act on them.

## What This Command Does Not Do

It does not run `node scripts/verify-plugin.mjs`, `dsh --profile <p> --dump-config`, or any package manager. Listing answers "what is here"; checking whether it works is [`validate`](./validate.md)'s job.

## Output Formats

### Table Format (default)

```
plugin-anything bundles (found 4)

Name                     Status      Version   Patch               Source
──────────────────────────────────────────────────────────────────────────────────────
dsh-plugin-ffmpeg        installed   0.1.0     cordis.patch.yml    ./ffmpeg
dsh-plugin-notes-api     installed   0.2.0     cordis.patch.yml    ./notes-api
dsh-plugin-blender       generated   0.1.0     cordis.patch.yml    ./blender
dsh-plugin-rclone        generated   0.1.0     cordis.patch.yml    ./rclone
```

When a bundle's manifest points at a patch file that is missing, mark the row so the gap is visible rather than silent:

```
dsh-plugin-rclone        generated   0.1.0     MISSING             ./rclone
```

### JSON Format (--json)

```json
{
  "bundles": [
    {
      "name": "dsh-plugin-ffmpeg",
      "status": "installed",
      "version": "0.1.0",
      "patch": "cordis.patch.yml",
      "patch_present": true,
      "source": "/projects/tools/ffmpeg",
      "profiles": ["dev", "work"]
    },
    {
      "name": "dsh-plugin-blender",
      "status": "generated",
      "version": "0.1.0",
      "patch": "cordis.patch.yml",
      "patch_present": true,
      "source": "/projects/tools/blender",
      "profiles": []
    }
  ],
  "total": 2,
  "installed": 1,
  "generated_only": 1
}
```

## Error Handling

| Scenario | Action |
|---|---|
| No bundles found | Print "No plugin-anything bundles found" |
| `--path` does not exist | Print `Path not found: <path>` and stop |
| `DSH_HOME` unset | Skip the installed scan, continue with the generated scan, note it once |
| Permission denied on a directory | Skip it, continue scanning, report a warning |
| `package.json` present but unparseable | Skip that directory and report it as a warning; do not fail the whole scan |

## Implementation Steps

When this command is invoked, the agent should:

1. **Parse arguments** — `--path` (default `.`), `--depth` (default unlimited), `--json` (default off).
2. **Validate `--path`** — if it does not exist, report and stop.
3. **Scan installed bundles** — read `$DSH_HOME/profiles/*/package.json`, collect `dsh.profile.bundles`, and confirm each resolves under that profile's `node_modules/`.
4. **Scan generated bundles** — walk from `--path` to `--depth`, reading each `package.json` and keeping those with a `dsh.bundle.patch`.
5. **Merge** — one entry per name; installed wins on status, generated supplies `source`.
6. **Format** — table with aligned columns, or JSON to stdout.
7. **Print** — a summary count line, then the table or JSON.

## Examples

```bash
# List every bundle under the current directory
/plugin-anything:list

# Scan two levels deep only
/plugin-anything:list --depth 2

# Current directory only, no recursion
/plugin-anything:list --depth 0

# Machine-readable output
/plugin-anything:list --json

# Search a specific tree with a depth limit
/plugin-anything:list --path /projects/tools --depth 3

# Combined
/plugin-anything:list --path ./output --depth 2 --json
```

## Notes

- `--depth` counts directory levels descended from the search path; the default is unlimited.
- A generated bundle is recognized by `dsh.bundle.patch`, never by a directory naming convention.
- The scan never executes a bundle, and never touches the network.
- Re-running the command is always safe: it produces identical output for identical input.
