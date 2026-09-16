/**
 * Presenter replay, against a real logged turn.
 *
 * The presenter contract was this project's first and worst mistake: `presentResult(args, result)` was
 * written as if `result` were the tool's canonical value. It is a `ToolResult`. Typechecking catches the
 * mistake in the abstract; this test catches it in the concrete, using the exact `args` and `result` a real
 * `dsh` logged.
 *
 * The fixture below is a verbatim excerpt of a `tool/result` event from a real session — a real model turn
 * called `plugin_anything_probe` with `target: "git"` inside a real profile with this bundle installed. Per
 * dsh's policy, package tests and hand-written fixtures do not substitute for a real transcript; this is
 * that transcript, reduced to the fields a presenter may see.
 *
 * Run: node --test tests/presenter-replay.test.mjs   (requires `pnpm install` and `npx tsdown` first)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')
const ENTRY = join(BUNDLE, 'lib', 'index.js')

/** The `args` a real model turn passed. Verbatim from the logged `tool/call` event. */
const LOGGED_ARGS = { target: 'git' }

/**
 * The `result` that call produced, reduced to the three fields a presenter receives.
 *
 * `content` and `isError` are verbatim from the logged `tool/result` event. `meta` is verbatim from the
 * same event — it is the payload `output.presentationMeta` projected, which is the only channel through
 * which a card can see structured data.
 */
const LOGGED_RESULT = {
  content: [{
    type: 'text',
    text: 'kind: cli\ncallable: true\nendpoint: D:\\Program Files\\Git\\mingw64\\bin\\git.exe\n\n'
      + 'evidence:\n'
      + '  - ✓ git resolves to D:\\Program Files\\Git\\mingw64\\bin\\git.exe on PATH\n'
      + '  - ✓ D:\\Program Files\\Git\\mingw64\\bin\\git.exe is an existing file\n'
      + '  - ✓ ran --help successfully\n\n'
      + 'Proceed to Phase 1. Map cli capabilities to tools using the help excerpt as the raw material.',
  }],
  isError: false,
  meta: {
    kind: 'cli',
    recommendation: 'Proceed to Phase 1. Map cli capabilities to tools using the help excerpt as the raw material.',
  },
}

/**
 * Load the built entry and collect its tool definitions.
 *
 * The cordis runner is resolved so `promote` registers too: its fixtures below are real logged calls, and a
 * helper that silently omitted it would leave the most interesting presenter untested.
 *
 * @returns {Promise<Map<string, any>>} tool name to definition.
 */
async function definitions() {
  assert.ok(existsSync(ENTRY), `${ENTRY} does not exist — run \`npx tsdown\` in ${BUNDLE} first`)
  const mod = await import(`file://${ENTRY.replaceAll('\\', '/')}`)
  const found = new Map()
  const runner = { inspectPackage: () => ({ code: { host: 'return {}' } }) }
  const scoped = {
    tools: { register: (definition) => { found.set(definition.name, definition); return () => {} } },
    get: (key) => (key === 'dynamicCordisRunner' ? runner : undefined),
  }
  mod.apply(
    { tools: scoped.tools, inject: (_names, callback) => callback(scoped) },
    { verifierPath: '', outputDir: '/tmp/plugin-anything-test', profile: 'test', timeoutMs: 5_000 },
  )
  return found
}

test('the probe renders the logged turn from meta, not from the canonical value', async () => {
  const definition = (await definitions()).get('plugin_anything_probe')
  assert.ok(definition !== undefined, 'plugin_anything_probe must be registered')

  const view = definition.presentResult(LOGGED_ARGS, LOGGED_RESULT)

  // The card must be derived from `result.meta`. If a presenter were (wrongly) reading `result.kind`
  // directly it would read `undefined` and decline — this asserts the projection is actually consumed.
  assert.equal(view?.card, 'generic')
  assert.equal(view?.title, 'cli target')
  assert.match(view.content[0].text, /Proceed to Phase 1/)
})

test('a presenter is pure: replaying the same input twice yields an identical view', async () => {
  const definition = (await definitions()).get('plugin_anything_probe')
  const first = definition.presentResult(LOGGED_ARGS, LOGGED_RESULT)
  const second = definition.presentResult(LOGGED_ARGS, LOGGED_RESULT)
  assert.deepEqual(second, first)
  // And the call card too — it must be a function of `args` alone.
  assert.deepEqual(definition.presentCall(LOGGED_ARGS), definition.presentCall(LOGGED_ARGS))
})

test('a result from a different tool version declines to the generic fallback, never throws', async () => {
  // This is the property that makes replay safe. An older or newer log may carry a `meta` this build does
  // not recognize, or none at all; rendering it as the generic card is correct, and throwing is not.
  const definition = (await definitions()).get('plugin_anything_probe')
  for (const meta of [undefined, null, 'a string', 42, {}, { kind: 'cli' }, { recommendation: 'x' },
    { kind: 3, recommendation: 'x' }, { kind: 'cli', recommendation: null }]) {
    const result = { content: LOGGED_RESULT.content, isError: false, meta }
    let view
    assert.doesNotThrow(() => { view = definition.presentResult(LOGGED_ARGS, result) }, `meta=${JSON.stringify(meta)}`)
    assert.equal(view, undefined, `meta=${JSON.stringify(meta)} should decline to the generic fallback`)
  }
})

