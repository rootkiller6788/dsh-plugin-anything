/**
 * The `plugin_anything_*` tool definitions.
 *
 * Each tool follows the contract in `guides/tool-contract.md`: a purpose-built parameter DSL, an `execute`
 * that returns the canonical value its `output.schema` declares, pure presenters, and `exec.signal` honored
 * on every call.
 *
 * @module dsh-plugin-anything-bundle/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fromPackageRoot, isFile, makeRunner, readSessionLog, readText, runCommand, writeBundle } from './backend.ts'
import { decide, judgeBoot, judgeFromLog, judgeReplay, loggedCalls, parseSessionLog, type AcceptanceStage, type ReplayableDefinition } from './accept.ts'
import { acceptMeta, filesMeta, inspectMeta, outputMeta, passedMeta, probeMeta } from './meta.ts'
import { DEFAULT_LIMITS, inspectCli, renderInspection } from './inspect.ts'
import { probeTarget, resolveOnPath } from './probe.ts'
import { compileCapabilitySet, compilePackaging } from './compile.ts'
import { parse as parseCapabilitySet } from './ir.ts'
import { judgePackage, judgeSupplyChain, parsePackList } from './pack.ts'
import { DEFAULT_DSH_RANGE, deriveValues, renderBundle, type BundleSpec, type ToolSpec } from './scaffold.ts'

/** What `apply` resolved once, shared by every tool. */
export interface ToolOptions {
  /** Path to the kit's static gate, as configured. Empty means "try the sibling default". */
  readonly verifierPath: string
  /** Where the kit's gate lives when this bundle sits beside it. */
  readonly defaultVerifierPath: string
  /** Root under which new bundles are written. */
  readonly outputDir: string
  /** The profile `dsh plugin` runs against. */
  readonly profile: string
  /** Cooperative timeout budget for one backend call. */
  readonly timeoutMs: number
}

/** The kit's template filenames, and the relative path each lives at. */
const TEMPLATE_FILES: Readonly<Record<string, string>> = {
  'package.json.template': 'templates/package.json.template',
  'cordis.patch.yml.template': 'templates/cordis.patch.yml.template',
  'index.ts.template': 'templates/index.ts.template',
  'provider.ts.template': 'templates/provider.ts.template',
  'tool.ts.template': 'templates/tool.ts.template',
  'tsconfig.json.template': 'templates/tsconfig.json.template',
  'tsdown.config.ts.template': 'templates/tsdown.config.ts.template',
}

/**
 * Load every template the renderer needs.
 * @param kitRoot - the kit package directory.
 * @returns template filename to text.
 * @throws Error when the kit or one of its templates is missing.
 */
export async function loadTemplates(kitRoot: string): Promise<Record<string, string>> {
  const loaded: Record<string, string> = {}
  for (const [name, relative] of Object.entries(TEMPLATE_FILES)) {
    loaded[name] = await readText(`${kitRoot}/${relative}`)
  }
  return loaded
}

/**
 * Load a bundle's tool definitions by importing its built entry.
 *
 * The replay stage needs the bundle's *own* presenters — replaying through anything else would test this
 * package instead of the artifact under acceptance.
 *
 * A throwaway context records whatever the bundle registers. It is a plain object rather than a real host
 * context because the definitions are wanted, not their behaviour; the acceptance run that matters is the
 * one `dsh` performs, which the boot stage covers.
 *
 * @param bundleRoot - the bundle directory.
 * @param main - the entry the manifest names, relative to the root.
 * @returns tool name to definition.
 */
export async function loadBundleDefinitions(bundleRoot: string, main: string): Promise<Map<string, unknown>> {
  const found = new Map<string, unknown>()
  const entry = resolve(bundleRoot, main)
  const mod = await import(pathToFileURL(entry).href) as { apply?: (ctx: unknown, config: unknown) => void; default?: unknown }
  const apply = mod.apply ?? (mod.default as { apply?: (ctx: unknown, config: unknown) => void } | undefined)?.apply
  if (typeof apply !== 'function') {
    throw new Error(`${entry} exports no apply(), so its tools cannot be read`)
  }
  const ctx = {
    tools: { register: (definition: { name: string }) => { found.set(definition.name, definition); return () => {} } },
    inject: () => undefined,
    effect: (fn: () => (() => void)) => fn(),
  }
  // A config of empty strings lets the bundle's own defaults apply without this module knowing its shape.
  apply(ctx, { target: '', verifierPath: '', outputDir: '', profile: '', timeoutMs: 30_000 })
  return found
}

