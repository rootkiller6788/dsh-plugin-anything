# The tool contract

Everything a generated tool must satisfy. Verified against the `dsh` sources named inline; where a
prose doc and the source disagree, the source wins (this has already bitten once — see
`in-tree-vs-out-of-tree.md`).

## Registration

```ts
ctx.tools.register(definition: ToolDefinition): () => void
```

The layer is the calling context's scope: a plain plugin context registers globally. `register` returns a
disposer, and because the call is made on a `ctx` obtained inside `apply`, the calling fiber already owns
it — **disposed with the calling fiber**, no manual cleanup.

`docs/testing.md` requires an HMR-safety test for anything that registers: dispose the contributing fiber,
assert the registration is gone.

`defineTool` (exported from `@deepseek-ai/dsh-tools`) is the authoring helper. It validates the model's
`arguments` against the compiled parameter schema **before** `execute` runs, throwing `ToolArgsError`
(code `INVALID_ARGS`), and infers `args` from `parameters` and the return type from `output.schema`.

## The definition object

`packages/core/tools/src/schema.ts` — `DefineToolOptions`:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Unique within its layer; a duplicate throws at registration |
| `description` | yes | What the model reads to decide whether to call it |
| `parameters` | yes | The input DSL, compiled to an implicit **open** object root |
| `output.schema` | yes | The canonical value's schema; enforced on every success body |
| `output.render` | yes | Pure: `(args, value) => ContentBlock[]` — the only model-facing prose |
| `output.presentationMeta` | no | Pure replayable UI metadata for direct top-level calls |
| `execute` | yes | `(args, exec) => Promise<value>` |
| `timeoutMs` | no | Positive cooperative budget; a non-positive or non-finite value fails **at registration** |
| `isConcurrencySafe` | no | Pure classifier: may this call join a parallel group |
| `finalizeContent` | no | Definition-owned, synchronous, total, content-only; runs once per normalized outcome |
| `presentCall` / `presentResult` | no | Pure presenters; see below |

## The input schema DSL is its own language

**Neither Schemastery nor raw JSON Schema.** `packages/core/tools/README.md`:

> The unified schema DSL uses `ParameterSchemaSpec` for the implicit open parameter object and
> `ValueSchemaSpec` for any JSON-value root. It supports `string`, `number`, `integer`, `boolean`, `null`,
> `array`, `object`, author-only `json`, and exact-one `oneOf`; scalar `enum`/`const` values are type-correct.
> Every explicit DSL object declares `additionalProperties: true | false`, while the implicit parameter root
> and raw JSON Schema keep the standard open default.

Node shapes, from `schema.ts`:

```ts
interface ObjectValueSchemaSpec {
  type: 'object'
  properties?: ParameterSchemaSpec     // a map of ParameterPropertySpec
  additionalProperties: boolean        // MANDATORY on every explicit object
}
interface ArrayValueSchemaSpec { type: 'array'; items?: ValueSchemaSpec }
type ParameterPropertySpec = ValueSchemaSpec & { required?: true }
```

Two consequences that are easy to get wrong:

1. **There is no `required` array on an object node.** Requiredness is the per-property `required: true`
   annotation. Writing `required: ['a','b']` produces a schema the DSL does not define.
2. `additionalProperties` is **mandatory** on every explicit object — openness must be stated, never
   inherited, so a nested or output object can't acquire an accidental JSON Schema default.

All nodes accept the shared annotations `description`, `title`, `default`, `examples`.

**Two different schema languages in one file is the normal case, not a mistake**: `Config` is Schemastery,
tool parameters are the DSL above.

## `execute` — three things commonly assumed wrong

```ts
async execute(args, exec) { /* ... */ }
```

1. **There is no `ctx` parameter.** The body closes over the `apply(ctx, config)` ctx lexically. `exec` is
   the execution record, not a context: `ToolRunContext` extends `ToolExecution`
   (`{ token, callId, name, arguments, signal, agent?, parent? }`) and adds `deferContext(context)`.
2. **`exec.signal` is the abort signal** (required, readonly) and must be honored on every path. Pass it
   down to `execFile`, `fetch`, and any other cancellable API rather than racing a timer against it — a
   racing timer leaks the child process on abort.
3. **`execute` returns the canonical JSON value declared by `output.schema`, not content blocks.** The
   registry snapshots it as lossless JSON, validates it, freezes it, then calls `output.render(args, value)`.
   `packages/core/tools/README.md`:

   > Do not return content blocks from the body or make callers parse prose for ids and fields.

   A generator that returns prose produces a tool the model can use but that cannot be programmed against:
   Code Mode's `ToolOutputMap` derives from `output.schema`.

## Render intent

Call cards (`ToolCallView`):

| Card | Fields |
|---|---|
| `generic` | `title`, optional `kind` (`'read'｜'edit'｜'delete'｜'move'｜'search'｜'execute'｜'fetch'｜'other'`), `rawInput` (salient input for a detail view — **not** the full args), `content`, `locations` |
| `terminal` | `title` (the command), optional `description` (rendered above the card), `cwd` |
| `diff` | `title`, `diffs` (`{ path, oldText, newText }`; `oldText: null` for a create/overwrite), `locations` |

Result cards (`ToolResultView`): `generic`, `terminal` (`title?`, `output?`, `exitCode?` XOR `signal?`),
`diff`, `search`, `read`, `web`.

