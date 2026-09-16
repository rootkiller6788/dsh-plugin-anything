/**
 * The backend: Capability IR in, DSH plugin source out.
 *
 * Pipeline stages 4→7, mechanized. If the IR is complete, this is deterministic — every part of a tool
 * module is already described by it: the invocation (what to run), the inputs (the parameters), the outputs
 * (the canonical value), the permissions (what to warn about). The judgement happened upstream, in
 * extraction and planning; by the time a capability reaches here it has already been decided.
 *
 * That is the whole point of an IR, and it is why this file must not exist in a world where each run
 * re-derives the plugin shape from the target.
 *
 * **The backend never learns which frontend ran.** It reads `invocation.type`, never `source.kind`. A CLI
 * frontend and an OpenAPI frontend that describe the same HTTP call must compile to identical source; if
 * this file ever branches on `source.kind`, the IR has stopped being an IR and become a serialization of one
 * frontend's output. `tests/compile.test.mjs` pins that.
 *
 * @module dsh-plugin-anything-bundle/compile
 */

import type { PlannedFile } from './backend.ts'
import { substitute } from './scaffold.ts'
import type { Capability, CapabilityInput, CapabilitySet, Invocation } from './ir.ts'

/** What compiling produced, and what it could not decide. */
export interface CompileResult {
  /** The files to write, relative to the bundle root. */
  readonly files: readonly PlannedFile[]
  /**
   * Things the compiler declined to invent.
   *
   * A capability whose invocation is `http` but whose permissions declare no network host is compilable and
   * suspect; so is one whose output type is `object`, because nothing in the IR says which fields it has.
   * These are reported rather than papered over.
   */
  readonly warnings: readonly string[]
}

/** A warning names the capability it is about, so a reader can act on it. */
const WARN = (capability: string, message: string): string => `${capability}: ${message}`

/**
 * Map an IR primitive onto the host's parameter DSL.
 *
 * The DSL is its own language — not Schemastery, not raw JSON Schema — and the mapping is stated here rather
 * than inlined at each call site so that adding a type is one edit.
 *
 * @param input - the IR input.
 * @returns the DSL node, as source text.
 */
function parameterNode(input: CapabilityInput): string {
  const description = JSON.stringify(input.description)
  const required = input.required ? ', required: true' : ''
  switch (input.type) {
    case 'integer': return `{ type: 'integer', description: ${description}${required} }`
    case 'number': return `{ type: 'number', description: ${description}${required} }`
    case 'boolean': return `{ type: 'boolean', description: ${description}${required} }`
    case 'string':
      return input.enum === undefined
        ? `{ type: 'string', description: ${description}${required} }`
        : `{ type: 'string', description: ${description}, enum: [${input.enum.map((v) => JSON.stringify(v)).join(', ')}]${required} }`
    // An IR array carries no element type beyond "lossless JSON", so the DSL node declares the least
    // specific thing that will validate: an open array. Narrowing it here would be inventing information.
    case 'array': return `{ type: 'array', items: { type: 'json' }, description: ${description}${required} }`
    case 'object': return `{ type: 'json', description: ${description}${required} }`
  }
}

/**
 * Map an IR output onto the DSL's value root.
 * @param output - the IR output.
 * @returns the DSL node, as source text.
 */
function outputNode(output: Capability['outputs'][number]): string {
  switch (output.type) {
    case 'integer': return "{ type: 'integer' }"
    case 'number': return "{ type: 'number' }"
    case 'boolean': return "{ type: 'boolean' }"
    case 'array': return "{ type: 'array', items: { type: 'json' } }"
    case 'object': return "{ type: 'json' }"
    case 'string': return "{ type: 'string' }"
  }
}

/**
 * Render one capability's tool module.
 *
 * The command line is bound from the declared inputs at call time. `provider.ts` is the only module that
 * touches the outside world — the rule the generated bundle is then held to by its own gate.
 *
 * @param capability - the capability.
 * @returns the module source.
 */
