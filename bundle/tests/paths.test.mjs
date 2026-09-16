/**
 * The paths this package derives from its own install location.
 *
 * These are the paths a user never sets and never sees — which is exactly why they broke without anything
 * noticing. `fromPackageRoot` used `new URL(import.meta.url).pathname`, which on Windows yields `/D:/…`;
 * `path.resolve` then read the drive letter as a directory name and produced `D:\D:\…`. Every derived path
 * was wrong on Windows.
 *
 * Nothing caught it: the unit tests pass explicit paths, the fake-template scaffold test never resolves a
 * real file, and the type gate does not evaluate expressions. A real agent finally surfaced it by reporting
 * that `plugin_anything_verify` was looking for its gate at `D:\D:\Opencode\…` — and then declining to trust
 * the tool.
 *
 * So these tests assert what the tool *reports*, not the helper in isolation.
 *
 * Run: node --test tests/paths.test.mjs   (requires `pnpm install` and `npx tsdown` first)
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
 * Load the built entry and register its tools with no cordis runner present.
 * @returns {Promise<Map<string, any>>} tool name to definition.
 */
async function definitions() {
  assert.ok(existsSync(ENTRY), `${ENTRY} does not exist — run \`npx tsdown\` in ${BUNDLE} first`)
  const mod = await import(`file://${ENTRY.replaceAll('\\', '/')}`)
  const found = new Map()
  const ctx = {
    tools: { register: (definition) => { found.set(definition.name, definition); return () => {} } },
    inject: () => undefined,
  }
  mod.apply(ctx, {
    verifierPath: '', outputDir: '/tmp/plugin-anything-paths-test', profile: 'test', timeoutMs: 30_000,
  })
  return found
}

test('the default verifier path resolves to a file that exists', async () => {
  const verify = (await definitions()).get('plugin_anything_verify')
  assert.ok(verify !== undefined, 'plugin_anything_verify must always register')

  const result = await verify.execute({ path: BUNDLE }, { signal: new AbortController().signal })

  // The tool reports the path it ran. Parse it back out and assert it is real — a duplicated drive prefix
  // or a doubled segment fails here rather than in a user's session.
  const reported = /ran (\S+)/.exec(result.output)?.[1]
  assert.ok(reported !== undefined, `the tool did not report which gate it ran:\n${result.output}`)
  assert.ok(
    existsSync(reported),
    `the tool reported running a gate at ${reported}, which does not exist`,
  )
})

test('no derived path contains a duplicated drive or a doubled directory segment', async () => {
  const verify = (await definitions()).get('plugin_anything_verify')
  const result = await verify.execute({ path: BUNDLE }, { signal: new AbortController().signal })
  const reported = /ran (\S+)/.exec(result.output)?.[1] ?? ''

  // The exact shape the bug produced.
  assert.ok(!/^[A-Za-z]:\\[A-Za-z]:/.test(reported), `duplicated drive prefix: ${reported}`)
  assert.ok(!reported.includes('D:\\D:\\'), `duplicated drive prefix: ${reported}`)
  // And the general form: the resolved path must be inside this repository.
  assert.ok(
    reported.startsWith(BUNDLE) || reported.startsWith(resolve(BUNDLE, '..')),
    `the gate path escaped the repository: ${reported}`,
  )
})

test('the gate the tool runs is the one this package ships', async () => {
  // Not a sibling checkout. The tool must work for someone who installed the bundle and has no repository.
  const verify = (await definitions()).get('plugin_anything_verify')
  const result = await verify.execute({ path: BUNDLE }, { signal: new AbortController().signal })
  const reported = /ran (\S+)/.exec(result.output)?.[1] ?? ''
  assert.equal(
    resolve(reported),
    join(BUNDLE, 'scripts', 'verify-plugin.mjs'),
    'verify must run the copy shipped in this package, not one from a sibling directory',
  )
})
