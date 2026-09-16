/**
 * Packaging: does the artifact contain what the manifest promised?
 *
 * The failure this guards against has no local symptom. A `files` list that omits a directory the code
 * reads produces a package that builds, passes every gate, boots in the author's profile — and fails for
 * every user who installed it. This project shipped exactly that: `sop`, `templates`, `scripts`, and `docs`
 * were missing from `files` while `plugin_anything_scaffold` and `plugin_anything_verify` read them.
 *
 * Run: node --experimental-strip-types --test tests/pack.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { judgePackage, judgeSupplyChain, matchesEntry, parsePackList } from '../src/pack.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')

/** Build a packaged-file list from paths. */
const files = (...paths) => paths.map((path) => ({ path, size: 10 }))

test('a declared directory covers everything under it', () => {
  assert.ok(matchesEntry('templates', 'templates/a.md'))
  assert.ok(matchesEntry('templates', 'templates/nested/b.md'))
  assert.ok(!matchesEntry('templates', 'templatesX/a.md'), 'a prefix is not a directory')
})

test('a declared file matches only itself', () => {
  assert.ok(matchesEntry('cordis.patch.yml', 'cordis.patch.yml'))
  assert.ok(!matchesEntry('cordis.patch.yml', 'other/cordis.patch.yml'))
})

test('a glob matches at its own depth', () => {
  assert.ok(matchesEntry('lib/types/**/*.d.ts', 'lib/types/a.d.ts'))
  assert.ok(matchesEntry('lib/types/**/*.d.ts', 'lib/types/x/y.d.ts'))
  assert.ok(!matchesEntry('lib/types/**/*.d.ts', 'lib/index.js'))
})

test('a missing declared entry fails, and is named', () => {
  // The defect this module exists for. `templates` is promised and absent: a user installing this package
  // gets `plugin_anything_scaffold` failing with "missing template", which is what happened here for real.
  const verdict = judgePackage(['lib/index.js', 'templates'], files('lib/index.js'))
  assert.equal(verdict.verdict, 'fail')
  assert.deepEqual(verdict.missing, ['templates'])
  assert.match(verdict.detail, /installed copy would fail/)
})

test('every declared entry present passes', () => {
  const verdict = judgePackage(['lib/index.js', 'templates'], files('lib/index.js', 'templates/a.md'))
  assert.equal(verdict.verdict, 'pass')
  assert.deepEqual(verdict.missing, [])
})

test('a manifest with no files list is reported, not silently passed', () => {
  // With no `files`, npm ships whatever it finds, so there is nothing to compare. Calling that a clean pass
  // would be the same defect one level up: a check reporting success for having checked nothing.
  const verdict = judgePackage(undefined, files('a.js'))
  assert.equal(verdict.verdict, 'pass')
  assert.match(verdict.detail, /no files\[\] list to check against/)

  const empty = judgePackage([], files('a.js'))
  assert.match(empty.detail, /no files\[\] list/)
})

test('always-included files are not called unexpected', () => {
  // npm adds these whether or not `files` names them, so flagging them would train a reader to ignore the
  // field that matters.
  const verdict = judgePackage(['lib/index.js'], files('lib/index.js', 'package.json', 'README.md', 'LICENSE'))
  assert.deepEqual(verdict.unexpected, [])
})

test('a file nothing declares is named as unexpected, without failing', () => {
  const verdict = judgePackage(['lib/index.js'], files('lib/index.js', 'stray.txt'))
  assert.equal(verdict.verdict, 'pass')
  assert.deepEqual(verdict.unexpected, ['stray.txt'])
})

test('parses the npm pack listing', () => {
  const listing = parsePackList(JSON.stringify([{
    filename: 'widget-1.0.0.tgz',
    size: 2048,
    files: [{ path: 'package.json', size: 100 }, { path: 'lib/index.js', size: 1948 }],
  }]))
  assert.equal(listing.filename, 'widget-1.0.0.tgz')
  assert.deepEqual(listing.files.map((f) => f.path), ['package.json', 'lib/index.js'])
})

