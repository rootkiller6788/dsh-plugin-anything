/**
 * The `git_diff` tool.
 *
 * One tool per module, registered by a single `apply<Name>Tool` function, mirroring the split in the
 * dsh repo's `packages/fs/tool-fs` (`read.ts` / `write.ts` / `edit.ts`).
 *
 * @module dsh-plugin-git/git_diff
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { invoke, type GitBackend } from './provider.ts'

/** What this tool module needs from the plugin's `apply`. */
export interface GitDiffOptions {
  /** The resolved backend handle; the only way this module reaches the real system. */
  readonly backend: GitBackend
  /** Cooperative timeout budget for one call. */
  readonly timeoutMs: number
}

/**
 * Register the `git_diff` tool.
 * @param ctx - the plugin context; the registration is owned by this fiber and disposed with it.
 * @param options - the backend handle and timeout budget.
 */
export function applyGitDiffTool(ctx: Context, options: GitDiffOptions): void {
  ctx.tools.register(defineTool({
    name: 'git_diff',
    // This line is what the model reads to decide whether to call the tool. Say what it does and when
    // to reach for it; do not restate the parameter list.
    description: 'Show the diff for a repository.',

    // The input schema DSL — NOT Schemastery, and not raw JSON Schema. `required` defaults to false.
    parameters: {
      target: { type: 'string', required: true, description: 'TODO(PARAM_DESCRIPTION)' },
      limit: { type: 'integer', description: 'Maximum number of entries to return.' },
    },

    output: {
      // The canonical value. `execute` MUST return exactly this and nothing else; the registry
      // snapshots it as lossless JSON, validates it, freezes it, and only then renders it.
      //
      // Note the object node's shape: `additionalProperties` is MANDATORY on every explicit object,
      // and there is NO `required` array — requiredness is the per-property `required: true`
      // annotation (see `ObjectValueSchemaSpec` / `ParameterPropertySpec` in the DSL).
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: { type: 'array', items: { type: 'string' }, required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      // The only place model-facing prose is produced.
      render: (args, value) => [{
        type: 'text',
        text: value.truncated
          ? `${value.entries.join('\n')}\n\n(truncated to ${args.limit ?? 'the default'})`
          : value.entries.join('\n'),
      }],
      // The UI channel, and the ONLY way a presenter can see structured data. `presentResult` receives a
      // `ToolResult` — `{ content, isError, meta? }` — not the canonical value: the raw value is not on the
      // wire, only the model-facing text, from which these fields cannot be recovered. Whatever a card
      // needs must be projected here.
      presentationMeta: (_args, value) => ({ entries: value.entries, truncated: value.truncated }),
    },

    // No `ctx` parameter here: the body closes over the `ctx` and `options` above lexically.
    // `exec` is the execution record, not a context. `exec.signal` must be honored on every call.
    async execute(args, exec) {
      const { stdout } = await invoke(
        options.backend,
        ['diff', args.target, ...(args.limit === undefined ? [] : ['-n', String(args.limit)])],
        { signal: exec.signal, timeoutMs: options.timeoutMs },
      )
      const entries = stdout.split('\n').filter(line => line !== '')
      const limit = args.limit ?? entries.length
      return { entries: entries.slice(0, limit), truncated: entries.length > limit }
    },

    // ── Presentation ─────────────────────────────────────────────────────────────────────────────
    // These run on live streaming AND on session-log REPLAY, so they are PURE functions of `args` and
    // the result: no I/O, no session state, no clock, no randomness. `defineTool` soft-validates them,
    // so a malformed historical argument yields `undefined` (the generic fallback) rather than a throw —
    // display must never crash a replay.
    //
    // This tool drives a CLI, so it renders as a terminal card. A tool that writes files would render
    // `diff` with populated `locations` instead; anything else stays `generic` (omit the method).

    presentCall(args) {
      return {
        card: 'terminal',
        title: `git diff ${args.target}`,
        description: 'Show the diff for a repository.',
      }
    },

    // `result` is a `ToolResult`, NOT the canonical value. Read the structured data from `result.meta`,
    // which `presentationMeta` above projected, and decline to `undefined` (the generic fallback) when it
    // is absent or a different version of the tool wrote the log. Never throw on a replay of old output.
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = entriesFromMeta(result.meta)
      if (meta === undefined) return undefined
      return {
        card: 'terminal',
        title: 'git',
        output: meta.truncated ? `${meta.entries.join('\n')}\n(truncated)` : meta.entries.join('\n'),
      }
    },
  }))
}

/**
 * Narrow an opaque `ToolResult['meta']` to the shape {@link applyGitDiffTool} projected.
 * @param meta - the result's presentation payload, as logged.
 * @returns the narrowed entries, or undefined when the payload is absent or shaped differently.
 */
function entriesFromMeta(meta: unknown): { entries: string[]; truncated: boolean } | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const { entries, truncated } = meta as { entries?: unknown; truncated?: unknown }
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) return undefined
  return { entries, truncated: truncated === true }
}
