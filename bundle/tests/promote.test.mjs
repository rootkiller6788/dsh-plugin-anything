/**
 * `plugin_anything_promote` against the runner's real API shape.
 *
 * This test exists because the tool was originally written against a service that does not exist. It called
 * `cordisInspect.self(pluginId, packageId)` — conflating the model-facing *tool* (`cordis_inspect_self`)
 * with the underlying *service*. The shipped declarations say otherwise:
 *
 *   ctx.dynamicCordisRunner.inspectPackage(agent, pluginId, packageId): { code: { host?, client? } }
 *
 * The service is `dynamicCordisRunner`, the method is `inspectPackage`, it takes the owning `Agent` first,
 * and the source lives under `code`. A typecheck cannot catch this — the interface was declared locally, so
 * it agreed with itself. Only comparing it against the real package can, which is what this does.
 *
 * Run: node --test tests/promote.test.mjs   (requires `pnpm install` and `npx tsdown` first)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')
const ENTRY = join(BUNDLE, 'lib', 'index.js')

/** A minimal Agent stand-in; the runner uses it only to identify the owning Session. */
const AGENT = { id: 'agent-under-test' }

/**
 * Register the plugin's tools against a stubbed runner.
 * @param {object} inspection - what the stubbed `inspectPackage` returns.
 * @returns {Promise<{promote: any, calls: any[][]}>} the promote definition and the recorded calls.
 */
async function withStubbedRunner(inspection) {
  assert.ok(existsSync(ENTRY), `${ENTRY} does not exist — run \`npx tsdown\` in ${BUNDLE} first`)
  const mod = await import(`file://${ENTRY.replaceAll('\\', '/')}`)

  const registered = new Map()
  /** @type {any[][]} */
  const calls = []
  const runner = {
    inspectPackage: (...args) => { calls.push(args); return inspection },
  }
  const scoped = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (key) => (key === 'dynamicCordisRunner' ? runner : undefined),
  }
  mod.apply(
    { tools: scoped.tools, inject: (_names, callback) => callback(scoped) },
    { verifierPath: '', outputDir: '/tmp/plugin-anything-promote-test', profile: 'test', timeoutMs: 5_000 },
  )
  return { promote: registered.get('plugin_anything_promote'), calls }
}

/** The args a promotion call carries. */
const ARGS = { pluginId: 'plugin-abc', packageId: 'package-1', target: 'widget', outputDir: '/tmp/dpa-promote' }

test('promote reads source through inspectPackage(agent, pluginId, packageId)', async () => {
  const { promote, calls } = await withStubbedRunner({ code: { host: 'return {}' } })
  assert.ok(promote !== undefined, 'promote must register when the runner is present')

  await promote.execute(ARGS, { agent: AGENT, signal: new AbortController().signal })

  assert.equal(calls.length, 1)
  // Argument ORDER matters: the Agent comes first. A call shaped for the old assumed API —
  // (pluginId, packageId) with no agent — would pass the plugin id where the agent belongs.
  assert.deepEqual(calls[0], [AGENT, 'plugin-abc', 'package-1'])
})

test('promote reports a missing Agent instead of passing undefined through', async () => {
  const { promote } = await withStubbedRunner({ code: { host: 'return {}' } })
  await assert.rejects(
    () => promote.execute(ARGS, { signal: new AbortController().signal }),
    /needs the owning Agent/,
  )
})

test('promote refuses a package with no host half', async () => {
  // A package with only a client half is settled by a person, not by code, so there is nothing to freeze.
  const { promote } = await withStubbedRunner({ code: { client: 'return {}' } })
  await assert.rejects(
    () => promote.execute(ARGS, { agent: AGENT, signal: new AbortController().signal }),
    /no host half/,
  )
})

test('promote flags a client half in its review notes', async () => {
  const { promote } = await withStubbedRunner({ code: { host: 'return {}', client: 'return {}' } })
  const value = await promote.execute(ARGS, { agent: AGENT, signal: new AbortController().signal })
  assert.equal(value.hasClientHalf, true)
  assert.ok(value.reviewNotes.some((note) => /client half/.test(note)))
})
