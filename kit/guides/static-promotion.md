# Static promotion: from a live dynamic package to a bundle on disk

This is why this harness exists.

`dsh` already ships a loop that generates plugins from a request: the `cordis` agent preset mounts
`tool-cordis`, whose seven tools (`cordis_inspect_list`, `cordis_inspect_query`, `cordis_inspect_self`,
`cordis_define`, `cordis_run`, `cordis_stop`, `cordis_undefine`) let the model inspect its own runtime,
write a package, and run it. That loop is excellent for exploration and useless for delivery, because of a
hard boundary (`packages/extensions/tool-cordis/README.md`):

> Dynamic packages live only in the shared DSH process memory. […] disappear after
> `cordis_stop`/`cordis_undefine`, toolset unload, or DSH restart. **They create no Plugin file, install no
> package, change no `cordis.yml` or personal/project configuration, do not survive restart, and cannot be
> promoted automatically.**

Promotion is what `plugin_anything_promote` does: take a dynamic package that works and freeze it into
`package.json` + `cordis.patch.yml` + `src/` — a real bundle a user can `dsh plugin add` and still have
after a restart.

## Reading a package out of the runtime

The API, read from `@deepseek-ai/dsh-cordis-host-runner`'s shipped declarations:

```ts
ctx.dynamicCordisRunner.inspectPackage(agent, pluginId, packageId)
//   -> { code: { host?: string; client?: string }, /* plus name, purpose, and lifecycle pointers */ }
```

Four things are easy to get wrong here, and this project got three of them wrong on the first attempt:

1. **The service is `dynamicCordisRunner`, not `cordisInspect`.** `ctx.cordisInspect` exists and is a real
   service, but it is the read-only *capability query* registry — `list()` and `query(platform, providerId,
   methodName, input, agent, signal)`. It does not carry package source.
2. **The model-facing tool is not the service.** `cordis_inspect_self` is a tool; `inspectPackage` is the
   method. Conflating them is how `inspect.self(pluginId, packageId)` got written against a method that
   does not exist.
3. **The owning `Agent` is the first argument.** A Plugin belongs to a Session, and the runner will not read
   one without it. In a tool, that is `exec.agent` — which is optional, so its absence is a case to report.
4. **The source is nested under `code`.** `{ code: { host, client } }`, not `{ host, client }`.

A typecheck cannot catch any of these if you declare the interface locally — it agrees with itself. Compare
against the shipped `.d.ts` in `node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/types/`, or copy the
shape into a test and assert the argument order, as `bundle/tests/promote.test.mjs` does.

## What a dynamic package contains

A package is plain JavaScript, split across two halves:

- `code.host` — runs in the host process under a `node:vm` sandbox in the `cordis-dynamic` group fiber.
- `code.client` — runs in the browser.

Both are **function bodies that return a Cordis Plugin**. The execution environment rules
(`cordis-plugin-development/SKILL.md`) are the constraint that shapes the conversion:

> Do not use: `import`, `require`, TypeScript types, `as`, decorators, or JSX; globals not confirmed by
> `Builtin.listBuiltins`; guessed access to `window`, `document`, `process`, `Buffer`, `fetch`, or native
> timers. Client React code must use `React.createElement(...)`.

The canonical host shape:

```js
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('tool.view.cordis', () => slots.register(/* … */))
  },
}
```

## The promotion is a transformation, not a copy

| Dynamic package | Promoted bundle |
|---|---|
| `code.host` body with no imports | `src/index.ts` with real ESM imports |
| `ctx.get('name')` with an absence check | the same, or a declared `inject` when it is a hard dependency |
| Values inlined in the source | deployment-varying values become `Config` fields with Schemastery defaults |
| No module identity | `export const name` + named exports, no default export |
| Not on disk | `package.json` with `dsh.bundle.patch`, plus `cordis.patch.yml` |
| Volatile | Survives restart |

Four things the promotion must add that the dynamic package never needed:

1. **Types.** The dynamic sandbox takes plain JS precisely because it is not compiled. A bundle is compiled,
   so every `ctx.get(...)` result needs narrowing and every tool definition needs its DSL types. Do not
   translate `any`-typed JavaScript into `any`-typed TypeScript — that discards the main benefit of taking
   the static path.
2. **A `Config` schema.** Everything a deployment could vary must become a validated field. In the sandbox
   you could read `process.env` directly; in a bundle that is a hardcoded tunable, which `dsh` forbids.
   A `DEFAULT_*` constant is not configurability.
3. **Error handling at the boundary.** The sandbox reports failures into a Run card the model can see and
   repair. A bundle fails in front of a user, so `apply` must fail loud at load for self-contained problems
   (missing backend binary, invalid config) and each tool must return a well-formed value or throw.
4. **Lifetime discipline.** `codis_run` installed the package under a fiber the toolset managed.
   In a bundle, `apply`'s registrations are owned by the fiber automatically — so do not carry over any
   manual teardown, and do not hoist a registration to module scope.

## What cannot be promoted

- **A package with a browser half** is an answerable round trip: `cordis/request-run` suspends and is
  settled **by a person**, with **no timeout**. Promotion needs the settled artifact, not the suspended
  request, so ask for the final state rather than reading a pending one.
- **A package whose behavior depends on sandbox-only globals** must be rewritten, not moved. The sandbox
  confirms available globals through `Builtin.listBuiltins`; a bundle has ordinary Node globals, which is
  strictly less constrained — but any *guessed* global must be replaced by a real import.
- **A package the author does not have the source for.** Promotion is a source transformation; it needs
  `cordis_inspect_self(pluginId, packageId)` to return the base source.

## Trust

Do not treat promotion as a security boundary. The dynamic sandbox *"isolates globals but is not a security
boundary"*, and its own documentation says to *"treat this toolset like bash access."* Promotion takes code
that ran in that sandbox and writes it to disk where it will run unsandboxed on the next boot. That is a
real escalation of trust, and it should be surfaced to the user as one — show the diff, say what it will do
when it loads, and let them decide. The `plugin_anything_promote` tool renders as a `diff` card precisely
so the change is reviewable before it lands.