function toolModule(capability: Capability): string {
  const pascal = capability.id.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  const parameters = capability.inputs.length === 0
    ? '{}'
    : `{\n${capability.inputs.map((i) => `      ${JSON.stringify(i.name)}: ${parameterNode(i)},`).join('\n')}\n    }`
  const output = capability.outputs[0]
  const outputNodeText = output === undefined ? "{ type: 'string' }" : outputNode(output)

  // The binding: `{{name}}` in the template becomes the validated argument of that name.
  //
  // A capability with no inputs gets its own body rather than an empty array literal. `[].filter((entry):
  // entry is string => …)` does not compile — with no elements the literal's type is `never[]`, and a type
  // predicate cannot narrow `never` to `string` (`TS2677`). The npm-CLI golden case is a capability with no
  // inputs, and it found this: every fixture before it had at least one, so the shape was never generated.
  const bound = capability.inputs.length === 0
    ? '      const bound: readonly string[] = []'
    : [
      '      const bound = [',
      ...capability.inputs.map((i) => `        args[${JSON.stringify(i.name)}] === undefined ? undefined : String(args[${JSON.stringify(i.name)}]),`),
      '      ].filter((entry): entry is string => entry !== undefined)',
    ].join('\n')

  return `/**
 * \`${capability.id}\` — ${capability.description}
 *
 * Compiled from the Capability IR. Provenance: ${capability.source.kind} at ${capability.source.location}${
    capability.source.version === undefined ? '' : ` (${capability.source.version})`}.
 *
 * Do not read the provenance above as a dependency: this module behaves identically whoever produced the IR.
 *
 * @module bundle/${capability.id}
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { invoke${capability.invocation.type === 'http' ? 'Http' : 'Command'}, type Backend } from './provider.ts'

/** The tool name the model calls. */
export const TOOL_NAME = ${JSON.stringify(capability.id.replaceAll('-', '_'))}

/**
 * Register it.
 * @param ctx - the plugin context; the registration is owned by this fiber and disposed with it.
 * @param backend - the resolved backend.
 */
export function apply${pascal}Tool(ctx: Context, backend: Backend): void {
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: ${JSON.stringify(capability.description)},
    parameters: ${parameters},
    output: {
      schema: ${outputNodeText},
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ value }),
    },
    async execute(args, exec) {
${bound}
      return invoke${capability.invocation.type === 'http' ? 'Http' : 'Command'}(backend, bound, {
        signal: exec.signal,
        timeoutMs: 30_000,
      })
    },
    presentCall(args) {
      return { card: 'generic', kind: 'execute', title: TOOL_NAME, rawInput: args }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = result.meta as { value?: unknown } | undefined
      if (meta === undefined || meta.value === undefined) return undefined
      const text = typeof meta.value === 'string' ? meta.value : JSON.stringify(meta.value)
      return { card: 'generic', title: TOOL_NAME, content: [{ type: 'text', text }] }
    },
  }))
}
`
}

/**
 * Render the single egress module.
 *
 * Whatever the invocations are, exactly one function reaches outside the process per transport — and the
 * generated bundle is then held to the same rule this project holds itself to.
 *
 * @param set - the capability set.
 * @returns the provider source.
 */
