# plugin-anything:test Command

Run the test layers for a generated dsh plugin bundle and append the results to `tests/TEST.md`.

## CRITICAL: Read HARNESS.md First

**Before running anything, read `../HARNESS.md`.** §8 defines the three test layers and the policy behind them; §11 defines the verification checklist. A green unit run is not a passing test suite here — the keyless snapshot is mandatory and is not satisfied by unit tests.

## Usage

```bash
/plugin-anything:test <plugin-path-or-repo>
```

## Arguments

- `<plugin-path-or-repo>` — **Required.** Either:
  - A **local path** to the generated bundle directory (the one holding `package.json` with `dsh.bundle.patch`)
  - A **Git repository URL** — cloned locally first, then tested on the local copy

  If the path holds no `dsh.bundle.patch`, stop and say so: that directory is not a bundle, and running its tests would prove nothing about whether it loads.

## What This Command Does

Runs four checks in order, and only writes `tests/TEST.md` if all of them are clean.

### 1. Unit layer — no target, no API key

Pure logic and the provider's argument construction. On the bundle, run its own `test` script (`pnpm test`). The kit's own tests run with:

```sh
node --test tests/
```

### 2. Keyless snapshot — no API key

Replay the bundle's snapshot: the full transcript of a **real runnable example**. This is the layer that covers model- and user-visible behavior, and it is the one most likely to be skipped.

Two things make a snapshot valid, and neither is optional:

- **It was produced by really running the tool**, not assembled by hand. dsh's policy is explicit: package tests, e2e-only assertions, and mock-only fixtures do not substitute for the assembled application transcript. A hand-written fixture standing in for a snapshot is prohibited.
- **It replays on macOS and Linux.** When it does not, fix the fixture. Never fix the normalizer to accommodate a machine-specific fixture.

A presenter is exercised here too: replay a log with deliberately malformed arguments and assert the generic fallback rather than a throw. The tier table, the "verify the world, not the self-report" rule, and the guard-proof procedure are in [`../guides/snapshot-testing.md`](../guides/snapshot-testing.md).

### 3. E2E layer — real target

Call the actual target, with `DEEPSEEK_API_KEY` set only where a model is involved. The target is a hard dependency, so its absence is a loud failure here, not a skip.

### 4. Verifier

```sh
node scripts/verify-plugin.mjs <plugin-dir>     # from the kit root
```

The script itself is at [`../scripts/verify-plugin.mjs`](../scripts/verify-plugin.mjs). It is dependency-free and static — it never claims a plugin boots, only that it satisfies the rules that fail silently otherwise: the patch filename contains `cordis`; `dsh.bundle.patch` is declared and its file exists; the patch basename is listed in `files[]`; a built package (`main` under `lib/`) also declares `exports["./cordis.patch.yml"]`; the patch root is a YAML array and not comments-only; `!!js` appears only under `config` or as the value of `disabled`; a bare row `name:` is in `dependencies`; a function plugin has no default export and does export `name`; and presenters are pure.

Run the kit's own verifier tests with `node --test tests/` when you have touched the verifier or the kit itself.

## Test Output Format

Appended to `tests/TEST.md` under a results heading, after the plan that was written first:

```markdown
## Test Results

Last run: 2026-09-16 14:30:00

### Unit (no target, no API key)

```
[full output]
```

### Keyless snapshot

```
[replay output — the real runnable-example transcript]
```

### E2E (real target)

```
[full output]
```

### Verifier

```
✓ All checks passed.
```

**Summary**: 41 passed in 2.14s · verifier: 0 errors
```

## Example

```bash
# Test a bundle built from a local target
/plugin-anything:test ./dsh-plugin-ffmpeg

# Test a bundle from its repository
/plugin-anything:test https://github.com/owner/dsh-plugin-ffmpeg
```

## Success Criteria

- Every layer passes; no failures, no errors, no skipped snapshot.
- The keyless snapshot ran without an API key, and it was produced by a real run.
- `node scripts/verify-plugin.mjs <plugin-dir>` exits 0.
- `tests/TEST.md` carries both the plan and the appended results.

## Failure Handling

If **anything** fails:

1. Report which layer failed and quote the failing output verbatim.
2. **Leave `tests/TEST.md` untouched** — the previous passing results stay as they are. A results section that mixes a stale pass with a fresh failure is worse than no update.
3. Identify whether the failure is in the plugin or in the fixture. A machine-specific snapshot diff is a fixture bug; a verifier error is a manifest or patch bug.
4. Suggest the concrete fix, and offer to re-run once it is made.

Never edit `TEST.md` to make a failure disappear, and never relax a check to get a green run.