`locations: FileLocation[]` (`{ path, line? }`) is what a capable editor follows or jumps to. It appears on
the two call views that touch files (`generic`, `diff`).

Omitting the presenter **or** returning `undefined` selects the generic fallback: title = tool name, raw
args as input.

### `presentResult` does NOT receive your canonical value

The contract's sharpest edge: getting it wrong is invisible until a typecheck, and then it is 20 errors.

```ts
interface ToolResult {
  content: ContentBlock[]   // the final model-facing content (or the rendered error text)
  isError: boolean          // whether the call failed
  meta?: JsonValue          // the tool-private presentation payload
}
```

So `result.entries`, `result.stdout`, and `result.path` do not exist, and `result` is **not** the value your
`execute` returned. The canonical value is not on the wire — only its rendered text is, from which structured
fields cannot be recovered. Anything a card needs must be projected by `output.presentationMeta`, which
becomes `result.meta`.

`packages/fs/tool-fs` is the template for the pattern (`read.ts:120-132` for the projection, `read.ts:172`
and `write.ts:143` for the presenters):

```ts
output: {
  schema: { /* … */ },
  render: (_args, value) => [{ type: 'text', text: value.path }],
  // The UI channel — the only way a presenter sees structured data.
  presentationMeta: (_args, value) => ({ path: value.path, lines: value.lines }),
},

presentResult(_args, result) {
  if (result.isError) return undefined
  const meta = readMetaFromMeta(result.meta)     // narrow; undefined on any mismatch
  if (meta === undefined) return undefined        // generic fallback — never a throw
  return { card: 'read', path: meta.path, /* … */ }
},
```

Four rules that follow:

1. **Narrow `result.meta`; never assert it.** It is `JsonValue | undefined`, and a log written by another
   version of your tool must render as the generic fallback rather than crash a replay. Write a small
   `xFromMeta(meta)` helper per tool, as `tool-fs` does with `diffsFromMeta` / `readMetaFromMeta`.
2. **Guard `if (result.isError) return undefined`** — unless the failure is itself what is worth showing.
   A verify tool that *reports* a failed check is a successful call (`isError: false`), so it must not guard;
   a tool whose call actually failed has no meaningful card.
3. **Fall back to `args` where the args are enough.** `tool-fs` derives a diff from `args` when `meta` is
   absent, which is why `FileDiff.oldText` may be `null`: a call-time presenter has no prior file content.
4. **Never read I/O, session state, a clock, or randomness.** These run on live streaming *and* on replay.

### The two hard rules

**Purity.** `packages/cookbook/adding-a-tool.md`:

> These run on live streaming AND on session-log REPLAY, so they must be pure functions of `args` (+ the
> result) — NO I/O, NO reading session state, NO clock/random. […] If you find yourself wanting the file's
> old content or the working directory inside `presentCall`, stop — that belongs in durable result metadata
> or the adapter, not the presenter.

`defineTool` soft-validates both presenters: malformed or older logged arguments return `undefined` (generic
fallback) rather than throwing, because *display must never crash a replay*.

**UI-only formatting stays out of the model result.** A fenced ```` ```console ```` block, a diff, or a
relativized path never belongs in the canonical value or the Native content merely to serve a UI.
`output.render` owns model-facing prose; `presentationMeta` plus the card presenters own replayable UI state.

## The execution pipeline

```
tools/pre-execute → registered monotonic guards → tools/execute
  → tools/post-execute → definition-owned finalizeContent → tools/result
```

All three waterfalls **must call `next()`** to delegate; returning without it short-circuits the chain.

| Stage | May change |
|---|---|
| `tools/pre-execute` | Decides `{ kind: 'allow' }` / `{ kind: 'deny', reason }` / `{ kind: 'ask', reason? }`. **Input rewrite is deliberately not offered.** `ask` is serviced by `ctx.approval` when mounted, and otherwise degrades to deny. |
| `ctx.tools.guard(guard)` | Returns a string to deny. **Monotonic**: evaluated after the waterfall, so a later listener cannot turn a guard denial back into permission. |
| `tools/execute` | Wrappers may replace **only** the operational `signal`, never delete it. Timeout/retry/metrics live here. |
| `tools/post-execute` | Accept may replace `content` **or** `value` (never both) and may attach `additionalContexts`. Value replacement is revalidated and re-renders content/metadata. |
| `finalizeContent` | Content-only, synchronous, exactly once per normalized outcome. |
| `tools/result` | Emit, observe-only; receives the immutable frozen lossless-JSON outcome. |

> **Naming trap:** `tools/result` is the live event; `tool/result` is the **durable session event** the
> agent loop appends afterwards. Near-identical names, entirely different semantics.

These are optional for a generated plugin. Reach for `tools/pre-execute` when a tool must refuse to run
against an unavailable backend, and `ctx.tools.guard` when a security invariant must not be reorderable.

## Scope

A plain tool plugin registers globally and never touches scope APIs. The per-agent axis exists for
variants: `agent.ctx` registrations shadow a same-named global tool for that agent alone, `restrict(filter)`
applies an agent-scoped allow/deny mask, and `presentAs(mode)` selects one agent's presentation. Both
`restrict` and `presentAs` throw from a plain context. `restrict` is **live visibility composition, not an
authority boundary**.

## A worked example

`templates/tool.ts.template` in this kit is a complete, contract-correct tool module: the DSL input
schema, an output object with mandatory `additionalProperties` and per-property `required`, an `execute`
that honors `exec.signal`, and pure `terminal` presenters.