test('a malformed pack listing throws rather than yielding an empty artifact', () => {
  // An empty file list would make every declared entry look missing, reporting a flood of defects that are
  // really a parsing failure. Failing here puts the blame in the right place.
  assert.throws(() => parsePackList('not json'), /did not print JSON/)
  assert.throws(() => parsePackList(JSON.stringify([{ files: [] }])), /no filename/)
})

// ── The supply-chain pass ────────────────────────────────────────────────────────────────────────────

test('an install-time script is reported, because it runs on someone else\'s machine', () => {
  // This project already tells users in the distribution guide that a `prepare` script is permission to run
  // code at install time. Making them work that out from a manifest is the gap this closes.
  const report = judgeSupplyChain({ scripts: { prepare: 'node build.mjs' } })
  assert.deepEqual(report.blockers, [])
  assert.ok(report.notes.some((n) => /prepare.*runs on the installing machine/.test(n)))
})

test('a remote or local dependency blocks a release', () => {
  // A remote dependency is code that changes without a version change; a local path will not exist for
  // anyone else — and both install code or fail at the user's end.
  const remote = judgeSupplyChain({ dependencies: { widget: 'git+https://github.com/x/y.git' } })
  assert.equal(remote.blockers.length, 1)
  assert.match(remote.blockers[0], /remote dependency/)

  const local = judgeSupplyChain({ dependencies: { widget: 'link:../widget' } })
  assert.ok(local.blockers.some((b) => /local path cannot resolve/.test(b)))
})

test('a floating version spec is a note, not a blocker', () => {
  // `latest` is a real supply-chain surface but not a defect on its own; blocking it would train a reader to
  // ignore the field.
  const report = judgeSupplyChain({ dependencies: { widget: 'latest' } })
  assert.deepEqual(report.blockers, [])
  assert.ok(report.notes.some((n) => /pinned to "latest"/.test(n)))
})

test('private:true on a plugin manifest blocks', () => {
  const report = judgeSupplyChain({ private: true })
  assert.ok(report.blockers.some((b) => /belongs on a profile manifest/.test(b)))
})

test('a clean manifest passes the scan silently', () => {
  assert.deepEqual(judgeSupplyChain({ scripts: { build: 'tsc -b . && tsdown' } }), { blockers: [], notes: [] })
})

test('this bundle has no supply-chain blockers of its own', () => {
  // The artifact is held to the check it applies to others.
  const manifest = JSON.parse(readFileSync(join(BUNDLE, 'package.json'), 'utf8'))
  const report = judgeSupplyChain(manifest)
  assert.deepEqual(report.blockers, [], `this package would be blocked: ${report.blockers.join('; ')}`)
})

// ── Against the real bundle ──────────────────────────────────────────────────────────────────────────

test('this package ships everything its own code reads', { skip: !existsSync(join(BUNDLE, 'node_modules')) ? 'run pnpm install first' : false }, () => {
  // The strongest form of the check: pack the real bundle and compare against the real manifest. A synthetic
  // listing proves the matcher; this proves the package.
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: BUNDLE, encoding: 'utf8', shell: process.platform === 'win32',
  })
  assert.equal(result.status, 0, `npm pack --dry-run failed: ${result.stderr}`)

  const listing = parsePackList(result.stdout)
  const manifest = JSON.parse(readFileSync(join(BUNDLE, 'package.json'), 'utf8'))
  const verdict = judgePackage(manifest.files, listing.files)

  assert.equal(
    verdict.verdict,
    'pass',
    `this package would ship without ${verdict.missing.join(', ')} — installed copies would fail wherever `
    + 'the code reads them',
  )
  // And the directories the tools read at runtime are genuinely among what ships.
  const shipped = new Set(listing.files.map((f) => f.path))
  for (const required of ['templates/package.json.template', 'scripts/verify-plugin.mjs', 'sop/SOP.md', 'skills/dsh-plugin-anything-bundle/SKILL.md']) {
    assert.ok(shipped.has(required), `${required} does not ship, so an installed copy cannot read it`)
  }
  // `LICENSE` is not read by any code, which is exactly why it needs a test: nothing would notice it
  // dropping out of the tarball. The package declares MIT, so the text has to be in there.
  assert.ok(shipped.has('LICENSE'), 'LICENSE does not ship, so the package asserts MIT without carrying it')
})
