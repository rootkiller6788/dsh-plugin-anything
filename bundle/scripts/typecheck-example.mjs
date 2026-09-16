#!/usr/bin/env node
/**
 * Typecheck a freshly rendered bundle against the real `@deepseek-ai/dsh-tools` types.
 *
 * This is the gate that automates the check which found ~28 real errors in this kit's templates: the
 * generated code looked right, passed the static format gate, and did not compile. Specifically,
 * `presentResult(args, result)` was written as if `result` were the tool's canonical value, when it is a
 * `ToolResult` (`{ content, isError, meta? }`) — a mistake with no runtime symptom until a card misbehaves.
 *
 * The rendered bundle is materialized under `bundle/` so Node's ordinary parent walk finds
 * `bundle/node_modules` and the `@deepseek-ai/*` types resolve without any `paths` configuration standing
 * between the check and reality.
 *
 * Usage: node scripts/typecheck-example.mjs
 * Exit codes: 0 clean · 1 type errors · 2 could not run
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { renderBundle } from '../src/scaffold.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')
const KIT = resolve(BUNDLE, '..', 'kit')

/**
 * The spec the committed example is generated from, identical to `scripts/render-example.mjs`.
 * Kept in sync by `tests/pipeline.test.mjs`, which asserts the committed example still matches.
 */
const SPEC = {
  target: 'git',
  description: 'Inspect a git repository: status, history, and diffs.',
  executable: 'git',
  dshRange: '^0.1.5-rc.2',
  tools: [
    { name: 'git_status', description: 'Show the working tree status of a repository.', subcommand: 'status' },
    { name: 'git_log', description: 'List recent commits from a repository.', subcommand: 'log' },
    { name: 'git_diff', description: 'Show the diff for a repository.', subcommand: 'diff' },
  ],
}

if (!existsSync(join(BUNDLE, 'node_modules', '@deepseek-ai'))) {
  process.stderr.write(
    `cannot typecheck: ${join(BUNDLE, 'node_modules')} has no @deepseek-ai packages.\n`
    + `Run \`pnpm install\` in ${BUNDLE} first.\n`,
  )
  process.exit(2)
}

const TEMPLATES = [
  'package.json.template',
  'cordis.patch.yml.template',
  'index.ts.template',
  'provider.ts.template',
  'tool.ts.template',
  'tsconfig.json.template',
  'tsdown.config.ts.template',
]

const { readFileSync } = await import('node:fs')
const templates = {}
for (const name of TEMPLATES) templates[name] = readFileSync(join(KIT, 'templates', name), 'utf8')

// Materialize under the package root so `node_modules` resolution needs no configuration.
const root = mkdtempSync(join(BUNDLE, '.typecheck-'))

/**
 * Set the process exit code without exiting yet.
 *
 * `process.exit()` does not run `finally` blocks, so exiting from inside the `try` would leak the temp
 * directory on every failure. The first version of this script did exactly that.
 * @param {number} code - the exit code to finish with.
 */
let exitCode = 0
const fail = (code) => { exitCode = code }

/**
 * A Capability IR fixture, written the way a frontend would emit one.
 *
 * It carries one capability per transport on purpose: the compiler emits a different egress for each, and a
 * fixture covering only `exec` would leave `invokeHttp` and everything that imports it unverified.
 *
 * It is also clean — no warnings — so that "the compiler produced warnings" is itself a failure here rather
 * than something to filter out. A fixture that legitimately warns would hide a regression that introduced a
 * new one.
 */
