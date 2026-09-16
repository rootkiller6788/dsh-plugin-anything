# Seam or Consumer?

Phase 1 of the SOP asks for exactly one decision before any code: is the target a **capability seam**, or
just a **Consumer** registering tools?

**Default to Consumer.** Wrongly choosing "seam" is expensive and hard to undo; wrongly choosing Consumer
is cheap and reversible, because a Consumer can be lifted into a seam later when a second implementation
actually appears.

## What a seam is

A **capability seam** comprises three roles — Service Definition, Service Provider, Consumer — and it is
complete, never one role. Split the roles into separate packages only when they evolve independently.

| Role | Owns | Example (`packages/shell`) |
|---|---|---|
| **Service Definition** | The request/spec vocabulary and the `ctx` key | the bash request type and its resolution rules |
| **Service Provider** | One concrete implementation | the local process-tree provider; the pwsh provider |
| **Consumer** | Model-facing tools over the capability | the bash tool |

The seam's payoff is that the *policy* is shared while the *mechanism* is swappable: the same tool works over
a local shell, a PowerShell host, or a remote sandbox without the tool knowing which.

Two design rules the `dsh` repo enforces on seams:

- **Explicit over implicit at package boundaries.** Defaulting is an explicit `resolve(request): Spec` step
  in the owning implementation — never a hidden `?? default` inside `run()`. The `dsh-shell` request/spec
  split is the template.
- **A registry's `register()` returns the disposer**, and every contribution goes through
  `ctx.effect()` / `ctx.on()`.

## When a seam is justified

All three must hold:

1. **More than one implementation is genuinely plausible.** Not "might be nice someday" — you can name two
   concrete backends that would differ in mechanism while sharing intent. (`git` / `hg` / `jj` behind one
   version-control capability qualifies.)
2. **Other plugins would consume the capability, not the tool.** If only your own tool ever calls it, the
   seam is ceremony.
3. **The roles change for different reasons.** If the definition, the provider, and the consumer would all
   be edited by the same commit forever, they are one package pretending to be three.

## What a generated plugin almost always is

A **Consumer**:

```
dsh-plugin-<target>/
├── cordis.patch.yml          # mounts the plugin row
└── src/
    ├── index.ts              # apply: named exports, Config, fail-loud asserts
    ├── provider.ts           # THE ONE MODULE that touches the target
    └── <tool>.ts             # one module per tool, each registering one definition
```

There is no Service Definition because nothing else will provide an alternative implementation of
"the widget toolchain". `provider.ts` plays the *role* of a provider — it is the single place the outside
world is touched — without needing the seam's packaging ceremony. That is the isomorphic counterpart of
CLI-Anything's `utils/<software>_backend.py`.

## The promotion path

If a second implementation later appears, the lift is mechanical and does not break users:

1. Extract the request/spec vocabulary out of `provider.ts` into a Service Definition package.
2. Turn `provider.ts` into one Provider implementing it.
3. Leave the tool modules untouched — they only ever saw the provider's functions.

Because a Consumer's tool modules talk to `provider.ts` rather than to the target directly, this stays
possible. If you skip `provider.ts` and let three tool modules each spawn the binary, you have made the
lift a rewrite instead of an extraction. **That is the whole reason for the single-module rule.**