/**
 * Register every `plugin_anything_*` tool.
 * @param ctx - the plugin context; registrations are owned by this fiber and disposed with it.
 * @param options - the resolved paths and budget.
 */
export function registerTools(ctx: Context, options: ToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'plugin_anything_probe',
    description:
      'Classify a target as a CLI binary, an HTTP API, or an MCP server, and gather the evidence that it is '
      + 'actually callable. Run this first: an MCP target should not get a plugin at all, and a target that '
      + 'cannot be invoked is not a target.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'A path to an executable or source tree, or an HTTP(S) URL.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['cli', 'http', 'mcp', 'unknown'], required: true },
          endpoint: { type: 'string', required: true },
          callable: { type: 'boolean', required: true },
          evidence: { type: 'array', items: { type: 'string' }, required: true },
          helpExcerpt: { type: 'string', required: true },
          recommendation: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          // Field names here match the output schema exactly. A real model turn caught the earlier
          // mismatch (`surface:` rendered while the field is `kind`) and had to reconcile it in prose.
          `kind: ${value.kind}`,
          `callable: ${value.callable}`,
          `endpoint: ${value.endpoint || '(none)'}`,
          '',
          'evidence:',
          ...value.evidence.map((line) => `  - ${line}`),
          '',
          value.recommendation,
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => ({ kind: value.kind, recommendation: value.recommendation }),
    },
    async execute(args, exec) {
      const probe = await probeTarget(args.target, {
        cwd: process.cwd(),
        signal: exec.signal,
        timeoutMs: options.timeoutMs,
      })
      const callable = probe.evidence.some((item) => item.supports)
      // The MCP branch is a stop condition in the SOP, not a weaker form of the same answer: an MCP target
      // already has a supported path into dsh, and a generated plugin would duplicate it.
      const recommendation = probe.kind === 'mcp'
        ? 'Do NOT generate a plugin. Mount the MCP server instead: add a dsh-mcp-client row to the '
          + "profile's cordis.patch.yml with this URL and a serverName. See guides/backend-mcp.md."
        : !callable
          ? 'The target could not be shown to be callable. Establish a working invocation before designing '
            + 'anything; an assumed surface is not an acquired one.'
          : `Proceed to Phase 1. Map ${probe.kind} capabilities to tools using the help excerpt as the raw material.`
      return {
        kind: probe.kind,
        endpoint: probe.endpoint,
        callable,
        evidence: probe.evidence.map((item) => `${item.supports ? '✓' : '✗'} ${item.observation}`),
        helpExcerpt: probe.helpExcerpt,
        recommendation,
      }
    },
    presentCall(args) {
      return { card: 'generic', kind: 'execute', title: `probe ${args.target}`, rawInput: { target: args.target } }
    },
    // `result` is a ToolResult, not the canonical value: the card reads the payload `presentationMeta`
    // projected, and declines to the generic fallback when it is absent or unrecognisable.
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = probeMeta(result.meta)
      if (meta === undefined) return undefined
      return {
        card: 'generic',
        title: `${meta.kind} target`,
        content: [{ type: 'text', text: meta.recommendation }],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_anything_inspect',
    description:
      'Gather what a target actually offers, as normalised evidence: its version, its subcommands with their '
      + 'verbatim help text, and its top-level flags. Run this after probe and before extracting capabilities. '
      + 'It collects facts and reports what it could not determine; it does NOT summarise or pick capabilities, '
      + 'because that judgement is yours and summarising it here would make the choice silently for you.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'An executable name or absolute path. A PATH name is resolved first.',
      },
      maxCommands: {
        type: 'integer',
        description: 'How many subcommands to inspect in depth. Defaults to 25; a large CLI is cut short and says so.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Per-command timeout in milliseconds. Defaults to 10000.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entrypoint: { type: 'string', required: true },
          version: { type: 'string', required: true },
          commandCount: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          unknowns: { type: 'array', items: { type: 'string' }, required: true },
          report: {
            type: 'string',
            required: true,
            description: 'The full evidence, including verbatim help text, for you to read.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
      presentationMeta: (_args, value) => ({
        entrypoint: value.entrypoint,
        commands: value.commandCount,
        truncated: value.truncated,
      }),
    },
    async execute(args, exec) {
      // Resolve a bare name through PATH first: inspecting `git` must work the same as inspecting its path.
      const timeoutMs = args.timeoutMs ?? DEFAULT_LIMITS.timeoutMs
      const runner = makeRunner(exec.signal, process.cwd())
      const resolved = await resolveOnPath(args.target, runner, timeoutMs)
      const entrypoint = resolved ?? args.target

      const evidence = await inspectCli(runner, entrypoint, {
        maxCommands: args.maxCommands ?? DEFAULT_LIMITS.maxCommands,
        timeoutMs,
      })
      return {
        entrypoint: evidence.entrypoint,
        version: evidence.version ?? '',
        commandCount: evidence.commands.length,
        truncated: evidence.truncated,
        unknowns: [...evidence.unknowns],
        report: renderInspection(evidence),
      }
    },
    presentCall(args) {
      return { card: 'generic', kind: 'read', title: `inspect ${args.target}` }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = inspectMeta(result.meta)
      if (meta === undefined) return undefined
      return {
        card: 'generic',
        title: `${meta.entrypoint} — ${meta.commands} subcommand${meta.commands === 1 ? '' : 's'}${meta.truncated ? ' (truncated)' : ''}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_anything_scaffold',
    description:
      'Write a new dsh plugin bundle skeleton from the kit templates. Produces package.json, the bundle '
      + 'patch, the plugin entry, the single-egress provider module, one module per tool, a SKILL.md, and '
      + 'the build config. Existing files are never overwritten.',
    parameters: {
      target: { type: 'string', required: true, description: 'Lowercase kebab-case slug, e.g. "git".' },
      description: { type: 'string', required: true, description: 'One line describing what the plugin does.' },
      executable: { type: 'string', required: true, description: "The target's executable name." },
      tools: {
        type: 'array',
        required: true,
        description: 'The tools to expose, each as {name, description, subcommand}.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            description: { type: 'string', required: true },
            subcommand: { type: 'string', required: true },
          },
        },
      },
      outputDir: { type: 'string', description: 'Parent directory for the new bundle. Defaults to config.' },
      dshRange: {
        type: 'string',
        description:
          `The @deepseek-ai/dsh-* version range to peer on. Defaults to "${DEFAULT_DSH_RANGE}". The range `
          + 'must carry the prerelease tag: dsh publishes no stable release, and a plain ^0.1.5 matches '
          + 'nothing. It is also line-specific, so a host on 0.1.6-alpha.1 needs its own range.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          written: { type: 'array', items: { type: 'string' }, required: true },
          skipped: { type: 'array', items: { type: 'string' }, required: true },
          nextStep: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `wrote ${value.written.length} file(s) under ${value.root}`,
          ...value.written.map((path) => `  + ${path}`),
          ...(value.skipped.length > 0
            ? ['', 'left untouched (already existed):', ...value.skipped.map((path) => `  = ${path}`)]
            : []),
          '',
          value.nextStep,
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => ({ root: value.root, written: value.written }),
    },
    async execute(args, exec) {
      // Read from THIS package's own `templates/`, not a sibling checkout.
      //
      // The first version resolved `${fromPackageRoot('..')}/kit/templates` — a
      // directory that exists only where the whole repository is checked out. It worked in the author's
      // tree and failed for every user who installed the bundle from a tarball, with `missing template`.
      // A shipped bundle has to carry what it renders from; `scripts/check-shipped-copies.mjs` keeps the
      // copies honest against the kit's originals.
      const templates = await loadTemplates(fromPackageRoot('templates'))
      const spec: BundleSpec = {
        target: args.target,
        description: args.description,
        executable: args.executable,
        dshRange: args.dshRange ?? DEFAULT_DSH_RANGE,
        tools: args.tools as ToolSpec[],
      }
      const parent = args.outputDir ?? options.outputDir
      const root = `${parent}/dsh-plugin-${args.target}`
      const files = renderBundle(spec, templates)
      void exec
      const outcome = await writeBundle(root, files)
      return {
        root,
        written: outcome.written,
        skipped: outcome.skipped,
        nextStep: `Read the written files and complete Phase 3: replace the TODO markers left by unresolved `
          + `template placeholders — the tool parameters and output schema in each src/<tool>.ts, and the `
          + `backend call in src/provider.ts. Then run plugin_anything_verify.`,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `scaffold dsh-plugin-${args.target}` }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = filesMeta(result.meta)
      if (meta === undefined) return undefined
      return {
        card: 'diff',
        title: `scaffold ${meta.root}`,
        // `oldText: null` for every path: the card is written at call time and on replay, and a presenter
        // has no prior file content. That is the documented reason the type allows null here.
        diffs: meta.written.map((path) => ({ path: `${meta.root}/${path}`, oldText: null, newText: 'created' })),
        locations: meta.written.map((path) => ({ path: `${meta.root}/${path}` })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_anything_compile',
    description:
      'Compile a Capability IR document into DSH plugin source. This is the backend: it reads capabilities, '
      + 'not sources, and produces the same code whoever generated the IR. Run it after you have written the '
      + 'IR (see sop/SOP.md) and after plugin_anything_scaffold, or instead of it. It reports what it declined '
      + 'to invent rather than guessing — read the warnings.',
    parameters: {
      ir: { type: 'string', required: true, description: 'Path to the Capability IR JSON document.' },
      outputDir: {
        type: 'string',
        required: true,
        description: 'Bundle root to write into. Existing files are never overwritten.',
      },
      packaging: {
        type: 'boolean',
        description: 'Also render the manifest, patch, and build config from the templates. Defaults to true.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          capabilities: { type: 'array', items: { type: 'string' }, required: true },
          written: { type: 'array', items: { type: 'string' }, required: true },
          skipped: { type: 'array', items: { type: 'string' }, required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `compiled ${value.capabilities.length} capabilit${value.capabilities.length === 1 ? 'y' : 'ies'} into ${value.root}`,
          ...value.written.map((path) => `  + ${path}`),
          ...(value.skipped.length > 0
            ? ['', 'left untouched (already existed):', ...value.skipped.map((path) => `  = ${path}`)]
            : []),
          ...(value.warnings.length > 0
            ? ['', 'the compiler declined to invent these — act on them:', ...value.warnings.map((w) => `  ! ${w}`)]
            : []),
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => ({ root: value.root, written: value.written }),
    },
    async execute(args, exec) {
      void exec
      const text = await readText(args.ir)
      // `parse` validates against the IR's invariants, so a malformed document fails here rather than
      // producing source with a hole in it.
      const set = parseCapabilitySet(text)

      const compiled = compileCapabilitySet(set)
      const files = [...compiled.files]

      if (args.packaging !== false) {
        const templates = await loadTemplates(fromPackageRoot('templates'))
        const executable = set.capabilities.find((c) => c.invocation.type === 'exec')?.invocation.command
        // The scaffolder's value derivation, fed from the IR rather than from a tool spec: the packaging
        // templates are about the bundle, not the capabilities.
        const values = deriveValues({
          target: set.target.name.replaceAll('.', '-').toLowerCase(),
          description: set.target.description,
          executable: executable ?? set.target.name,
          dshRange: DEFAULT_DSH_RANGE,
          tools: set.capabilities.map((c) => ({
            name: c.id.replaceAll('-', '_'),
            description: c.description,
            subcommand: '',
          })),
        })
        files.push(...compilePackaging(set, templates, values))
      }

      const outcome = await writeBundle(args.outputDir, files)
      return {
        root: args.outputDir,
        capabilities: set.capabilities.map((c) => c.id),
        written: outcome.written,
        skipped: outcome.skipped,
        warnings: [...compiled.warnings],
      }
    },
    presentCall(args) {
      return { card: 'generic', kind: 'edit', title: `compile ${args.ir}`, locations: [{ path: args.outputDir }] }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = filesMeta(result.meta)
      if (meta === undefined) return undefined
      return {
        card: 'diff',
        title: `compiled into ${meta.root}`,
        diffs: meta.written.map((path) => ({ path: `${meta.root}/${path}`, oldText: null, newText: 'created' })),
        locations: meta.written.map((path) => ({ path: `${meta.root}/${path}` })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_anything_verify',
    description:
      'Run the kit\'s static gate over a generated bundle. Catches the failures that are otherwise silent: a '
      + 'patch file the gate never discovers, a row that matches nothing, an entry the Loader discards, an '
      + 'impure presenter. A pass is not proof the plugin boots.',
    parameters: {
      path: { type: 'string', required: true, description: 'The bundle directory to verify.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          output: { type: 'string', required: true },
          caveat: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.ok ? 'PASS' : 'FAIL'}\n\n${value.output}\n\n${value.caveat}`,
      }],
      presentationMeta: (_args, value) => ({ ok: value.ok }),
    },
    async execute(args, exec) {
      // Prefer the configured path, then the sibling default. Report plainly which one ran: a verify tool
      // that silently checked nothing and said "pass" would be worse than one that fails.
      const configured = options.verifierPath
      const candidate = configured !== '' ? configured : options.defaultVerifierPath
      if (!(await isFile(candidate))) {
        return {
          ok: false,
          output: `the kit's verifier was not found at ${candidate}`,
          caveat: configured === ''
            ? 'Set the verifierPath config to the absolute path of '
              + 'kit/scripts/verify-plugin.mjs and retry.'
            : 'The configured verifierPath does not exist.',
        }
      }
      const outcome = await runCommand(process.execPath, [candidate, args.path], {
        cwd: process.cwd(),
        signal: exec.signal,
        timeoutMs: options.timeoutMs,
      })
      return {
        ok: outcome.ok,
        output: `ran ${candidate}\n\n${`${outcome.stdout}${outcome.stderr}`.trim() || '(no output)'}`,
        caveat: 'Static checks only. Composition and behavior still need '
          + 'plugin_anything_install, a live tool call, and a restart.',
      }
    },
    presentCall(args) {
      return { card: 'generic', kind: 'read', title: `verify ${args.path}`, locations: [{ path: args.path }] }
    },
    presentResult(_args, result) {
      // No `isError` guard here: a failed verification is a successful call that reported a failure, so
      // `isError` is false and the card must still say "failed".
      const meta = passedMeta(result.meta)
      if (meta === undefined) return undefined
      return { card: 'generic', title: meta.ok ? 'verification passed' : 'verification failed' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_anything_package',
    description:
      'Produce the distribution artifact for a bundle and check that it contains what the manifest promises. '
      + 'Producing a tarball is one command; what this adds is the comparison, because a `files` list that has '
      + 'drifted from what the code reads produces a package that works locally and fails for every user who '
      + 'installs it. Reports the artifact name and any promised entry that is absent.',
    parameters: {
      bundle: { type: 'string', required: true, description: 'The bundle root to package.' },
      dryRun: {
        type: 'boolean',
        description: 'Only list what would ship; do not write the tarball. Defaults to false.',
      },
      packCommand: {
        type: 'string',
        description: "The package manager to pack with. Defaults to 'npm'.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', enum: ['pass', 'fail'], required: true },
          filename: { type: 'string', required: true },
          fileCount: { type: 'integer', required: true },
          sizeBytes: { type: 'integer', required: true },
          missing: { type: 'array', items: { type: 'string' }, required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
      presentationMeta: (_args, value) => ({ root: value.filename, written: [value.filename] }),
    },
    async execute(args, exec) {
      const runner = makeRunner(exec.signal, args.bundle)
      const packer = args.packCommand ?? 'npm'
      const listed = await runner.run(packer, ['pack', '--dry-run', '--json'], options.timeoutMs)
      if (!listed.ok) {
        throw new Error(`${packer} pack --dry-run --json exited ${listed.exitCode}: ${listed.stderr.slice(0, 300)}`)
      }
      const listing = parsePackList(listed.stdout)
      const manifest = JSON.parse(await readText(`${args.bundle}/package.json`)) as { files?: string[] }
      const verdict = judgePackage(manifest.files, listing.files)
      // The supply-chain pass is folded in rather than offered as a step. It exists to catch the case where
      // nobody looked, and a check nobody is asked to run is the same as no check.
      const chain = judgeSupplyChain(manifest as { scripts?: Record<string, string>; private?: boolean; dependencies?: Record<string, string> })

      let created = ''
      if (args.dryRun !== true && verdict.verdict === 'pass' && chain.blockers.length === 0) {
        // Pack only after the listing checks out. A tarball that is missing something promised should not be
        // written at all: an artifact on disk is one somebody will ship.
        const packed = await runner.run(packer, ['pack'], options.timeoutMs)
        if (!packed.ok) {
          throw new Error(`${packer} pack exited ${packed.exitCode}: ${packed.stderr.slice(0, 300)}`)
        }
        created = packed.stdout.trim().split('\n').filter((line) => line !== '').at(-1) ?? ''
      }

      const report = [
        `verdict: ${verdict.verdict.toUpperCase()}`,
        verdict.detail,
        '',
        `artifact : ${created === '' ? listing.filename : created}${args.dryRun === true ? ' (dry run — not written)' : ''}`,
        `files    : ${listing.files.length}`,
        `size     : ${(listing.size / 1024).toFixed(1)} KiB`,
        ...(chain.blockers.length > 0
          ? ['', 'supply chain — these stop a release:', ...chain.blockers.map((b) => `  ✖ ${b}`)]
          : []),
        ...(chain.notes.length > 0
          ? ['', 'supply chain — know before shipping:', ...chain.notes.map((n) => `  ! ${n}`)]
          : []),
        ...(verdict.unexpected.length > 0
          ? ['', 'present but not covered by files[] — check these are intended:', ...verdict.unexpected.map((p) => `  ? ${p}`)]
          : []),
      ].join('\n')

      return {
        verdict: chain.blockers.length > 0 ? 'fail' : verdict.verdict,
        filename: created === '' ? listing.filename : created,
        fileCount: listing.files.length,
        sizeBytes: listing.size,
        missing: [...verdict.missing],
        report,
      }
    },
    presentCall(args) {
      return { card: 'generic', kind: 'execute', title: `package ${args.bundle}` }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = filesMeta(result.meta)
      if (meta === undefined) return undefined
      return { card: 'generic', title: meta.root === '' ? 'package' : `packaged ${meta.root}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_anything_accept',
    description:
      'Run the acceptance tail over a bundle and return ONE verdict: build, compose, boot, discover, invoke, '
      + 'present, replay. Each stage catches what the previous one cannot — a bundle can build, dump a clean '
      + 'config, and still fail to boot; a plugin can load and the model never see it. A stage that could not '
      + 'run yields "incomplete", never a pass: an acceptance that could have come from a run where nothing '
      + 'happened is worse than none.',
    parameters: {
      bundle: { type: 'string', required: true, description: 'The bundle root to accept.' },
      profile: { type: 'string', required: true, description: 'The isolated profile to install into.' },
      tool: {
        type: 'string',
        description: 'The tool the model should see and call. Defaults to the first tool the bundle registers.',
      },
      sessionLog: {
        type: 'string',
        description: 'Path to a session log to judge discover/invoke/present from. Without it those three are skipped, not passed.',
      },
      dshCommand: {
        type: 'string',
        description: "How to invoke dsh. Defaults to 'dsh'. Point it at a local source checkout to accept against that build.",
      },
      skipBuild: { type: 'boolean', description: 'Skip the build stage. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', enum: ['accepted', 'rejected', 'incomplete'], required: true },
          reason: { type: 'string', required: true },
          stages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                stage: { type: 'string', required: true },
                verdict: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
      presentationMeta: (_args, value) => ({ verdict: value.verdict, stages: value.stages.map((s) => `${s.stage}:${s.verdict}`) }),
    },
    async execute(args, exec) {
      const runner = makeRunner(exec.signal, args.bundle)
      const dsh = args.dshCommand ?? 'dsh'
      const stages: AcceptanceStage[] = []

      const pkg = JSON.parse(await readText(`${args.bundle}/package.json`)) as { name: string; main: string; dsh?: { bundle?: { patch?: string } } }
      const packageName = pkg.name

      // ── build ────────────────────────────────────────────────────────────────────────────────────
      if (args.skipBuild === true) {
        stages.push({ stage: 'build', verdict: 'skip', detail: 'skipped by request' })
      } else {
        const built = await runner.run('npx', ['tsdown'], options.timeoutMs)
        if (!built.ok) {
          stages.push({ stage: 'build', verdict: 'fail', detail: `tsdown exited ${built.exitCode}: ${built.stderr.slice(0, 300)}` })
        } else if (!(await isFile(resolve(args.bundle, pkg.main)))) {
          // The failure nobody sees: a build that reports success and produces an artifact the manifest
          // does not name.
          stages.push({ stage: 'build', verdict: 'fail', detail: `the build succeeded but did not produce ${pkg.main}, which the manifest names` })
        } else {
          stages.push({ stage: 'build', verdict: 'pass', detail: `tsdown produced ${pkg.main}` })
        }
      }

      // ── compose ──────────────────────────────────────────────────────────────────────────────────
      const added = await runner.run(dsh, ['plugin', '--profile', args.profile, 'add', args.bundle], options.timeoutMs)
      if (!added.ok) {
        stages.push({ stage: 'compose', verdict: 'fail', detail: `install failed: ${`${added.stdout}${added.stderr}`.slice(0, 300)}` })
      } else {
        const dump = await runner.run(dsh, ['--profile', args.profile, '--dump-config'], options.timeoutMs)
        const text = `${dump.stdout}${dump.stderr}`
        if (!text.includes(packageName)) {
          stages.push({ stage: 'compose', verdict: 'fail', detail: `${packageName} is absent from --dump-config` })
        } else if (pkg.dsh?.bundle?.patch === undefined) {
          stages.push({ stage: 'compose', verdict: 'fail', detail: 'the manifest declares no dsh.bundle.patch, so no layer is activated' })
        } else {
          stages.push({ stage: 'compose', verdict: 'pass', detail: `${packageName} reaches the composed tree` })
        }
      }

      // ── boot ─────────────────────────────────────────────────────────────────────────────────────
      const boot = await runner.run(dsh, ['--profile', args.profile, 'hi'], options.timeoutMs)
      stages.push(judgeBoot(`${boot.stdout}${boot.stderr}`, packageName))

      // ── discover / invoke / present ──────────────────────────────────────────────────────────────
      // Read from a session log when one is given. A keyless acceptance cannot observe the model, and
      // reporting these three as passes without evidence is exactly the failure `decide` refuses.
      if (args.sessionLog === undefined) {
        for (const stage of ['discover', 'invoke', 'present']) {
          stages.push({ stage, verdict: 'skip', detail: 'no session log was supplied, so the model was not observed' })
        }
      } else {
        const logged = parseSessionLog(await readSessionLog(args.sessionLog))
        const calls = loggedCalls(logged)
        // The tool under acceptance: named, or the first the bundle registers.
        const definitions = await loadBundleDefinitions(args.bundle, pkg.main)
        const toolName = args.tool ?? (definitions.keys().next().value as string | undefined)
        if (toolName === undefined) {
          for (const stage of ['discover', 'invoke', 'present']) {
            stages.push({ stage, verdict: 'skip', detail: 'the bundle registers no tool to look for' })
          }
        } else {
          stages.push(...judgeFromLog(calls, toolName))
          // ── replay ────────────────────────────────────────────────────────────────────────────
          const call = calls.filter((c) => c.name === toolName).at(-1)
          const definition = definitions.get(toolName)
          if (call === undefined || definition === undefined) {
            stages.push({ stage: 'replay', verdict: 'skip', detail: 'no logged call to replay' })
          } else {
            stages.push(judgeReplay(definition as ReplayableDefinition, call))
          }
        }
      }

      const acceptance = decide(stages)
      const report = [
        `verdict: ${acceptance.verdict.toUpperCase()}`,
        acceptance.reason,
        '',
        ...stages.map((stage) => `  ${stage.verdict === 'pass' ? '✔' : stage.verdict === 'fail' ? '✖' : '•'} ${stage.stage.padEnd(9)} ${stage.detail}`),
      ].join('\n')

      return {
        verdict: acceptance.verdict,
        reason: acceptance.reason,
        stages: stages.map((stage) => ({ stage: stage.stage, verdict: stage.verdict, detail: stage.detail })),
        report,
      }
    },
    presentCall(args) {
      return { card: 'generic', kind: 'execute', title: `accept ${args.bundle}` }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = acceptMeta(result.meta)
      if (meta === undefined) return undefined
      const failed = meta.stages.filter((s) => s.endsWith(':fail')).length
      const skipped = meta.stages.filter((s) => s.endsWith(':skip')).length
      return {
        card: 'generic',
        title: `${meta.verdict}${failed > 0 ? ` (${failed} failed)` : ''}${skipped > 0 ? ` (${skipped} not run)` : ''}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_anything_install',
    description:
      'Install a bundle into a dsh profile and prove the layer composed. Runs `dsh plugin add`, then dumps the '
      + 'profile config and checks that the plugin row is present — a patch row whose id is misspelled '
      + 'produces only a warning, so the dump must be inspected rather than trusted.',
    parameters: {
      spec: {
        type: 'string',
        required: true,
        description: 'What to install: a package name, a path, github:owner/repo#sha, or a .tgz path.',
      },
      profile: { type: 'string', description: 'Profile name. Defaults to config.' },
      rowId: { type: 'string', description: 'The patch row id to confirm in the composed tree.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installed: { type: 'boolean', required: true },
          composed: { type: 'boolean', required: true },
          profile: { type: 'string', required: true },
          output: { type: 'string', required: true },
          caveat: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `profile: ${value.profile}`,
          `installed: ${value.installed}`,
          `row present in composed config: ${value.composed}`,
          '',
          value.output,
          '',
          value.caveat,
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => ({ output: value.output }),
    },
    async execute(args, exec) {
      const profile = args.profile ?? options.profile
      const add = await runCommand('dsh', ['plugin', '--profile', profile, 'add', args.spec], {
        cwd: process.cwd(),
        signal: exec.signal,
        timeoutMs: options.timeoutMs,
      })
      if (!add.ok) {
        return {
          installed: false,
          composed: false,
          profile,
          output: `${add.stdout}${add.stderr}`.trim(),
          caveat: 'The install failed. If the spec was a git URL, pnpm refuses to run a git dependency\'s '
            + 'prepare script until the package is listed under allowBuilds in the profile\'s '
            + 'pnpm-workspace.yaml — that allowance executes the package\'s code at install time, outside any '
            + 'sandbox. Prefer an npm or tarball install instead.',
        }
      }
      const dump = await runCommand('dsh', ['--profile', profile, '--dump-config'], {
        cwd: process.cwd(),
        signal: exec.signal,
        timeoutMs: options.timeoutMs,
      })
      const composed = args.rowId === undefined
        ? dump.stdout.includes(args.spec)
        : dump.stdout.includes(args.rowId)
      return {
        installed: true,
        composed,
        profile,
        output: `${add.stdout}${add.stderr}`.trim(),
        caveat: composed
          ? 'Composed. Now boot the profile, call a tool, and RESTART — surviving the restart is the property '
            + 'a dynamic cordis package cannot have.'
          : `Installed, but the row was not found in --dump-config. A patch that matches no row is only a `
            + `stderr warning, so this is the failure mode that looks like success. Check the patch's row ids `
            + `against the dump.`,
      }
    },
    presentCall(args) {
      return { card: 'terminal', title: `dsh plugin --profile ${args.profile ?? options.profile} add ${args.spec}` }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = outputMeta(result.meta)
      if (meta === undefined) return undefined
      return { card: 'terminal', title: 'dsh plugin', output: meta.output }
    },
  }))
}
