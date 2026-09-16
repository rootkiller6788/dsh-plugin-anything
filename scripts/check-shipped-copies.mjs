#!/usr/bin/env node
/**
 * Assert that what the bundle ships is identical to the kit's originals.
 *
 * The bundle has to carry its own copies of three things, because a user who installs it from a tarball has
 * no repository around it:
 *
 *   - `sop/HARNESS.md`        the procedure the skill tells the agent to read
 *   - `templates/`            what `plugin_anything_scaffold` renders from
 *   - `scripts/verify-plugin.mjs`  what `plugin_anything_verify` runs
 *
 * The kit remains the single source of truth for all three. A copy that is not checked is a second source
 * of truth that drifts silently — and this project has been bitten by exactly that twice (`private: true`,
 * and the registry format). So the copies are pinned here, loudly.
 *
 * Fixing a mismatch: edit the KIT's file, then re-run this script with `--sync`.
 *
 * Usage: node scripts/check-shipped-copies.mjs [--sync]
 * Exit codes: 0 identical (or synced) · 1 drifted · 2 could not run
 */

import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const KIT = join(REPO, 'kit')
const BUNDLE = join(REPO, 'bundle')
const SYNC = process.argv.includes('--sync')

/** Each entry: the kit's source, and where the bundle must carry an identical copy. */
const COPIES = [
  { from: join(KIT, 'HARNESS.md'), to: join(BUNDLE, 'sop', 'SOP.md') },
  { from: join(KIT, 'scripts', 'verify-plugin.mjs'), to: join(BUNDLE, 'scripts', 'verify-plugin.mjs') },
  { from: join(REPO, 'docs', 'runtime-acceptance.md'), to: join(BUNDLE, 'docs', 'runtime-acceptance.md') },
]

// The templates are a directory of files, copied one for one.
const templateDir = join(KIT, 'templates')
for (const name of existsSync(templateDir) ? readdirSync(templateDir) : []) {
  COPIES.push({ from: join(templateDir, name), to: join(BUNDLE, 'templates', name) })
}

if (COPIES.some((entry) => !existsSync(entry.from))) {
  process.stderr.write('cannot run: a kit original is missing.\n')
  process.exit(2)
}

if (SYNC) {
  for (const { from, to } of COPIES) {
    cpSync(from, to)
    process.stdout.write(`synced ${relative(REPO, to)}\n`)
  }
  process.exit(0)
}

/** @type {string[]} */
const drifted = []
for (const { from, to } of COPIES) {
  const label = relative(REPO, to)
  if (!existsSync(to)) {
    drifted.push(`${label} — MISSING from the bundle; it would be absent from the published tarball`)
    continue
  }
  if (!statSync(to).isFile()) continue
  if (readFileSync(from, 'utf8') !== readFileSync(to, 'utf8')) {
    drifted.push(`${label} — differs from ${relative(REPO, from)}`)
  }
}

// A copy the bundle ships but declares nowhere is absent from the tarball: `files` decides what ships.
const declared = JSON.parse(readFileSync(join(BUNDLE, 'package.json'), 'utf8')).files ?? []
for (const required of ['sop', 'templates', 'scripts', 'skills', 'docs']) {
  if (!declared.includes(required)) {
    drifted.push(`bundle/package.json files[] does not include "${required}" — it would not ship`)
  }
}

for (const line of drifted) process.stderr.write(`error: ${line}\n`)

if (drifted.length > 0) {
  process.stderr.write(`\n✗ ${drifted.length} shipped copy problem(s). Fix the KIT's file, then: node scripts/check-shipped-copies.mjs --sync\n`)
  process.exit(1)
}

process.stdout.write(`✓ ${COPIES.length} shipped copies match the kit, and every shipped directory is declared.\n`)
