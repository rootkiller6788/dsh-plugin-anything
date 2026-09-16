/**
 * Regression tests for defects that were fixed without one.
 *
 * Every case here is a defect this project actually shipped. Each was fixed in code and then left without a
 * test that would catch it coming back — which makes "fixed" a claim rather than evidence. This file exists
 * because that gap was found by asking the question, not by running the suite.
 *
 * A note on the shape of these tests: none of them assert that the implementation looks a particular way.
 * They assert the *behaviour the defect broke*, so a different correct implementation still passes.
 *
 * Run: node --test tests/regressions.test.mjs   (requires `pnpm install` and `npx tsdown` first)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileCapabilitySet } from '../src/compile.ts'
import { IR_VERSION } from '../src/ir.ts'
import { runCommand } from '../src/backend.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')
const ENTRY = join(BUNDLE, 'lib', 'index.js')

/**
 * Load the built bundle's tool definitions.
 * @param {boolean} withRunner - whether the cordis runner resolves.
 * @returns {Promise<Map<string, any>>} tool name to definition.
 */
async function definitions(withRunner = false) {
  assert.ok(existsSync(ENTRY), `${ENTRY} does not exist — run \`npx tsdown\` in ${BUNDLE} first`)
  const mod = await import(`file://${ENTRY.replaceAll('\\', '/')}`)
  const found = new Map()
  const runner = { inspectPackage: () => ({ code: { host: 'return {}' } }) }
  const scoped = {
    tools: { register: (definition) => { found.set(definition.name, definition); return () => {} } },
    get: (key) => (withRunner && key === 'dynamicCordisRunner' ? runner : undefined),
  }
  mod.apply(
    { tools: scoped.tools, inject: (_names, callback) => callback(scoped) },
    { verifierPath: '', outputDir: '/tmp/dpa-regressions', profile: 'test', timeoutMs: 30_000 },
  )
  return found
}

// ── Defect: a capability with no inputs generated code that did not compile ──────────────────────────
//
// `[].filter((entry): entry is string => …)` — with no elements the literal is `never[]`, and a type
// predicate cannot narrow `never` (`TS2677`). The typecheck gate now carries a zero-input capability in its
// fixture, so the *compile* is covered there; this asserts the generated shape directly, so a failure names
// the capability instead of the fixture.

/** A capability set with one capability carrying no inputs. */
const ZERO_INPUT_SET = {
  irVersion: IR_VERSION,
  target: { name: 'zero', description: 'A target whose only capability takes no arguments.', source: { kind: 'cli', location: '/x' } },
  capabilities: [{
    id: 'version',
    name: 'Version',
    description: 'Report the version.',
    source: { kind: 'cli', location: '/x' },
    invocation: { type: 'exec', command: '/x', args: ['--version'] },
    inputs: [],
    outputs: [{ name: 'stdout', description: 'The version.', type: 'string' }],
    dependencies: [],
    environment: [],
    permissions: { filesystem: ['/x'], network: [], process: true, secrets: [] },
    evidence: [{ stage: 'inspect', observed: 'ran it with no arguments' }],
    confidence: 'observed',
    lifecycle: {},
  }],
}

