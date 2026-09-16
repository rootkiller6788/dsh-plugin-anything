/**
 * `plugin_anything_promote` — freeze a live dynamic cordis package into a bundle on disk.
 *
 * This is the capability `dsh` does not have. A dynamic package is born in the `cordis` preset's
 * `cordis_define` / `cordis_run` tools and, per `tool-cordis`'s README, "cannot be promoted
 * automatically": it lives in process memory, changes no configuration, and does not survive a restart.
 *
 * Promotion is a source *transformation*, not a copy, and it escalates trust — code that ran inside a
 * `node:vm` sandbox under a fiber the toolset managed becomes unsandboxed code on disk that runs on the
 * next boot. It is registered conditionally and renders as a `diff` for exactly that reason.
 *
 * @module dsh-plugin-anything-bundle/promote
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeBundle } from './backend.ts'
import { filesMeta } from './meta.ts'
import type { ToolOptions } from './tools.ts'

/**
 * The dynamic-package inspection surface provided by `@deepseek-ai/dsh-cordis-host-runner`.
 *
 * Read from that package's shipped declarations rather than assumed. The model-facing *tool* is
 * `cordis_inspect_self`; the underlying *service* is `ctx.dynamicCordisRunner`, and the method that returns
 * source is `inspectPackage(agent, pluginId, packageId)` — three things this file originally got wrong by
 * conflating the tool with the service.
 *
 * Declared structurally rather than imported: `cordis-host-runner` is mounted by the `dsh-web-app` bundle
 * and absent from `dsh-base`, so a hard import would make this plugin unloadable in a headless profile.
 */
interface DynamicCordisRunner {
  /**
   * Read one exact immutable Package and its Host and Client source.
   * @param agent - the Agent whose Session must own the Plugin.
   * @param pluginId - the Plugin that owns the Package.
   * @param packageId - the immutable Package to inspect.
   * @returns the Package's metadata and its stored function bodies under `code`.
   */
  inspectPackage(
    agent: unknown,
    pluginId: string,
    packageId: string,
  ): { code: { host?: string; client?: string } }
}

/**
 * Register `plugin_anything_promote`, but only where the cordis runtime is mounted.
 *
 * `cordis-host-runner` is present in `dsh-web-app` and absent from `dsh-base`, so the tool must not be
 * advertised in a profile that cannot serve it — a tool that exists and always fails is worse than one that
 * is simply not there.
 *
 * @param ctx - the plugin context.
 * @param options - the resolved paths and budget.
 */
