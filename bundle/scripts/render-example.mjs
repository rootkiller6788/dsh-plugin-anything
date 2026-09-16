#!/usr/bin/env node
/**
 * Render a bundle from the kit's real templates, without a dsh runtime.
 *
 * The bundle's tools need `@deepseek-ai/*` to load, but its rendering is pure — so this script is how the
 * templates get exercised end to end on a machine that has nothing installed. It produces the same file
 * plan `plugin_anything_scaffold` produces, and CI feeds its output straight to the static gate.
 *
 * Usage: node --experimental-strip-types scripts/render-example.mjs <target> <output-parent>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DSH_RANGE, renderBundle } from '../src/scaffold.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KIT = resolve(HERE, '..', '..', 'kit')

/** The spec for the committed example: a real target, with tools grouped by intent. */
const EXAMPLES = {
  git: {
    target: 'git',
    description: 'Inspect a git repository: status, history, and diffs.',
    executable: 'git',
    dshRange: DEFAULT_DSH_RANGE,
    tools: [
      { name: 'git_status', description: 'Show the working tree status of a repository.', subcommand: 'status' },
      { name: 'git_log', description: 'List recent commits from a repository.', subcommand: 'log' },
      { name: 'git_diff', description: 'Show the diff for a repository.', subcommand: 'diff' },
    ],
  },
}

const TEMPLATES = [
  'package.json.template',
  'cordis.patch.yml.template',
  'index.ts.template',
  'provider.ts.template',
  'tool.ts.template',
  'tsconfig.json.template',
  'tsdown.config.ts.template',
]

const target = process.argv[2]
const outputParent = process.argv[3] ?? resolve(HERE, '..', '..', 'examples')

const spec = EXAMPLES[target]
if (spec === undefined) {
  process.stderr.write(`unknown example: ${target ?? '(none)'}. known: ${Object.keys(EXAMPLES).join(', ')}\n`)
  process.exit(2)
}

const templates = {}
for (const name of TEMPLATES) {
  templates[name] = await readFile(resolve(KIT, 'templates', name), 'utf8')
}

const root = resolve(outputParent, `dsh-plugin-${spec.target}`)
const files = renderBundle(spec, templates)
for (const file of files) {
  const destination = resolve(root, file.path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, file.contents, 'utf8')
}

process.stdout.write(`rendered ${files.length} file(s) to ${root}\n`)
for (const file of files) process.stdout.write(`  + ${file.path}\n`)
