#!/usr/bin/env node
/**
 * Assert that every document claiming to list the tools lists the tools that exist.
 *
 * The plugin's tool set is written down in three places, and only one of them is code:
 *
 *   - `bundle/src/tools.ts` + `promote.ts`   the registrations — the definition
 *   - `bundle/README.md`                     what a user reads on npm
 *   - `registry/plugin-metadata.json`        the field set proposed for the entry format
 *
 * Both of the prose copies had drifted: the README listed five of nine, and the metadata six of nine, each
 * missing the tools added last. Neither drift was visible anywhere — `check-readme-status.mjs` pins the
 * claim table and `check-shipped-copies.mjs` pins the SOP and templates, but nothing compared a tool list to
 * the registrations, so a tool could be added and never documented. Both omissions were found by reading,
 * which is not a mechanism.
 *
 * **Two documents are deliberately excluded, and adding them here would be wrong:**
 *
 *   - `bundle/skills/**\/SKILL.md` is a procedure, not a list. It gives a section to the tools a run *must*
 *     call — `verify` after every edit, `promote` to freeze a live dynamic package — and mentions the rest
 *     only in passing, where a step happens to reach for one. Comparing it to the registrations would
 *     demand it document tools it has no reason to name.
 *   - `kit/HARNESS.md` and `kit/guides/**` are the manual SOP. They name a tool where the manual path
 *     reaches one, which is incidental rather than a list.
 *
 * Fixing a mismatch: add the tool to the document, not to a list of expectations here. If a tool is genuinely
 * undocumented, the document is what is wrong.
 *
 * Usage: node scripts/check-tool-lists.mjs
 * Exit codes: 0 every list matches the registrations · 1 one does not · 2 could not run
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const BUNDLE = join(REPO, 'bundle')

const SOURCES = [join(BUNDLE, 'src', 'tools.ts'), join(BUNDLE, 'src', 'promote.ts')]
const README = join(BUNDLE, 'README.md')
const METADATA = join(REPO, 'registry', 'plugin-metadata.json')

for (const path of [...SOURCES, README, METADATA]) {
  if (!existsSync(path)) {
    process.stderr.write(`cannot run: ${path} is missing.\n`)
    process.exit(2)
  }
}

/**
 * The registered tool names, read from the source that registers them.
 *
 * A regex over the source rather than an import: importing would pull in `@deepseek-ai/dsh-tools` and
 * `cordis`, and this check has to run on a fresh checkout with nothing installed. The pattern is the
 * `defineTool({ name: '...' })` call, so a tool registered without one is not a tool.
 */
const registered = []
for (const path of SOURCES) {
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(/name:\s*'(plugin_anything_[a-z_]+)'/g)) {
    if (!registered.includes(match[1])) registered.push(match[1])
  }
}

if (registered.length === 0) {
  process.stderr.write('cannot run: no tool registrations were found in bundle/src — the pattern has moved.\n')
  process.exit(2)
}

/** @type {string[]} */
const problems = []

/** Report the difference between a document's list and the registrations, in both directions. */
function compare(label, documented) {
  const missing = registered.filter((name) => !documented.includes(name))
  const extra = documented.filter((name) => !registered.includes(name))
  for (const name of missing) problems.push(`${label} does not mention \`${name}\`, which is registered`)
  for (const name of extra) problems.push(`${label} mentions \`${name}\`, which nothing registers`)
}

// `bundle/README.md` — the rows of the Tools table.
const readmeText = readFileSync(README, 'utf8')
const readmeTools = []
for (const line of readmeText.split('\n')) {
  const match = line.match(/^\|\s*`(plugin_anything_[a-z_]+)`/)
  if (match && !readmeTools.includes(match[1])) readmeTools.push(match[1])
}
compare('bundle/README.md', readmeTools)

// `registry/plugin-metadata.json` — the tools array, and the two counts derived from it.
const metadata = JSON.parse(readFileSync(METADATA, 'utf8'))
const metadataTools = (metadata.tools ?? []).map((entry) => entry.name)
compare('registry/plugin-metadata.json', metadataTools)

for (const entry of metadata.tools ?? []) {
  if (typeof entry.purpose !== 'string' || entry.purpose.trim() === '') {
    problems.push(`registry/plugin-metadata.json: \`${entry.name}\` has no purpose — the file's stated value is the list *with purposes*`)
  }
}

// A count that disagrees with the array it counts is worse than no count: it reads as authoritative.
if (metadata.toolCount !== metadataTools.length) {
  problems.push(`registry/plugin-metadata.json: toolCount is ${metadata.toolCount} but tools[] holds ${metadataTools.length}`)
}
const unconditional = (metadata.tools ?? []).filter((entry) => entry.conditional === undefined).length
if (metadata.toolCountWithoutCordisRuntime !== unconditional) {
  problems.push(
    `registry/plugin-metadata.json: toolCountWithoutCordisRuntime is ${metadata.toolCountWithoutCordisRuntime} `
    + `but ${unconditional} of ${metadataTools.length} entries are unconditional`,
  )
}

for (const line of problems) process.stderr.write(`error: ${line}\n`)

if (problems.length > 0) {
  process.stderr.write(
    `\n✗ ${problems.length} tool-list problem(s). Add the tool to the document — an undocumented tool is the defect.\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `✓ ${registered.length} registered tools, matching bundle/README.md and registry/plugin-metadata.json.\n`,
)
