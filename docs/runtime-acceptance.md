# Runtime acceptance

The gate ladder, the failure classes it exists to catch, and the acceptance scenario that runs the whole
chain for real.

The premise: **generating a plugin is the easy part.** What is hard — and what this project is actually
for — is *automatically proving* that a generated plugin loads in a real harness, is discovered by an agent,
can be called, renders, and replays. Every gate below exists because something slipped past the gates
above it.

## The ladder

```
Source
  │
  ├─ 1. Static gate        node kit/scripts/verify-plugin.mjs <dir>
  ├─ 2. Link gate          (part of the static gate: no relative link may dangle)
  ├─ 3. Type gate          npx tsc --noEmit  +  scripts/typecheck-example.mjs
  ├─ 4. Build gate         npx tsdown, then assert the manifest's `main` exists
  ├─ 5. Contract gate      tests/{promote,registration}.test.mjs
  ├─ 6. Registry gate      scripts/validate-registry-entry.mjs
  ├─ 7. Composition gate   dsh plugin add  +  --dump-config
  ├─ 8. Boot gate          actually boot the profile
  ├─ 9. Runtime acceptance the scenario below, end to end
  └─ 10. Replay gate       render from a real logged result
```

`node scripts/acceptance.mjs` runs rungs 1–8 — every deterministic one — and then prints exactly where the
keyed steps begin, with the command for each. It reports a **skip** rather than a pass when it cannot run a
rung (an absent upstream list, a profile that does not exist), drawing the same distinction the list's own
submission gate draws between a rejection and an inconclusive result.

Each rung catches things the rungs above it cannot, and **the rungs are not ordered by strength — they are
ordered by what they can see**. A defect can pass every gate up to 7.

## Failure classes

Every entry is a defect this project actually shipped, with the gate that catches it and the gate that
let it through. They are recorded here so the ladder has a reason to exist rather than being a checklist.

### F1 — Type-shape mismatch

*Assumed* `presentResult(args, result)` receives the tool's canonical value. *Actual*: a `ToolResult` —
`{ content, isError, meta? }`. Structured data reaches a card only through `output.presentationMeta` →
`result.meta`.

**Caught by:** the type gate (28 errors).
**Passed:** the static gate. Nothing about the generated files looked wrong.
**Symptom if shipped:** none, until a card misbehaves — the tool call itself works.

### F2 — Artifact mismatch

The manifest declared `main: lib/index.js`; the build emitted `lib/index.mjs`.

**Caught by:** the build gate (assert `main` exists) — added after the fact.
**Passed:** the static gate, the type gate. The build reported success.
**Symptom if shipped:** a package that installs, composes, and cannot load.

### F3 — Dependency-resolution mismatch

Peer range `^0.1.5` against a project that publishes only prereleases. Semver admits a prerelease to a range
only when a comparator carries a prerelease on the **same** `major.minor.patch`, so the range matched nothing.

**Caught by:** the build gate (`pnpm install` is what proves a range resolves).
**Passed:** everything. The range is well-formed and looks reasonable.
**Symptom if shipped:** every generated bundle is uninstallable.

### F4 — Runtime API drift

`promote` called `cordisInspect.self(pluginId, packageId)`. That service exists but is the read-only
*capability query* registry; the source lives on `ctx.dynamicCordisRunner` under
`inspectPackage(agent, pluginId, packageId)`, nested at `code.host`.

**Caught by:** the contract gate — but only because the interface was compared against the shipped `.d.ts`
and the argument order pinned by a test.
**Passed:** **everything.** A locally declared interface agrees with whatever its author assumed, so the type
gate passed it; it is not a format violation; it builds; it composes.
**Symptom if shipped:** failure on the first user who tries it.

> This is the class the ladder is built around. Three gates cannot see it by construction, because all three
> check the artifact against *itself*.

### F5 — Environment-resolution mismatch

The probe ran `isFile('git')` on a bare command name, so every PATH-installed tool was reported
`callable: false`.

**Caught by:** the runtime acceptance scenario — a real model asked about a real tool on a real machine.
**Passed:** every gate. The code is type-correct, the format is fine, it builds, it loads, it registers.
**Symptom if shipped:** the first thing a user does with the tool gives a wrong answer.

### F6 — Semantic schema mismatch

The probe's `render` printed `surface:` while its schema field is `kind`.

**Caught by:** the runtime acceptance scenario (a real model noticed and reconciled it in prose).
**Passed:** every gate.
**Symptom if shipped:** a wasted turn per call; nothing fails.

### F7 — Composition false positive

`--dump-config` printed a clean tree for a profile that then failed at boot with
`duplicate loader entry id: code-runtime`.

**Caught by:** the boot gate.
**Passed:** the composition gate — **which is the gate that was supposed to catch it.**

