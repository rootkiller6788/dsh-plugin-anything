#!/usr/bin/env node
/**
 * Validate `registry/dsh-plugin-anything-bundle.yml` against the rules of the list it is destined for.
 *
 * `awesome-dsh-plugin` is an awesome-list whose README is generated from `data/plugins/*.yml`, and its
 * rules live in real code, not a schema: `CAT_IDS` and `slugFor` in `scripts/lib/entries.mjs`, plus the
 * requirements in `contributing.md`.
 *
 * This script reads those two definitions **out of the upstream source text and evaluates them**, rather
 * than importing the module or copying the values. Importing would fail — that module's own top-level
 * `import yaml from 'js-yaml'` does not resolve without the upstream's `npm ci`. Copying would be worse:
 * a copy silently agrees with whatever it was copied from, which is the exact failure this project has
 * already been bitten by twice. Reading the source means an upstream change shows up here as a failure.
 *
 * Usage: node scripts/validate-registry-entry.mjs [--upstream <path>]
 * Exit codes: 0 valid · 1 invalid · 2 could not run (upstream not found)
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const upstreamIndex = process.argv.indexOf('--upstream')
const UPSTREAM = upstreamIndex === -1
  ? 'D:/Opencode/dsh-plugin/awesome-dsh-plugin'
  : process.argv[upstreamIndex + 1]

const ENTRY_PATH = join(REPO, 'registry', 'dsh-plugin-anything-bundle.yml')

/** @type {string[]} */
const problems = []
/** @type {string[]} */
const blockers = []

if (!existsSync(UPSTREAM)) {
  process.stderr.write(
    `cannot run: the upstream list is not at ${UPSTREAM}.\n`
    + 'Pass --upstream <path> to point at a checkout of awesome-dsh-plugin.\n',
  )
  process.exit(2)
}

const upstreamSource = readFileSync(join(UPSTREAM, 'scripts', 'lib', 'entries.mjs'), 'utf8')

// ── Read the rules out of the upstream source ───────────────────────────────────────────────────────

/** The `CAT_IDS` array literal, verbatim. */
const catIdsMatch = /export const CAT_IDS = (\[[^\]]*\])/.exec(upstreamSource)
if (catIdsMatch === null) {
  process.stderr.write('cannot run: CAT_IDS not found in the upstream entries module. Its shape changed.\n')
  process.exit(2)
}
const upstreamCatIds = JSON.parse(catIdsMatch[1].replaceAll("'", '"'))

/**
 * The upstream `slugFor`, evaluated from its own source.
 *
 * `new Function` on a file this script already reads is acceptable here: the input is a local checkout of a
 * public list, the script is a developer tool, and the alternative is reimplementing the function — which
 * is the thing being avoided. `export` is stripped so the declaration can be evaluated as a body.
 */
const slugForMatch = /export function slugFor\(url\) \{([\s\S]*?)\n\}/.exec(upstreamSource)
if (slugForMatch === null) {
  process.stderr.write('cannot run: slugFor not found in the upstream entries module. Its shape changed.\n')
  process.exit(2)
}
const upstreamSlugFor = new Function('url', slugForMatch[1])

process.stdout.write(`rule source: ${join(UPSTREAM, 'scripts/lib/entries.mjs')}\n`)
process.stdout.write(`  CAT_IDS: ${upstreamCatIds.length} categories\n`)
process.stdout.write(`  slugFor: evaluated from source\n\n`)

// ── A deliberately small reader for this one file's shape ───────────────────────────────────────────
//
// Not a YAML parser. It handles the subset this entry uses — top-level `key: value`, and a nested
// `description:` block — and it fails loud on anything it does not understand rather than guessing.
const text = readFileSync(ENTRY_PATH, 'utf8')
/** @type {Record<string, string>} */ const fields = {}
/** @type {Record<string, string>} */ const description = {}
let inDescription = false
for (const rawLine of text.split('\n')) {
  if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue
  const indented = /^\s/.test(rawLine)
  const match = /^(\s*)([a-zA-Z_][\w-]*):\s*(.*)$/.exec(rawLine)
  if (match === null) {
    problems.push(`unparsed line: ${rawLine.trim().slice(0, 60)}`)
    continue
  }
  const [, indent, key, rawValue] = match
  const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2')
  if (indent === '' && key === 'description' && value === '') { inDescription = true; continue }
  if (indent === '') { inDescription = false; fields[key] = value; continue }
  if (inDescription) description[key] = value
}