function providerModule(set: CapabilitySet): string {
  const types = new Set(set.capabilities.map((c) => c.invocation.type))
  const needsHttp = types.has('http')
  const needsExec = types.has('exec')

  const parts: string[] = [`/**
 * The backend adapter: the ONLY module in this bundle that reaches outside the process.
 *
 * Generated from ${set.capabilities.length} capabilities of ${JSON.stringify(set.target.name)}.
 *
 * @module bundle/provider
 */
`]

  // Emitted only when something actually spawns. An http-only bundle that imported `node:child_process`
  // would ship a capability nothing asked for, and the test asserting that only `provider.ts` reaches
  // outside the process would have to special-case its own generator.
  if (needsExec) {
    parts.push(`import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
`)
  }

  parts.push(`
/** The resolved backend. ${needsExec ? `\`target\` is the executable the capabilities drive.` : 'Unused by this set of capabilities, which reach the network instead.'} */
export interface Backend {
  /** ${needsExec ? 'Absolute path or PATH name of the target executable.' : 'Base URL, when the set contains HTTP capabilities.'} */
  readonly target: string
}

/**
 * Resolve the backend.
 * @param target - the configured target, or the empty string to use the default.
 * @returns the handle the invocations use.
 */
export function resolveBackend(target: string): Backend {
  return { target: target === '' ? ${JSON.stringify(
    set.capabilities.find((c) => c.invocation.type === 'exec')?.invocation.command
    ?? [...set.capabilities].map((c) => c.invocation.transport).find((t) => t !== undefined)
    ?? '',
  )} : target }
}
`)

  if (needsExec) {
    parts.push(`
/**
 * Run the target with the given arguments.
 * @param backend - the resolved backend.
 * @param args - argv, already bound from the capability's declared inputs.
 * @param options - the caller's cancellation and budget.
 * @param options.signal - honored on every call.
 * @param options.timeoutMs - cooperative timeout.
 * @returns the process's stdout, as the canonical value.
 * @throws Error when the target exits non-zero or cannot be started.
 */
export async function invokeCommand(
  backend: Backend,
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<string> {
  const { stdout } = await run(backend.target, [...args], {
    signal: options.signal,
    timeout: options.timeoutMs,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}
`)
  }

  if (needsHttp) {
    parts.push(`
/**
 * Fetch from the backend with the bound path segments.
 * @param backend - the resolved backend; \`target\` is the base URL.
 * @param args - path segments, already bound from the capability's declared inputs.
 * @param options - the caller's cancellation and budget.
 * @param options.signal - honored on every call.
 * @param options.timeoutMs - cooperative timeout.
 * @returns the response body, as the canonical value.
 * @throws Error when the response is not ok.
 */
export async function invokeHttp(
  backend: Backend,
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<string> {
  const url = new URL(args.map(encodeURIComponent).join('/'), backend.target).toString()
  const response = await fetch(url, { signal: options.signal })
  if (!response.ok) throw new Error(\`\${response.status} \${response.statusText} for \${url}\`)
  return await response.text()
}
`)
  }

  return parts.join('\n')
}

/**
 * Render the plugin entry.
 * @param set - the capability set.
 * @returns the entry source.
 */
function entryModule(set: CapabilitySet): string {
  const imports = set.capabilities
    .map((c) => {
      const pascal = c.id.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
      return `import { apply${pascal}Tool } from './${c.id}.ts'`
    })
    .join('\n')
  const calls = set.capabilities
    .map((c) => {
      const pascal = c.id.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
      return `  apply${pascal}Tool(ctx, backend)`
    })
    .join('\n')

  return `/**
 * ${set.target.name} — ${set.target.description}
 *
 * A function plugin: named exports, no default export.
 *
 * @module bundle
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveBackend } from './provider.ts'
${imports}

/** Cordis plugin name used by loader diagnostics. */
export const name = ${JSON.stringify(set.target.name.replaceAll('.', '-').toLowerCase())}

/** Services required by this plugin. */
export const inject = ['tools']

/** Plugin config. Every field has a default. */
export interface Config {
  /**
   * The target to drive. Empty means the value the Capability IR declared${
    set.capabilities.find((c) => c.invocation.type === 'exec')?.invocation.command === undefined
      ? ''
      : ` (${set.capabilities.find((c) => c.invocation.type === 'exec')?.invocation.command})`}.
   */
  target?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  target: z.string().default(''),
})

/**
 * Register every compiled capability.
 * @param ctx - the calling plugin's context; registrations are owned by this fiber.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const backend = resolveBackend(config.target ?? '')
${calls}
}
`
}

/**
 * Render the skill that teaches the model when to reach for this bundle.
 * @param set - the capability set.
 * @returns the skill document.
 */
function skillDocument(set: CapabilitySet): string {
  const rows = set.capabilities
    .map((c) => `| \`${c.id.replaceAll('-', '_')}\` | ${c.description} |`)
    .join('\n')
  const prerequisites = set.capabilities
    .flatMap((c) => c.environment.map((e) => ({ ...e, capability: c.id })))
    .map((e) => `- \`${e.name}\`${e.required ? ' (required)' : ' (optional)'}${e.secret ? ' — a secret' : ''}: ${e.description}`)
  return `---
name: dsh-plugin-${set.target.name.replaceAll('.', '-').toLowerCase()}
description: Drive ${set.target.name}: ${set.target.description}
---

# ${set.target.name}

${set.target.description}

## Prerequisites

${prerequisites.length > 0 ? prerequisites.join('\n') : `- \`${set.target.name}\` available where this runs.`}
${set.capabilities.some((c) => c.invocation.type === 'http') ? '- Network access to the target.' : ''}

## Tools

| Tool | Use it for |
|---|---|
${rows}

## Notes

- Every tool drives the real target. This bundle never reimplements it.
`
}

/**
 * Render the README.
 * @param set - the capability set.
 * @returns the README.
 */
function readme(set: CapabilitySet): string {
  const rows = set.capabilities
    .map((c) => `| \`${c.id.replaceAll('-', '_')}\` | ${c.description} |`)
    .join('\n')
  const permissions = set.capabilities
    .map((c) => `| ${c.id} | ${c.permissions.process ? 'process' : '—'} | ${c.permissions.filesystem.length || '—'} | ${c.permissions.network.length || '—'} |`)
    .join('\n')
  return `# dsh-plugin-${set.target.name.replaceAll('.', '-').toLowerCase()}

${set.target.description}

Compiled from Capability IR v${set.irVersion}. Provenance: ${set.target.source.kind} at ${set.target.source.location}.

## Tools

| Tool | Use it for |
|---|---|
${rows}

## What it touches

| Capability | process | filesystem paths | network hosts |
|---|---|---|---|
${permissions}

## Install

\`\`\`sh
dsh plugin --profile <profile> add .
dsh --profile <profile> --dump-config | grep -A2 '${set.target.name}'
\`\`\`

## Verify

\`\`\`sh
node scripts/verify-plugin.mjs .
\`\`\`
`
}

/**
 * Compile a capability set into a bundle's source.
 *
 * Pure: it returns a file plan, and `backend.writeBundle` executes it. That split is what lets the compiler
 * be tested without a filesystem, and it is the same split the scaffolder uses.
 *
 * @param set - the capability set. Validate it with `ir.parse` first.
 * @returns the files to write, and what could not be decided.
 * @throws Error when the set contains something the DSH backend cannot express.
 */
export function compileCapabilitySet(set: CapabilitySet): CompileResult {
  const warnings: string[] = []

  // An MCP capability cannot be expressed as a plugin tool here, and it should never have reached the
  // backend: MCP is a terminal path. Refusing is the honest response — compiling it would produce a plugin
  // that duplicates the bridge dsh already has.
  const mcp = set.capabilities.filter((c) => c.invocation.type === 'mcp')
  if (mcp.length > 0) {
    throw new Error(
      `the set contains MCP capabilities (${mcp.map((c) => c.id).join(', ')}), which the DSH backend does not `
      + 'compile. An MCP server is a terminal path: mount it with a dsh-mcp-client row instead of generating a '
      + 'plugin that duplicates the bridge.',
    )
  }

  for (const capability of set.capabilities) {
    const { invocation, permissions, outputs } = capability
    if (invocation.type === 'exec' && (invocation.command ?? '') === '') {
      warnings.push(WARN(capability.id, 'an exec invocation without a command cannot be bound at runtime'))
    }
    if (invocation.type === 'exec' && invocation.command !== undefined
      && (invocation.command.includes('/') || invocation.command.includes('\\'))
      && permissions.filesystem.length === 0) {
      // A resolved path and *no* filesystem permission declared at all: one of the two is wrong, and the IR
      // cannot say which. Silent would mean a plugin that touches disk while claiming it does not. The check
      // is for an empty list, not for a list without a glob — a specific declared path is a declaration.
      warnings.push(WARN(capability.id, `invokes ${invocation.command} but declares no filesystem permission`))
    }
    if (invocation.type === 'http' && permissions.network.length === 0) {
      warnings.push(WARN(capability.id, 'uses http but declares no network host'))
    }
    if (invocation.type === 'http' && (invocation.transport ?? '') === '') {
      warnings.push(WARN(capability.id, 'an http invocation without a transport has no base URL'))
    }
    for (const output of outputs) {
      if (output.type === 'object') {
        // The IR says "an object" and nothing more, so the compiled tool returns JSON. Callers that need
        // fields must say so in the IR — this is the compiler declining to invent a schema.
        warnings.push(WARN(capability.id, `output "${output.name}" is an untyped object; the tool will return raw JSON`))
      }
    }
    if (capability.permissions.secrets.length > 0) {
      warnings.push(WARN(capability.id, `consumes secrets (${capability.permissions.secrets.join(', ')}); they are not wired into the generated Config`))
    }
  }

  const targetSlug = set.target.name.replaceAll('.', '-').toLowerCase()
  const files: PlannedFile[] = [
    { path: 'src/provider.ts', contents: providerModule(set) },
    { path: 'src/index.ts', contents: entryModule(set) },
    ...set.capabilities.map((c) => ({ path: `src/${c.id}.ts`, contents: toolModule(c) })),
    { path: `skills/dsh-plugin-${targetSlug}/SKILL.md`, contents: skillDocument(set) },
    { path: 'README.md', contents: readme(set) },
  ]

  // The templates the backend does not generate from the IR: the manifest, the patch, the build config.
  // They are rendered by the scaffolder, and this returns the same shape so both write one plan.
  return { files, warnings }
}

/**
 * Render the manifest, patch, and build config for a compiled bundle.
 *
 * Kept separate from {@link compileCapabilitySet} because these come from the kit's templates rather than
 * from the IR — they describe the *packaging*, not the capabilities. A caller writes both plans together.
 *
 * @param set - the capability set.
 * @param templates - the kit's template texts.
 * @param values - the placeholder values, as the scaffolder derives them.
 * @returns the packaging files.
 */
export function compilePackaging(
  set: CapabilitySet,
  templates: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string>>,
): PlannedFile[] {
  const targetSlug = set.target.name.replaceAll('.', '-').toLowerCase()
  const render = (name: string): string => {
    const template = templates[name]
    if (template === undefined) throw new Error(`missing template: ${name}`)
    return substitute(template, { ...values, TARGET: targetSlug })
  }
  return [
    { path: 'package.json', contents: render('package.json.template') },
    { path: 'cordis.patch.yml', contents: render('cordis.patch.yml.template') },
    { path: 'tsconfig.json', contents: render('tsconfig.json.template') },
    { path: 'tsdown.config.ts', contents: render('tsdown.config.ts.template') },
  ]
}

/** Whether a capability's invocation reaches the network, for a caller reasoning about the risk surface. */
export function isNetworkInvocation(invocation: Invocation): boolean {
  return invocation.type === 'http'
}