`--dump-config` composes and prints patch layers; it does not detect duplicate row ids. A profile mixing
`dsh-web-app` with `dsh-headless` survives only because `loadProfile` normalizes an **exact**
installation-owned bundle tuple back to its template — and appending a third-party bundle makes the list
user-owned, so normalization stops applying.

> **Every gate in this repository had a hole at some point, and this is the one that was hiding in the gate
> itself.** A clean dump is necessary, never sufficient.

## Runtime acceptance scenario

The scenario that closed the last gap. Run it against a local profile; it is the only thing that proves
**Anything → Plugin → Agent actually uses it**.

```
1.  Profile boots                                        Boot gate
2.  Plugin loads                                         Boot gate
3.  Skills appear in <available_skills>                  Runtime acceptance
4.  Tools appear to the model                            Runtime acceptance
5.  Model invokes a tool of the bundle                   Runtime acceptance
6.  cordis_define creates a real dynamic package         Runtime acceptance
7.  cordis_run activates it; the model calls it          Runtime acceptance
8.  inspectPackage reads the real package                Runtime acceptance
9.  promote writes the source                            Runtime acceptance
10. The source is converted into a bundle                Type gate + Build gate
11. The converted bundle installs and the profile reboots
12. The model calls the promoted capability              Runtime acceptance
13. The result is semantically correct                   Runtime acceptance
```

**Steps 6–12 are the chain, and step 12 is the one that matters.** Everything before it can pass while the
product does not work.

### The contrast that makes it meaningful

Between steps 7 and 12 a restart happens. Run step 5 again after it and the dynamic tool is **gone** —
that is the property promotion exists to restore:

```
$ dsh --profile <p> "Do you have a tool named e2e_dynamic_probe?"
# after cordis_run:  calls it, returns dynamic-ok
# after a restart:   NO
# after promotion + install + restart:  calls it, returns dynamic-ok
```

Without that contrast, the scenario proves only that promotion *ran*. With it, the scenario proves that the
capability **survived something it previously could not**.

## What each gate still cannot see

| Gate | Blind to |
|---|---|
| Static | Types, builds, and everything at a runtime boundary |
| Type | A locally declared interface for an external service (F4) |
| Build | Semantics, resolution-at-runtime, loading |
| Contract | Whether the host actually provides the service |
| Composition | Duplicate row ids (F7); whether the tree boots |
| Boot | Whether the model sees or can use anything |
| Runtime acceptance | Anything requiring a **restart**, unless the scenario includes one |

## Reproducing

```sh
# Static + link gate
node kit/scripts/verify-plugin.mjs --kit
node kit/scripts/verify-plugin.mjs bundle

# Type + build gate
cd bundle && pnpm install
npx tsc --noEmit -p tsconfig.json
node --experimental-strip-types scripts/typecheck-example.mjs
npx tsdown && test -f lib/index.js

# Contract + replay gate
node --test tests/registration.test.mjs tests/promote.test.mjs tests/presenter-replay.test.mjs

# Composition + boot gate (a local profile)
dsh --profile <p> --dump-config | grep '<your-row-id>'
dsh --profile <p> "reply with: BOOT-OK"
```

### Which dsh runs the gate, and why two homes

`node scripts/acceptance.mjs` defaults to the **local source** dsh — the checkout at
`deepseek-harness-master`, run through `pnpm dsh` from that directory. `--dsh published` selects the released
CLI instead, as a release-compatibility reference.

The two cannot share a home. The source build **cannot parse** a `.credentials.yaml` written by the published
line:

```
credentials-local: the value for "version" in ~/.dsh/.credentials.yaml must be a string
```

That is the version skew made visible at the one boundary where it cannot be papered over — and it is why
this project keeps two homes rather than one:

| Home | Used by | Why it exists |
|---|---|---|
| `~/.dsh` | the published CLI | the real one; the acceptance profile `panything` lives here so a model can be used |
| `.dsh-local` | the source build | forced by the credentials-format incompatibility above |
| `.dsh-cli` | neither, at runtime | the pinned published CLI install, kept as a compatibility reference |

### Version portability, measured

The bundle peers on `^0.1.5-rc.2`. The source build is `0.1.0-rc.7` — a version the range does **not** admit.
It composes and boots on both anyway: **`dsh` does not enforce peer ranges at load time.** The same bundle
therefore works against both published lines, verified rather than assumed.

### The acceptance profile

`~/.dsh/profiles/panything` mounts `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless`, this bundle, and —
via its own `cordis.patch.yml` — `cordis-host-runner` and `tool-cordis`. Mounting those two directly rather
than through `dsh-web-app` is what makes a **headless** acceptance run possible: `dsh-web-app` and
`dsh-headless` both insert `code-runtime`, so a profile with both fails at boot (F7). The pair is also what
`plugin_anything_promote` needs — it registers only where the dynamic cordis runtime is mounted.

`.dsh-local/profiles/panything` is the same profile, recreated for the source build.
