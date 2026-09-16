/**
 * Inspection against a real target.
 *
 * The fixture tests prove the parsers handle shapes I chose. This one proves they handle a shape nobody
 * chose — `git`'s actual `--help` output, on whatever platform the test runs on. It self-skips when `git`
 * is absent, so a machine without it stays green rather than reporting a failure it cannot investigate.
 *
 * It is deliberately not a snapshot: the assertion is about structure (did we find subcommands, is the
 * version a version), not about git's exact wording, which changes between versions. A snapshot would fail
 * on every git upgrade and teach people to re-record it blindly.
 *
 * Run: node --test tests/inspect-live.test.mjs   (requires `npx tsdown` first)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')
const ENTRY = join(BUNDLE, 'lib', 'index.js')

/**
 * Whether a command exists on this machine.
 * @param {string} name - the command.
 * @returns {boolean} whether it resolves.
 */
function has(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', shell: process.platform === 'win32' })
  return probe.status === 0 && probe.stdout.trim() !== ''
}

test('inspects a real CLI end to end', { skip: !has('git') ? 'git is not installed here' : false }, async () => {
  assert.ok(existsSync(ENTRY), `${ENTRY} does not exist — run \`npx tsdown\` in ${BUNDLE} first`)
  const mod = await import(`file://${ENTRY.replaceAll('\\', '/')}`)
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    inject: () => undefined,
  }
  mod.apply(ctx, { verifierPath: '', outputDir: '/tmp/dpa-live', profile: 'test', timeoutMs: 60_000 })

  const result = await tools.get('plugin_anything_inspect').execute(
    { target: 'git', maxCommands: 8 },
    { signal: new AbortController().signal },
  )

  // Resolution through PATH: the whole point of probing by name rather than by path.
  assert.ok(/git(.exe)?$/i.test(result.entrypoint), `expected a resolved git path, got ${result.entrypoint}`)
  // A real CLI has subcommands, and git's help lists them without a section header — the shape a
  // header-requiring parser gets wrong.
  assert.ok(result.commandCount >= 5, `expected several subcommands, got ${result.commandCount}`)
  assert.match(result.version, /\d+\.\d+/, `expected a version with digits, got ${JSON.stringify(result.version)}`)
  // The report must carry verbatim help, not a summary of it.
  assert.ok(result.report.length > 1000, 'the report should carry real help text')
  assert.match(result.report, /usage:\s*git/i, 'the entrypoint help is missing from the report')

  // And the subcommand help must be there too.
  //
  // This assertion is why the test exists. The first version checked only the entrypoint, so it stayed green
  // while every subcommand returned zero bytes — because `git <sub> --help` prints nothing on Git for Windows
  // and opens the HTML documentation in a browser instead. The gate was satisfied by the one piece of help
  // that happened to work, and the inspection was silently empty everywhere else.
  const subcommandHelp = result.report.split(/^--- /m).slice(2)
  assert.ok(subcommandHelp.length >= 5, `expected help sections per subcommand, got ${subcommandHelp.length}`)
  const empty = subcommandHelp.filter((section) => section.split('\n').slice(1).join('').trim() === '')
  assert.deepEqual(
    empty.map((section) => section.split('\n')[0]),
    [],
    'these subcommands returned no help text at all, which means the flag used does not work for them',
  )
})

test('inspection is bounded and reports truncation on a real CLI', { skip: !has('git') ? 'git is not installed here' : false }, async () => {
  const mod = await import(`file://${ENTRY.replaceAll('\\', '/')}`)
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    inject: () => undefined,
  }
  mod.apply(ctx, { verifierPath: '', outputDir: '/tmp/dpa-live', profile: 'test', timeoutMs: 60_000 })

  // git lists far more than two subcommands, so a budget of two must truncate — and say so.
  const result = await tools.get('plugin_anything_inspect').execute(
    { target: 'git', maxCommands: 2 },
    { signal: new AbortController().signal },
  )
  assert.equal(result.commandCount, 2)
  assert.equal(result.truncated, true)
  assert.ok(
    result.unknowns.some((u) => /only the first 2/.test(u)),
    `truncation must be named in unknowns, got ${JSON.stringify(result.unknowns)}`,
  )
})
