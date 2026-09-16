# Examples

Generated bundles, one per target. **These are generator output, not hand-written code.**

```sh
# Re-render (from the repository root):
node --experimental-strip-types bundle/scripts/render-example.mjs git

# Gate them:
node kit/scripts/verify-plugin.mjs examples/dsh-plugin-git
```

CI asserts that what is committed here equals what the templates currently render. If you edit a template
and CI reports drift, re-run the render command — do not hand-patch the example. An example that has
drifted from its template is worse than no example, because it validates a contract nothing produces any
more.

## `dsh-plugin-git`

Three tools over the `git` binary (`git_status`, `git_log`, `git_diff`), chosen to exercise a multi-tool
bundle: one plugin package, one module per tool, one `apply` wiring them all.

**It is unedited scaffold output, so it still contains `TODO(...)` markers.** `plugin_anything_scaffold`
cannot know a parameter's description or what the backend call should be, so it marks those places loudly
rather than inventing them. That is the intended state — see the `nextStep` the tool returns.

Those markers are what a real generation run replaces in Phase 3 of `HARNESS.md`, and the placeholder-count
assertions in `bundle/tests/pipeline.test.mjs` are what stop an unresolved placeholder from ever shipping
silently.

### What this example does and does not prove

- **Proves:** the templates render a bundle the gate accepts; the entry wires every tool in the spec with
  correctly derived identifiers; each tool module carries the verified contract for the schema DSL, the
  canonical-output rule, and pure presenters.
- **Does not prove:** that it loads in a real `dsh`. That needs `dsh plugin --profile dev add`, a
  `--dump-config` check, a live tool call, and a restart — see
  `kit/guides/verification.md` for the full sequence and for what each layer of
  verification is actually worth.