// ── The rules ───────────────────────────────────────────────────────────────────────────────────────

const REQUIRED = ['url', 'name', 'category', 'description']
for (const key of REQUIRED) {
  const present = key === 'description' ? Object.keys(description).length > 0 : (fields[key] ?? '') !== ''
  if (!present) problems.push(`missing required field: ${key}`)
}

if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(fields.url ?? '')) {
  problems.push('"url" must be a https://github.com/owner/repo link')
}

if (!(description.en ?? '').trim()) {
  problems.push('"description.en" is required and must be non-empty')
} else if ((description.en ?? '').includes('\n')) {
  problems.push('"description.en" must be a single line')
}

if (!upstreamCatIds.includes(fields.category)) {
  problems.push(`"category" must be one of ${upstreamCatIds.join(', ')} — got ${JSON.stringify(fields.category)}`)
}

// The filename rule, computed by the upstream implementation rather than by a copy of it.
const expectedName = `${upstreamSlugFor(fields.url ?? '')}.yml`
// `basename`, not a string split: on Windows the separator is `\`, so splitting on `/` yields the whole
// path and the comparison below silently compares the wrong thing. The first version of this script did
// exactly that.
const actualName = basename(ENTRY_PATH)

/** Whether the url is still the placeholder, which decides how a filename mismatch is reported. */
const placeholderUrl = /\/OWNER\//.test(fields.url ?? '')

if (expectedName !== actualName) {
  // A mismatch has two very different causes and reporting them the same way would be misleading. With a
  // placeholder url the expected name is derived from the placeholder, so the mismatch is a symptom of the
  // unfinished url — not a second mistake. With a real url it is a genuine format error.
  const message = `filename must equal slugFor(url): expected ${expectedName}, found ${actualName}`
  if (placeholderUrl) blockers.push(`${message} — follows from the placeholder url below`)
  else problems.push(message)
}

// ── Submission blockers, which are not format problems ──────────────────────────────────────────────
//
// These are the requirements in `contributing.md` that the file itself cannot satisfy. They are reported
// separately: a format failure means the entry is wrong, a blocker means the repository is not ready.
if (placeholderUrl) {
  blockers.push('`url` is still the placeholder — no public repository exists for this plugin yet')
}
blockers.push('the repository must be at least 1 day old with at least 10 commits (check-submission.mjs: MIN_AGE_DAYS = 1, MIN_COMMITS = 10)')
blockers.push('the repository must carry the `dsh-plugin` GitHub topic')
blockers.push('the PR must also regenerate and commit both READMEs: `npm ci && node scripts/generate-readme.mjs`')

// ── Report ──────────────────────────────────────────────────────────────────────────────────────────

const metadata = JSON.parse(readFileSync(join(REPO, 'registry', 'plugin-metadata.json'), 'utf8'))
const entryCategory = fields.category
if (metadata.categoryRationale === undefined) {
  problems.push('plugin-metadata.json should state why this category was chosen')
}

for (const problem of problems) process.stderr.write(`error: ${problem}\n`)
process.stdout.write(`entry: ${actualName}\n`)
process.stdout.write(`  category: ${entryCategory} (of ${upstreamCatIds.length})\n`)
process.stdout.write(`  description: ${Object.keys(description).join(', ')}\n`)
process.stdout.write(`  tools declared in plugin-metadata.json: ${metadata.toolCount}\n\n`)

if (problems.length > 0) {
  process.stderr.write(`✗ ${problems.length} format error(s).\n`)
  process.exit(1)
}

process.stdout.write('✓ the entry satisfies every rule the list enforces mechanically.\n\n')
process.stdout.write('blocked on the repository, not the file:\n')
for (const blocker of blockers) process.stdout.write(`  • ${blocker}\n`)
process.stdout.write('\nSee registry/README.md.\n')
process.exit(0)