const PROBE_IR = {
  irVersion: 1,
  target: {
    name: 'probe-fixture',
    description: 'A fixture target used to check that compiled output typechecks.',
    source: { kind: 'cli', location: '/usr/bin/probe-fixture' },
  },
  capabilities: [
    {
      id: 'list-items',
      name: 'List items',
      description: 'List the items in the fixture.',
      source: { kind: 'cli', location: '/usr/bin/probe-fixture', version: '1.0.0' },
      invocation: { type: 'exec', command: '/usr/bin/probe-fixture', args: ['list', '--limit', '{{limit}}'] },
      inputs: [
        { name: 'limit', description: 'How many items to list.', type: 'integer', required: true },
        { name: 'format', description: 'Output format.', type: 'string', required: false, enum: ['text', 'json'] },
      ],
      outputs: [{ name: 'stdout', description: 'One item per line.', type: 'string' }],
      dependencies: [],
      environment: [],
      permissions: { filesystem: ['/usr/bin/probe-fixture'], network: [], process: true, secrets: [] },
      evidence: [{ stage: 'inspect', observed: 'ran the fixture and read its output' }],
      confidence: 'observed',
      lifecycle: {},
    },
    {
      id: 'fetch-item',
      name: 'Fetch item',
      description: 'Fetch one item over HTTP.',
      source: { kind: 'http', location: 'https://fixture.test' },
      invocation: { type: 'http', transport: 'https://fixture.test/api' },
      inputs: [{ name: 'id', description: 'The item id.', type: 'string', required: true }],
      outputs: [{ name: 'body', description: 'The response body.', type: 'string' }],
      dependencies: [],
      environment: [],
      permissions: { filesystem: [], network: ['fixture.test'], process: false, secrets: [] },
      evidence: [{ stage: 'inspect', observed: 'GET /api returned the item' }],
      confidence: 'observed',
      lifecycle: {},
    },
    {
      // A capability with NO inputs, which is the shape that broke the compiler once: the generated body was
      // `[].filter((entry): entry is string => …)`, and a type predicate cannot narrow `never` to `string`
      // (`TS2677`). Every fixture before this one had at least one input, so the shape was never generated
      // and the defect reached a golden-E2E run instead of this gate.
      //
      // It lives here rather than in a unit assertion because the assertion that matters is "it compiles",
      // and this is the gate that asks.
      id: 'version',
      name: 'Version',
      description: 'Report the fixture target\'s version.',
      source: { kind: 'cli', location: '/usr/bin/probe-fixture', version: '1.0.0' },
      invocation: { type: 'exec', command: '/usr/bin/probe-fixture', args: ['--version'] },
      inputs: [],
      outputs: [{ name: 'stdout', description: 'The version string.', type: 'string' }],
      dependencies: [],
      environment: [],
      permissions: { filesystem: ['/usr/bin/probe-fixture'], network: [], process: true, secrets: [] },
      evidence: [{ stage: 'inspect', observed: '`probe-fixture --version` printed a version with no arguments' }],
      confidence: 'observed',
      lifecycle: {},
    },
  ],
}

/**
 * Materialize a file plan and typecheck it.
 * @param {string} root - where to write.
 * @param {{path: string, contents: string}[]} files - the plan.
 * @param {string} label - what produced it, for the report.
 * @returns {number} 0 when it compiles, 1 when it does not.
 */
function typecheck(root, files, label) {
  for (const file of files) {
    const destination = join(root, file.path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, file.contents, 'utf8')
  }
  const result = spawnSync(
    process.execPath,
    [join(BUNDLE, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', join(root, 'tsconfig.json')],
    { encoding: 'utf8' },
  )
  const output = `${result.stdout}${result.stderr}`.trim()
  if (output !== '') process.stdout.write(`${output}\n`)
  if (result.status !== 0) {
    process.stderr.write(`\n✗ ${label} does not compile against the real dsh types.\n`)
    return 1
  }
  process.stdout.write(`✓ ${label} compiles against the real dsh types.\n`)
  return 0
}

try {
  // Two things produce plugin source, and both must compile: the scaffolder, which renders templates, and
  // the compiler, which reads a Capability IR. Checking only the first would leave the backend unverified —
  // and the backend is the one whose output nobody hand-edits.
  const fromTemplates = [
    ...renderBundle(SPEC, templates),
    ...[
      { path: 'tsconfig.json', contents: templates['tsconfig.json.template'] },
      { path: 'tsdown.config.ts', contents: templates['tsdown.config.ts.template'] },
    ],
  ]
  process.stdout.write(`typechecking a rendered bundle at ${root}\n`)
  if (typecheck(root, fromTemplates, 'the scaffolded code') !== 0) fail(1)

  const { compileCapabilitySet, compilePackaging } = await import('../src/compile.ts')
  const { deriveValues } = await import('../src/scaffold.ts')
  const irRoot = mkdtempSync(join(BUNDLE, '.typecheck-ir-'))
  try {
    const compiled = compileCapabilitySet(PROBE_IR)
    if (compiled.warnings.length > 0) {
      process.stderr.write(`✗ compiling the fixture IR produced warnings: ${compiled.warnings.join('; ')}\n`)
      fail(1)
    }
    const packaging = compilePackaging(PROBE_IR, templates, deriveValues({
      target: PROBE_IR.target.name,
      description: PROBE_IR.target.description,
      executable: PROBE_IR.capabilities[0].invocation.command,
      dshRange: '^0.1.5-rc.2',
      tools: PROBE_IR.capabilities.map((c) => ({ name: c.id, description: c.description, subcommand: '' })),
    }))
    process.stdout.write(`typechecking a compiled bundle at ${irRoot}\n`)
    if (typecheck(irRoot, [...compiled.files, ...packaging], 'the compiled code') !== 0) fail(1)
  } finally {
    rmSync(irRoot, { recursive: true, force: true })
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

process.exit(exitCode)
