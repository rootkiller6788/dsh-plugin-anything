#!/usr/bin/env node
/**
 * Run the acceptance tail over this bundle, for real.
 *
 * Usage:
 *   node scripts/accept-bundle.mjs [--log <session.v3.jsonl.zstd>] [--profile <name>] [--dsh <command>]
 *
 * Without a session log the discover, invoke, present, and replay stages cannot run, and the verdict is
 * therefore `incomplete` — never `accepted`. Running it that way is itself a check: it asserts that the
 * machinery refuses to claim an acceptance it has no evidence for.
 *
 * Exit codes: 0 accepted · 1 rejected · 2 incomplete
 */

import { resolve } from 'node:path'

const BUNDLE = resolve(import.meta.dirname, '..')

/**
 * Read a `--flag value` argument.
 * @param {string} flag - the flag name.
 * @returns the value, or undefined when the flag is absent.
 */
function arg(flag) {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}

const mod = await import(`file://${resolve(BUNDLE, 'lib', 'index.js').replaceAll('\\', '/')}`)
const tools = new Map()
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
  inject: () => undefined,
}
mod.apply(ctx, { verifierPath: '', outputDir: '', profile: 'panything', timeoutMs: 300_000 })

const accept = tools.get('plugin_anything_accept')
if (accept === undefined) {
  process.stderr.write('plugin_anything_accept did not register\n')
  process.exit(1)
}

const log = arg('--log')
const result = await accept.execute(
  {
    bundle: BUNDLE,
    profile: arg('--profile') ?? 'panything',
    tool: arg('--tool') ?? 'plugin_anything_probe',
    ...(log === undefined ? {} : { sessionLog: log }),
    dshCommand: arg('--dsh') ?? 'dsh',
  },
  { signal: new AbortController().signal },
)

process.stdout.write(`${result.report}\n\nverdict = ${result.verdict}\n`)
process.exit(result.verdict === 'accepted' ? 0 : result.verdict === 'incomplete' ? 2 : 1)