test('a failed call declines to the generic fallback', async () => {
  const definition = (await definitions()).get('plugin_anything_probe')
  const failed = { ...LOGGED_RESULT, isError: true }
  assert.equal(definition.presentResult(LOGGED_ARGS, failed), undefined)
})

test('every registered tool survives a replay with an unrecognisable meta', async () => {
  // The blanket form of the rule: no presenter in this bundle may throw on replay of a foreign log.
  for (const [name, definition] of await definitions()) {
    if (typeof definition.presentResult !== 'function') continue
    assert.doesNotThrow(
      () => definition.presentResult({}, { content: [], isError: false, meta: { unexpected: true } }),
      `${name}.presentResult threw on an unrecognisable meta`,
    )
  }
})

// ── `presentCall`, from a real logged call ──────────────────────────────────────────────────────────
//
// The fixture above covers `presentResult`. `presentCall` has no result to read, so its evidence is the
// call event itself — and the log stores `arguments` as a JSON *string*, which the harness parses before a
// presenter ever sees it. That parse step is part of the replay path and is pinned here.

/**
 * A real `tool/call` event's `data.arguments`, verbatim from the session log. Note it is a string.
 */
const LOGGED_ARGUMENTS =
  '{"outputDir": "D:/Opencode/dsh-plugin/dsh-plugin-anything/.acceptance", "packageId": "pkg-1", "pluginId": "probe-1", "target": "e2e-dynamic"}'

/**
 * That call's result, reduced to the fields a presenter receives.
 *
 * This log was written by an **older version** of the tool: `written` names `src/promoted-e2e-dynamic.ts`,
 * the location the first implementation used before it moved the artifact out of the build. That makes it a
 * genuinely foreign log rather than a round-trip of current behaviour — exactly the case the
 * decline-don't-throw rule exists for.
 */
const LOGGED_PROMOTE_RESULT = {
  content: [{
    type: 'text',
    text: 'promoted to D:/Opencode/dsh-plugin/dsh-plugin-anything/.acceptance/dsh-plugin-e2e-dynamic\n'
      + '  + src/promoted-e2e-dynamic.ts\n\nBefore installing, review:\n'
      + '  - The promoted source came from a dynamic package, which the sandbox docs describe as isolated '
      + 'globals but NOT a security boundary. It will now run unsandboxed on the next boot.',
  }],
  isError: false,
  meta: {
    root: 'D:/Opencode/dsh-plugin/dsh-plugin-anything/.acceptance/dsh-plugin-e2e-dynamic',
    written: ['src/promoted-e2e-dynamic.ts'],
  },
}

test('the logged call arguments parse to what presentCall receives', () => {
  const parsed = JSON.parse(LOGGED_ARGUMENTS)
  assert.deepEqual(Object.keys(parsed).sort(), ['outputDir', 'packageId', 'pluginId', 'target'])
  // The harness parses before presenting, so a presenter never sees the raw string. Asserting the parse
  // here keeps that step from being assumed.
  assert.equal(parsed.pluginId, 'probe-1')
})

test('promote renders a call card from a real logged call', async () => {
  const definition = (await definitions()).get('plugin_anything_promote')
  assert.ok(definition !== undefined, 'plugin_anything_promote must be registered when the runner is present')

  const view = definition.presentCall(JSON.parse(LOGGED_ARGUMENTS))
  assert.equal(view?.card, 'generic')
  assert.equal(view?.kind, 'edit')
  assert.equal(view?.title, 'promote probe-1/pkg-1')
})

test('promote renders a result card from a real logged result written by an older version', async () => {
  const definition = (await definitions()).get('plugin_anything_promote')
  const view = definition.presentResult(JSON.parse(LOGGED_ARGUMENTS), LOGGED_PROMOTE_RESULT)

  assert.equal(view?.card, 'diff', 'a promotion writes files, so it presents as a diff')
  assert.match(view.title, /dsh-plugin-e2e-dynamic$/)
  // The card is built from the projected meta, not from parsing the model-facing text.
  assert.deepEqual(view.diffs.map((d) => d.path), [
    'D:/Opencode/dsh-plugin/dsh-plugin-anything/.acceptance/dsh-plugin-e2e-dynamic/src/promoted-e2e-dynamic.ts',
  ])
  assert.equal(view.diffs[0].oldText, null, 'a call-time presenter has no prior content')
  assert.deepEqual(view.locations.map((l) => l.path), view.diffs.map((d) => d.path))
})

test('the whole real transcript replays deterministically', async () => {
  const found = await definitions()
  for (const [name, definition] of found) {
    if (typeof definition.presentCall !== 'function') continue
    const once = definition.presentCall(JSON.parse(LOGGED_ARGUMENTS))
    const twice = definition.presentCall(JSON.parse(LOGGED_ARGUMENTS))
    assert.deepEqual(twice, once, `${name}.presentCall is not a pure function of its args`)
  }
})
