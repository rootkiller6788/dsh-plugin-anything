/**
 * Acceptance tests for `scripts/verify-plugin.mjs`.
 *
 * Every check the verifier implements is exercised twice: once against a plugin that should pass, and
 * once against a single-field mutant that should fail with a specific message. A gate that has never
 * been observed rejecting anything is not evidence.
 *
 * Runs on `node --test` with no dependencies.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERIFIER = resolve(HERE, '..', 'scripts', 'verify-plugin.mjs')

/** The valid baseline: a correct minimal bundle. Mutations are applied on top of this. */
const BASELINE = {
  'package.json': JSON.stringify({
    name: 'dsh-plugin-widget',
    version: '0.1.0',
    type: 'module',
    main: 'index.js',
    files: ['index.js', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2),
  'cordis.patch.yml': [
    '# a comment is fine, an all-comment file is not',
    '- insert:',
    '    - id: widget',
    "      name: 'dsh-plugin-widget'",
    '      config:',
    '        verbosity: 3',
    '',
  ].join('\n'),
  'index.js': [
    "export const name = 'widget'",
    'export const inject = []',
    'export function apply() {}',
    '',
  ].join('\n'),
}

/**
 * Materialize the baseline plus mutations into a fresh temp directory.
 * @param {Record<string, string>} mutations - path → contents; a `null` value deletes the file.
 * @returns {string} the directory path.
 */
function fixture(mutations = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dpa-verify-'))
  const files = { ...BASELINE, ...mutations }
  for (const [rel, contents] of Object.entries(files)) {
    if (contents === null) continue
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  return dir
}

/**
 * Run the verifier against a directory.
 * @param {string} dir - the plugin directory.
 * @returns {{status: number, stderr: string, stdout: string}} the run result.
 */
function run(dir) {
  const result = spawnSync(process.execPath, [VERIFIER, dir], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

test('accepts the baseline bundle', () => {
  const dir = fixture()
  try {
    const { status, stdout } = run(dir)
    assert.equal(status, 0, `expected a pass, got:\n${stdout}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects a patch file whose name does not contain "cordis"', () => {
  const dir = fixture({
    'patch.yml': BASELINE['cordis.patch.yml'],
    'cordis.patch.yml': null,
    'package.json': BASELINE['package.json'].replace('./cordis.patch.yml', './patch.yml'),
  })
  try {
    const { status, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stderr, /must contain "cordis"/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects a missing dsh.bundle.patch declaration', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ name: 'dsh-plugin-widget', version: '0.1.0', type: 'module' }),
  })
  try {
    const { status, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stderr, /missing dsh\.bundle\.patch/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects a comments-only patch, which parses to nothing and throws at boot', () => {
  const dir = fixture({ 'cordis.patch.yml': '# nothing here\n\n' })
  try {
    const { status, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stderr, /empty or comments-only/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects a patch whose root is not a YAML array', () => {
  const dir = fixture({ 'cordis.patch.yml': 'insert:\n  - id: widget\n' })
  try {
    const { status, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stderr, /must be a top-level YAML array/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects !!js outside config and disabled', () => {
  const dir = fixture({
    'cordis.patch.yml': [
      '- insert:',
      "    - id: !!js process.env.WIDGET_ID",
      "      name: 'dsh-plugin-widget'",
      '',
    ].join('\n'),
  })
  try {
    const { status, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stderr, /not interpolated there/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('accepts !!js under config', () => {
  const dir = fixture({
    'cordis.patch.yml': [
      '- insert:',
      "    - id: widget",
      "      name: 'dsh-plugin-widget'",
      '      config:',
      '        verbosity: !!js process.env.WIDGET_VERBOSITY',
      '',
    ].join('\n'),
  })
  try {
    const { status, stdout } = run(dir)
    assert.equal(status, 0, `expected a pass, got:\n${stdout}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects a bare row name that is not declared in dependencies', () => {
  const dir = fixture({
    'cordis.patch.yml': [
      '- insert:',
      "    - id: widget",
      "      name: 'some-undeclared-package'",
      '',
    ].join('\n'),
  })
  try {
    const { status, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stderr, /must be declared in dependencies/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('accepts a bare row name that IS declared in dependencies', () => {
  const dir = fixture({
    'package.json': JSON.stringify({
      name: 'dsh-plugin-widget',
      version: '0.1.0',
      type: 'module',
      main: 'index.js',
      files: ['index.js', 'cordis.patch.yml'],
      dependencies: { 'some-package': '^1.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
    'cordis.patch.yml': '- insert:\n    - id: widget\n      name: some-package\n',
  })
  try {
    const { status, stdout } = run(dir)
    assert.equal(status, 0, `expected a pass, got:\n${stdout}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects a function plugin that also has a default export', () => {
  const dir = fixture({
    'index.js': "export const name = 'widget'\nexport function apply() {}\nexport default { name: 'widget' }\n",
  })
  try {
    const { status, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stderr, /discards the function plugin's namespace/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects an impure presenter', () => {
  const dir = fixture({
    'index.js': [
      "export const name = 'widget'",
      'export function apply() {}',
      'const presentCall = (args) => ({',
    ].join('\n'),
  })
  // The purity check inspects `presentCall(...) { ... }` method bodies, i.e. inside a definition
  // object. Build that shape explicitly.
  writeFileSync(join(dir, 'index.js'), [
    "export const name = 'widget'",
    'export function apply(ctx) {',
    '  ctx.tools.register({',
    "    name: 'widget_do',",
    '    presentCall(args) {',
    '      return { card: "generic", title: `${Date.now()}` }',
    '    },',
    '  })',
    '}',
    '',
  ].join('\n'))
  try {
    const { status, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stderr, /presenters must be pure/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects a built package that does not export its patch', () => {
  const dir = fixture({
    'package.json': JSON.stringify({
      name: 'dsh-plugin-widget',
      version: '0.1.0',
      type: 'module',
      main: 'lib/index.js',
      files: ['lib/index.js', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  })
  try {
    const { status, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stderr, /exports\["\.\/cordis\.patch\.yml"\] is not declared/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
