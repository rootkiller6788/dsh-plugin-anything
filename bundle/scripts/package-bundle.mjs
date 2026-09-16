#!/usr/bin/env node
/**
 * Package this bundle and check the artifact against the manifest.
 *
 * Usage: node scripts/package-bundle.mjs [--dry-run]
 *
 * The packaging is one command; the value here is the comparison. `files` decides what a consumer receives,
 * and a `files` list that has drifted from what the code reads produces a package that works in this
 * checkout and fails for everyone who installs it.
 *
 * Exit codes: 0 the artifact carries everything promised · 1 it does not
 */

import { resolve } from 'node:path'

const BUNDLE = resolve(import.meta.dirname, '..')
const mod = await import(`file://${resolve(BUNDLE, 'lib', 'index.js').replaceAll('\\', '/')}`)

const tools = new Map()
mod.apply(
  { tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } }, inject: () => undefined },
  { verifierPath: '', outputDir: '', profile: 'panything', timeoutMs: 120_000 },
)

const pack = tools.get('plugin_anything_package')
if (pack === undefined) {
  process.stderr.write('plugin_anything_package did not register\n')
  process.exit(1)
}

const result = await pack.execute(
  { bundle: BUNDLE, ...(process.argv.includes('--dry-run') ? { dryRun: true } : {}) },
  { signal: new AbortController().signal },
)

process.stdout.write(`${result.report}\n\nverdict = ${result.verdict}\n`)
process.exit(result.verdict === 'pass' ? 0 : 1)
