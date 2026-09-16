# Backend: an external CLI binary

The most common target, and the one this harness's default templates encode.

## The single-module rule

`src/provider.ts` is the **only** module that spawns a process. Tool modules call its functions; they never
build an `argv` and never touch `node:child_process`. This is the counterpart of CLI-Anything's
`utils/<software>_backend.py`, and it is what keeps every tool module testable without the binary installed.

## Spawn correctly

```ts
const { stdout, stderr } = await run(backend.command, [...args], {
  signal: options.signal,       // exec.signal, passed straight through
  timeout: options.timeoutMs,   // the cooperative budget
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
})
```

Four things:

1. **Pass the signal through; do not race a timer against it.** A racing timer rejects the promise but
   leaves the child process running.
2. **Use `execFile`, not `exec`.** `exec` goes through a shell, which means argument injection becomes
   command injection. Your tool's arguments come from a model — treat them as untrusted. If the target
   genuinely requires shell syntax, that is a deliberate, documented decision, not a default.
3. **Set `maxBuffer`.** A tool that prints a large tree will otherwise fail with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, which
   reads like a target bug.
4. **Never reimplement the target.** If the binary can do it, invoke it. Do not parse its output format and
   reassemble it in TypeScript — that is the failure mode CLI-Anything names as its first iron rule.

## Resolve the binary lazily, fail loud

Two positions on a missing binary, and both are defensible:

- **Fail at `apply`.** Right when the plugin is useless without it. `apply` is the earliest self-contained
  point, so this is `misconfiguration fails loud` doing its job.
- **Fail at the first call.** Right when a plugin may be loaded in a profile that never uses it. Resolve
  from `PATH` lazily and let the invocation fail.

Whichever you pick, **do not degrade silently.** A tool that returns "command not found" as a successful
string result teaches the model that the tool works when it does not.

Make the command a `Config` field so a deployment can point at a non-`PATH` install:

```ts
export const Config: z<Config> = z.object({
  command: z.string().default(''),
  timeoutMs: z.number().default(30_000),
})
```

## Render intent: `terminal`

A tool that runs a command should present as a terminal card — the model's call *is* a shell command, and
the user's UI should say so:

```ts
presentCall(args) {
  return { card: 'terminal', title: `${backend.command} ${args.subcommand} ${args.target}`, cwd: args.cwd }
}
presentResult(_args, result) {
  return { card: 'terminal', title: basename(backend.command), output: result.stdout }
}
```

Both must be pure. `cwd` comes from `args`, never from `process.cwd()`.

If the tool also writes files, add `locations` so a capable editor follows along.

## Output discipline

The exit status is data, not an exception — decide which is which:

- **Non-zero exit meaning "the answer is no"** (a `git diff --quiet` that finds no changes) → return a
  value with a boolean, not a throw.
- **Non-zero exit meaning "the call failed"** (a usage error, a missing file) → throw, so the pipeline
  records a real failure the model can see and repair.

Do not return raw stdout as the canonical value when stdout is a human-facing table. Parse it into the
structured value your `output.schema` declares, and let `output.render` do the prose. That split is what
makes the tool programmable from Code Mode instead of merely usable.

## Segments, not passthrough

Do not expose a single `run(args: string[])` tool that forwards arbitrary argv. That is a shell with extra
steps, and it forfeits every benefit of a typed tool: no validation, no render intent, no structured output,
no per-operation approval. Expose the four to eight operations the target is actually used for.
