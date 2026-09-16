/**
 * End-to-end test of the generation pipeline: render a bundle from the kit's real templates, then run the
 * kit's real static gate over it.
 *
 * This is the test that ties the two halves of the repository together. The unit tests prove the renderer
 * is self-consistent; this proves the templates it renders actually satisfy the gate, so a template edit
 * that breaks the contract fails here rather than in a user's profile.
 *
 * Run: node --experimental-strip-types --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DSH_RANGE, renderBundle } from '../src/scaffold.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const KIT = join(REPO, 'kit')
const VERIFIER = join(KIT, 'scripts', 'verify-plugin.mjs')

const TEMPLATES = [
  'package.json.template',
  'cordis.patch.yml.template',
  'index.ts.template',
  'provider.ts.template',
  'tool.ts.template',
  'tsconfig.json.template',
  'tsdown.config.ts.template',
]

/** The spec the committed example is generated from. Kept identical to `scripts/render-example.mjs`. */
const SPEC = {
  target: 'git',
  description: 'Inspect a git repository: status, history, and diffs.',
  executable: 'git',
  dshRange: DEFAULT_DSH_RANGE,
  tools: [
    { name: 'git_status', description: 'Show the working tree status of a repository.', subcommand: 'status' },
    { name: 'git_log', description: 'List recent commits from a repository.', subcommand: 'log' },
    { name: 'git_diff', description: 'Show the diff for a repository.', subcommand: 'diff' },
  ],
}

/**
 * Load the real templates.
 * @returns template filename to text.
 */
function loadTemplates() {
  const loaded = {}
  for (const name of TEMPLATES) loaded[name] = readFileSync(join(KIT, 'templates', name), 'utf8')
  return loaded
}

/**
 * Render the example into a fresh temp directory.
 * @param {Record<string, string>} [mutations] - relative path to replacement contents; `null` deletes.
 * @returns {string} the bundle root.
 */
function renderToTemp(mutations = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dpa-pipeline-'))
  const files = renderBundle(SPEC, loadTemplates())
  for (const file of files) {
    const mutation = mutations[file.path]
    const destination = join(root, file.path)
    mkdirSync(dirname(destination), { recursive: true })
    if (mutation === null) continue
    writeFileSync(destination, mutation ?? file.contents)
  }
  return root
}

/**
 * Run the kit's verifier over a directory.
 * @param {string} dir - the bundle root.
 * @returns {{status: number, stderr: string, stdout: string}} the run result.
 */
function verify(dir) {
  const result = spawnSync(process.execPath, [VERIFIER, dir], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

test('a bundle rendered from the real templates passes the real gate', () => {
  const root = renderToTemp()
  try {
    const { status, stdout, stderr } = verify(root)
    assert.equal(status, 0, `rendered bundle failed the gate:\n${stdout}\n${stderr}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the committed example matches what the templates currently render', () => {
  // Without this, the example silently drifts from the template it claims to demonstrate, and CI keeps
  // validating a stale artifact.
  const committed = resolve(REPO, 'examples', 'dsh-plugin-git')
  const rendered = renderBundle(SPEC, loadTemplates())
  for (const file of rendered) {
    const onDisk = readFileSync(join(committed, file.path), 'utf8')
    assert.equal(onDisk, file.contents, `${file.path} has drifted; re-run scripts/render-example.mjs git`)
  }
})

test('the gate rejects the rendered bundle when its patch is renamed', () => {
  const root = renderToTemp({
    'cordis.patch.yml': null,
    'patch.yml': '- insert:\n    - id: git\n      name: dsh-plugin-git\n',
  })
  try {
    // The manifest still points at ./cordis.patch.yml, which now does not exist.
    const { status, stderr } = verify(root)
    assert.equal(status, 1)
    assert.match(stderr, /does not exist|must contain "cordis"/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the gate rejects the rendered bundle when the manifest loses its bundle declaration', () => {
  const root = renderToTemp()
  try {
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    delete manifest.dsh
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2))
    const { status, stderr } = verify(root)
    assert.equal(status, 1)
    assert.match(stderr, /dsh\.bundle\.patch/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the gate rejects a rendered entry when a default export is added', () => {
  const root = renderToTemp()
  try {
    const entryPath = join(root, 'src', 'index.ts')
    writeFileSync(entryPath, `${readFileSync(entryPath, 'utf8')}\nexport default { name: 'git' }\n`)
    const { status, stderr } = verify(root)
    assert.equal(status, 1)
    assert.match(stderr, /discards the function plugin's namespace/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the rendered entry wires every tool the spec declares', () => {
  // The count is what a placeholder-based template gets wrong: three tools must produce three imports and
  // three registrations, with identifiers derived rather than substituted.
  const root = renderToTemp()
  try {
    const entry = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
    for (const tool of SPEC.tools) {
      const pascal = tool.name.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
      assert.match(entry, new RegExp(`import \\{ apply${pascal}Tool \\}`))
      assert.match(entry, new RegExp(`apply${pascal}Tool\\(ctx, options\\)`))
    }
    assert.ok(!entry.includes('{{'), 'the rendered entry still contains a placeholder')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
