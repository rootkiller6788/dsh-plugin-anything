/**
 * Does the built bundle actually register its tools?
 *
 * The composition gate proves our row reaches the tree, and a real `dsh` boot proves `apply` runs without
 * throwing. Neither proves the tools exist. This test closes that gap by calling the **built** `apply` with
 * a recording context — the real artifact, not the source, so a build that mangles the entry is caught.
 *
 * It is deliberately not a full composition test. It answers one question — which tools register, and under
 * what conditions — and answers it without a model, a key, or a profile.
 *
 * Run: node --test tests/registration.test.mjs   (requires `pnpm install`, and `npx tsdown` first)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')
const ENTRY = join(BUNDLE, 'lib', 'index.js')

/**
 * A recording stand-in for the plugin context.
 *
 * Implements exactly the surface this plugin uses: `tools.register` and `inject`. A stand-in is acceptable
 * here because the subject is *our* registration logic, not the registry — the registry is the host's, and
 * the composition test covers whether the host mounts us at all.
 *
 * By default no service is available, so `inject` records the request and **never runs the callback**. That
 * is the real semantics, and the reason a plugin can use `inject` to stay out of a host that cannot serve
 * it: a headless profile has no `cordis-host-runner`, so a promote tool there would be a tool that exists
 * and always fails.
 */
function recordingContext() {
  /** @type {{name: string, definition: unknown}[]} */
  const registered = []
  /** @type {readonly string[][]} */
  const injected = []
  return {
    registered,
    injected,
    tools: {
      register(definition) {
        registered.push({ name: definition.name, definition })
        return () => {}
      },
    },
    inject(services, callback) {
      injected.push(services)
      void callback
      return undefined
    },
  }
}

/** Values the plugin's `apply` expects Schemastery to have already defaulted. */
function config(overrides = {}) {
  return {
    verifierPath: '',
    outputDir: '/tmp/plugin-anything-test',
    profile: 'test',
    timeoutMs: 5_000,
    ...overrides,
  }
}

/**
 * Load the built entry, failing with an actionable message when it has not been built.
 * @returns {Promise<{name: string, inject: string[], apply: Function}>} the plugin module.
 */
async function loadBuilt() {
  assert.ok(
    existsSync(ENTRY),
    `${ENTRY} does not exist — run \`npx tsdown\` in ${BUNDLE} before this test`,
  )
  return import(`file://${ENTRY.replaceAll('\\', '/')}`)
}

test('the built bundle registers every tool it documents', async () => {
  const mod = await loadBuilt()
  const ctx = recordingContext()

  mod.apply(ctx, config())

  const names = ctx.registered.map((entry) => entry.name).sort()
  // One tool per mechanized pipeline stage, plus `promote`, which registers conditionally. If this list
  // changes, the pipeline definition in `src/pipeline.ts` changed too — check that they still agree.
  assert.deepEqual(names, [
    'plugin_anything_accept',
    'plugin_anything_compile',
    'plugin_anything_inspect',
    'plugin_anything_install',
    'plugin_anything_package',
    'plugin_anything_probe',
    'plugin_anything_scaffold',
    'plugin_anything_verify',
  ])
})

test('every mechanized stage in the pipeline names a tool that actually registers', async () => {
  // The pipeline definition is the authority on which stages have a tool. A stage that claims one which does
  // not register is a coverage number that lies — the failure mode this project keeps running into.
  const { STAGES } = await import('../src/pipeline.ts')
  const mod = await loadBuilt()
  const ctx = recordingContext()
  mod.apply(ctx, config())
  const registered = new Set(ctx.registered.map((entry) => entry.name))

  for (const stage of STAGES.filter((s) => s.tool !== undefined)) {
    if (stage.tool === 'plugin_anything_promote') continue // conditional: needs the cordis runtime
    assert.ok(
      registered.has(stage.tool),
      `pipeline stage "${stage.id}" claims tool "${stage.tool}", which does not register`,
    )
  }
})

test('the entry is a function plugin: named exports, no default export', async () => {
  // The rule the static gate also checks, asserted here against the built artifact. The Loader discards a
  // function plugin's namespace when a default export is present, and a Loader smoke stays green while it
  // does — so the assertion has to be explicit.
  const mod = await loadBuilt()
  assert.equal(typeof mod.name, 'string')
  assert.ok(Array.isArray(mod.inject))
  assert.equal(typeof mod.apply, 'function')
  assert.ok(!('default' in mod), 'a function plugin must not have a default export')
})

test('promote registers only when the cordis runtime is mounted', async () => {
  const mod = await loadBuilt()

  // Absent — a headless profile, or any profile without the dsh-web-app bundle.
  const without = recordingContext()
  mod.apply(without, config())
  assert.deepEqual(without.injected, [['dynamicCordisRunner']], 'the plugin should ask for the cordis runner')
  assert.ok(
    !without.registered.some((entry) => entry.name === 'plugin_anything_promote'),
    'promote must not be advertised where it cannot work',
  )

  // Present — resolve the runner so the callback runs. The stub mirrors the shipped surface:
  // `inspectPackage(agent, pluginId, packageId)` returning `{ code: { host, client } }`.
  const withRuntime = recordingContext()
  const services = {
    dynamicCordisRunner: {
      inspectPackage: (agent, pluginId, packageId) => ({ code: { host: `// ${pluginId}/${packageId}` } }),
    },
  }
  withRuntime.inject = (names, callback) => {
    withRuntime.injected.push(names)
    return callback({ ...withRuntime, get: (key) => services[key] })
  }
  mod.apply(withRuntime, config())
  assert.ok(
    withRuntime.registered.some((entry) => entry.name === 'plugin_anything_promote'),
    'promote must register where the runtime is mounted',
  )
})

test('every registered definition carries the contract the host requires', async () => {
  const mod = await loadBuilt()
  const ctx = recordingContext()
  mod.apply(ctx, config())

  for (const { name, definition } of ctx.registered) {
    assert.equal(typeof definition.description, 'string', `${name}: description`)
    assert.ok(definition.description.length > 20, `${name}: description should tell the model something`)
    assert.equal(typeof definition.parameters, 'object', `${name}: parameters`)
    assert.equal(typeof definition.output?.schema, 'object', `${name}: output.schema`)
    assert.equal(typeof definition.output?.render, 'function', `${name}: output.render`)
    // The canonical value is not on the wire, so a card that needs structured data must project it.
    assert.equal(
      typeof definition.output?.presentationMeta,
      'function',
      `${name}: output.presentationMeta — presenters cannot see the canonical value without it`,
    )
    assert.equal(typeof definition.execute, 'function', `${name}: execute`)
  }
})

test('a non-positive timeout fails loud at apply, not at the first call', async () => {
  const mod = await loadBuilt()
  assert.throws(() => mod.apply(recordingContext(), config({ timeoutMs: 0 })), /positive finite/)
  assert.throws(() => mod.apply(recordingContext(), config({ timeoutMs: Number.NaN })), /positive finite/)
})