test('a capability with no inputs compiles to a body that binds an empty argv', () => {
  const source = compileCapabilitySet(ZERO_INPUT_SET).files.find((f) => f.path === 'src/version.ts').contents
  // The defect's exact shape: an empty array literal with a type predicate over it.
  assert.ok(
    !/const bound = \[\s*\]/.test(source),
    'an empty array literal with a type predicate does not compile (TS2677)',
  )
  // What it should be instead: an empty argv, explicitly typed.
  assert.match(source, /const bound[^=]*=\s*\[\]/, 'the binding should be an empty array')
  // And the invocation must still happen, with that empty argv.
  assert.match(source, /invokeCommand\(backend, bound/)
})

test('a capability with inputs still binds them positionally', () => {
  // The counterpart: the zero-input branch must not have swallowed the binding.
  const withInput = structuredClone(ZERO_INPUT_SET)
  withInput.capabilities[0].inputs = [{ name: 'limit', description: 'How many.', type: 'integer', required: true }]
  const source = compileCapabilitySet(withInput).files.find((f) => f.path === 'src/version.ts').contents
  assert.match(source, /args\["limit"\]/)
  assert.match(source, /\.filter\(\(entry\): entry is string/)
})

// ── Defect: a presenter's rendered text disagreed with its schema ────────────────────────────────────
//
// The probe's `render` printed `surface:` while the field is `kind`. A real model turn had to reconcile that
// in prose. The rule generalizes: a tool's rendered labels are what the model reads, and a label that names
// nothing in the schema sends the model looking for a field that does not exist.

/**
 * Build a value that satisfies a tool's output schema.
 *
 * Types matter: the probe's `evidence` is an array, and rendering a string there throws inside the presenter
 * — which the first version of this test did, and then reported as a product fault. A fixture that does not
 * satisfy the schema tests the fixture.
 *
 * @param {Record<string, {type?: string, enum?: string[], properties?: object, items?: {type?: string}}>} properties - the schema's properties.
 * @returns {Record<string, unknown>} a value of the declared shape.
 */
function sampleFor(properties) {
  return Object.fromEntries(Object.entries(properties).map(([key, spec]) => {
    if (Array.isArray(spec.enum) && spec.enum.length > 0) return [key, spec.enum[0]]
    switch (spec.type) {
      case 'array': return [key, []]
      case 'boolean': return [key, true]
      case 'integer':
      case 'number': return [key, 1]
      case 'object': return [key, {}]
      default: return [key, 'sample']
    }
  }))
}

test('every label a tool renders is a field its own schema declares', async () => {
  const found = await definitions()
  assert.ok(found.size > 0)
  for (const [name, definition] of found) {
    const properties = definition.output.schema.properties ?? {}
    if (Object.keys(properties).length === 0) continue

    let rendered = ''
    try {
      rendered = definition.output.render({}, sampleFor(properties))
        .map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    } catch (cause) {
      assert.fail(`${name}: render threw on a schema-shaped value: ${cause.message}`)
    }

    // Every `label:` the renderer prints must be one of the declared fields — and the label must be printed
    // the way the schema spells it. `surface:` against a field named `kind` is the defect this guards.
    for (const match of rendered.matchAll(/^\s*([a-z][a-z_]*):/gm)) {
      const label = match[1]
      assert.ok(
        Object.hasOwn(properties, label),
        `${name} renders "${label}:" but its schema declares ${Object.keys(properties).join(', ')} — the model would look for a field that does not exist`,
      )
    }
  }
})

// ── Defect: promote wrote a sandbox function body into src/ ──────────────────────────────────────────
//
// The body is a sandbox *function body*: it opens with a top-level `return`, valid where it ran and a compile
// error anywhere else. Writing it into `src/` made the generated bundle fail its own typecheck before any
// conversion had happened — which reads as "promotion produced broken code" rather than "promotion produced
// an intermediate artifact".

test('promote writes its intermediate artifact outside the build', async () => {
  const promote = (await definitions(true)).get('plugin_anything_promote')
  assert.ok(promote !== undefined, 'promote must register where the runner resolves')

  const written = []
  const fs = await import('node:fs/promises')
  const original = fs.default.mkdir
  void original

  // The write goes through backend.writeBundle, so the assertion is on the planned paths rather than the
  // filesystem: a temp directory would test the filesystem instead of the decision.
  const result = await promote.execute(
    { pluginId: 'p', packageId: 'q', target: 'widget', outputDir: join(BUNDLE, '.regression-promote') },
    { agent: { id: 'a' }, signal: new AbortController().signal },
  )
  written.push(...result.written)
  await fs.rm(join(BUNDLE, '.regression-promote'), { recursive: true, force: true })

  for (const path of written) {
    assert.ok(
      !path.startsWith('src/'),
      `promote wrote ${path} into src/, where a top-level \`return\` is a compile error — the artifact is an intermediate, not a module`,
    )
  }
  assert.ok(written.some((p) => p.startsWith('promoted/')), `expected a promoted/ artifact, got ${written.join(', ')}`)
})

// ── Defect: runCommand could not run a Windows batch entry point ─────────────────────────────────────
//
// Four failures in one chain, each visible only after fixing the one before it: `execFile` does not apply
// PATHEXT, so a bare `npx` was ENOENT; `where npx` lists an extensionless shell script first; Node ≥ 20.12
// refuses to spawn a `.cmd` without a shell (EINVAL); and with `shell: true` Node concatenates rather than
// quoting, so `D:\Program Files\…` split at the space.
//
// Two of those were platform-specific and one was an API contract, so the assertion is behavioural: a bare
// batch entry point runs, and its arguments arrive intact.

test('runCommand runs a bare batch entry point with its arguments intact', { skip: process.platform !== 'win32' ? 'the defect was Windows-specific' : false }, async () => {
  // `npx` is a `.cmd` on Windows and lives under a path containing a space, so this one call exercises the
  // whole chain: resolution, extension selection, the shell requirement, and the quoting.
  const outcome = await runCommand('npx', ['--version'], {
    cwd: BUNDLE, signal: new AbortController().signal, timeoutMs: 120_000,
  })
  assert.equal(outcome.ok, true, `npx could not be run: exit ${outcome.exitCode}`)
  assert.match(outcome.stdout.trim(), /\d+\.\d+/, 'a version should have come back')
})

test('runCommand runs an absolute path whose directory contains a space', { skip: process.platform !== 'win32' ? 'the defect was Windows-specific' : undefined, timeout: 180_000 }, async () => {
  // The quoting half of the chain on its own: an absolute `.cmd` path with a space, where the argument to
  // quote is the command rather than an argument.
  const outcome = await runCommand(join(process.execPath, '..', 'npm').replace(/\.exe$/, ''), ['--version'], {
    cwd: BUNDLE, signal: new AbortController().signal, timeoutMs: 120_000,
  })
  assert.equal(outcome.ok, true, `a path with a space could not be run: ${outcome.stderr.slice(0, 200)}`)
})

test('runCommand refuses to find a command that does not exist, rather than hanging', async () => {
  // The failure mode a resolution step can introduce: a lookup that never returns.
  await assert.rejects(
    () => runCommand('definitely-not-a-real-command-xyz', ['--version'], {
      cwd: BUNDLE, signal: new AbortController().signal, timeoutMs: 30_000,
    }),
    /ENOENT|not found/i,
  )
})

// ── Defect: probe reported a PATH-installed tool as missing ──────────────────────────────────────────
//
// `isFile('git')` on a bare name is false, so every correctly installed CLI on PATH was reported
// `callable: false` — the first thing a user does with the tool gave a wrong answer.

test('probe reports a PATH-installed tool as callable', { skip: existsSync(join(BUNDLE, 'node_modules')) ? false : 'run pnpm install first' }, async () => {
  const probe = (await definitions()).get('plugin_anything_probe')
  const result = await probe.execute(
    { target: process.platform === 'win32' ? 'where' : 'which' },
    { signal: new AbortController().signal },
  )
  // A tool that is certainly installed on the machine running the suite.
  assert.equal(result.kind, 'cli')
  assert.equal(result.callable, true, `a PATH tool was reported uncallable: ${result.evidence.join('; ')}`)
  assert.match(result.endpoint, /[\\/]/, 'the endpoint should be a resolved path, not the bare name')
})