export function registerPromoteTool(ctx: Context, options: ToolOptions): void {
  ctx.inject(['dynamicCordisRunner'], (scoped: Context) => {
    const runner = scoped.get('dynamicCordisRunner') as DynamicCordisRunner | undefined
    if (runner === undefined) return

    scoped.tools.register(defineTool({
      name: 'plugin_anything_promote',
      description:
        'Capture a dynamic cordis package that currently works as source on disk, so it can be turned into a '
        + 'real bundle that survives a restart. This writes an INTERMEDIATE artifact, not a finished bundle: '
        + 'the package body uses sandbox-provided globals and opens with a top-level return, so it must be '
        + 'converted (see guides/static-promotion.md) before it will compile. Review the diff: the result '
        + 'runs unsandboxed.',
      parameters: {
        pluginId: { type: 'string', required: true, description: 'The plugin the package belongs to.' },
        packageId: { type: 'string', required: true, description: 'The package within that plugin.' },
        target: {
          type: 'string',
          required: true,
          description: 'Lowercase kebab-case name for the resulting bundle, e.g. "widget".',
        },
        outputDir: { type: 'string', description: 'Parent directory for the new bundle. Defaults to config.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            root: { type: 'string', required: true },
            written: { type: 'array', items: { type: 'string' }, required: true },
            hasClientHalf: { type: 'boolean', required: true },
            reviewNotes: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: [
            `promoted to ${value.root}`,
            ...value.written.map((path) => `  + ${path}`),
            '',
            'Before installing, review:',
            ...value.reviewNotes.map((note) => `  - ${note}`),
          ].join('\n'),
        }],
        presentationMeta: (_args, value) => ({ root: value.root, written: value.written }),
      },
      async execute(args, exec) {
        // The service requires the owning Agent: a Plugin belongs to a Session, and the runner refuses to
        // read one without it. `exec.agent` is optional in the execution record, so its absence is a real
        // case to report rather than a value to assert.
        const agent = exec.agent
        if (agent === undefined) {
          throw new Error(
            'promotion needs the owning Agent to read a dynamic package, and this call has none. '
            + 'A dynamic package belongs to a Session; invoke this from a session, not outside one.',
          )
        }
        const inspection = runner.inspectPackage(agent, args.pluginId, args.packageId)
        const host = (inspection.code.host ?? '').trim()
        if (host === '') {
          throw new Error(
            `package ${args.packageId} has no host half to promote. A package with only a client half is `
            + `resolved by a person rather than by code, so there is nothing to freeze.`,
          )
        }

        const reviewNotes = [
          'The promoted source came from a dynamic package, which the sandbox docs describe as isolated '
            + 'globals but NOT a security boundary. It will now run unsandboxed on the next boot.',
          'The package used no imports. Every value it needs from the outside world must become a real ESM '
            + 'import or a validated Config field — a bare global that the sandbox provided will be '
            + 'undefined here.',
          'Anything it read from process.env must become a Config field. A hardcoded tunable is prohibited.',
          'Error handling was a Run card the model could repair. It is now user-facing: fail loud at load '
            + 'for self-contained problems.',
        ]
        if ((inspection.code.client ?? '').trim() !== '') {
          reviewNotes.push(
            'This package also has a client half. Its React must use React.createElement, and the browser '
            + 'half is not covered by the generated bundle.',
          )
        }

        const root = `${args.outputDir ?? options.outputDir}/dsh-plugin-${args.target}`
        // The body is written to `promoted/`, deliberately OUTSIDE `src/`.
        //
        // It is a sandbox function body, not a module: it opens with a top-level `return`, which is valid
        // where it ran and a compile error anywhere else. Placing it in `src/` — as the first version did —
        // makes the generated bundle fail its own typecheck before any conversion has happened, which reads
        // as "promotion produced broken code" rather than "promotion produced an intermediate artifact".
        // The `.js.txt` suffix keeps editors and bundlers from treating it as a source file.
        const outcome = await writeBundle(root, [
          {
            path: `promoted/${args.target}.host.js.txt`,
            contents: [
              `// Promoted from dynamic package ${args.pluginId}/${args.packageId}.`,
              '//',
              '// This is the package body EXACTLY as it ran in the sandbox. It is an intermediate artifact, not',
              '// a module: it opens with a top-level `return`, and it uses globals the sandbox provided and a',
              '// real bundle does not (a `harness` helper object among them).',
              '//',
              '// Convert it per guides/static-promotion.md — real imports, Config fields, load-time validation —',
              '// and use plugin_anything_scaffold for the surrounding manifest and patch. Keep this file: it is',
              '// the record of what actually ran.',
              '',
              host,
              '',
            ].join('\n'),
          },
        ])
        return { root, written: outcome.written, hasClientHalf: (inspection.code.client ?? '').trim() !== '', reviewNotes }
      },
      presentCall(args) {
        return { card: 'generic', kind: 'edit', title: `promote ${args.pluginId}/${args.packageId}` }
      },
      presentResult(_args, result) {
        if (result.isError) return undefined
        const meta = filesMeta(result.meta)
        if (meta === undefined) return undefined
        return {
          card: 'diff',
          title: `promoted to ${meta.root}`,
          diffs: meta.written.map((path) => ({ path: `${meta.root}/${path}`, oldText: null, newText: 'created' })),
          locations: meta.written.map((path) => ({ path: `${meta.root}/${path}` })),
        }
      },
    }))
  })
}
