#!/usr/bin/env node
/**
 * Static verification for a generated dsh plugin bundle (or for this kit itself).
 *
 * The authority on every rule enforced here is the dsh repo's own gate
 * (`scripts/verify-cordis-config.ts`, `scripts/check-workspace-constraints.ts`) plus a real
 * `dsh --profile <p> --dump-config`. This script exists because that gate only runs inside the dsh
 * monorepo and therefore never sees a plugin authored here. It is a static approximation: it catches
 * the mistakes that fail silently, and it never claims a plugin boots.
 *
 * Deliberately dependency-free so it runs on a fresh checkout with nothing installed.
 *
 * Usage:
 *   node scripts/verify-plugin.mjs <plugin-dir>...
 *   node scripts/verify-plugin.mjs --kit          # verify this kit's own structure
 *
 * Exit codes: 0 ok · 1 verification failure · 2 usage error
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KIT_ROOT = resolve(HERE, '..')
/** The repository root, one level above this kit. */
const REPO_ROOT = resolve(KIT_ROOT, '..')

/** @type {string[]} */ const errors = []
/** @type {string[]} */ const warnings = []

/**
 * Record a verification failure.
 * @param {string} message - what failed.
 */
const fail = (message) => { errors.push(message) }

/**
 * Record a non-fatal finding worth reporting.
 * @param {string} message - what to flag.
 */
const warn = (message) => { warnings.push(message) }

/**
 * Read a file, or return undefined when it is absent.
 * @param {string} path - absolute file path.
 * @returns {string | undefined} the UTF-8 contents.
 */
function readIfPresent(path) {
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
}

/**
 * Read and parse a JSON file.
 * @param {string} path - absolute file path.
 * @param {string} label - shown in the failure message.
 * @returns {any | undefined} the parsed value.
 */
function readJson(path, label) {
  const text = readIfPresent(path)
  if (text === undefined) { fail(`${label}: missing ${path}`); return undefined }
  try { return JSON.parse(text) } catch (cause) {
    fail(`${label}: ${basename(path)} is not valid JSON — ${cause.message}`)
    return undefined
  }
}

/**
 * Strip YAML comments and blank lines, then test whether anything remains.
 * A patch that parses to nothing throws at boot, so an all-comments file is a failure, not a no-op.
 * @param {string} text - raw YAML.
 * @returns {string[]} the significant lines.
 */
function significantLines(text) {
  return text.split('\n').filter((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
}

/**
 * Verify one plugin directory.
 * @param {string} dir - the plugin package directory.
 */
function verifyPlugin(dir) {
  const label = basename(dir)
  const manifest = readJson(join(dir, 'package.json'), label)
  if (manifest === undefined) return

  // ── The dsh manifest section ────────────────────────────────────────────────────────────────────
  const patchRel = manifest.dsh?.bundle?.patch
  if (typeof patchRel !== 'string' || patchRel === '') {
    fail(`${label}: package.json is missing dsh.bundle.patch, so \`dsh plugin add\` installs it as a plain dependency and activates no layer`)
    return
  }

  const patchPath = join(dir, patchRel)
  const patchName = basename(patchRel)

  // Rule 1: the gate's discovery glob is **/*cordis*.yml|yaml. A differently named file is invisible.
  if (!patchName.includes('cordis')) {
    fail(`${label}: the patch file is named "${patchName}"; it must contain "cordis" or the gate's **/*cordis*.yml glob never sees it`)
  }
  if (!existsSync(patchPath)) {
    fail(`${label}: dsh.bundle.patch points at ${patchRel}, which does not exist`)
    return
  }

  // Rule: the patch must also be shipped. `files` decides what the tarball contains.
  const files = Array.isArray(manifest.files) ? manifest.files : []
  if (!files.includes(patchName)) {
    fail(`${label}: files[] does not include "${patchName}", so the published package would omit its own patch layer`)
  }

  // A built package (main under lib/) needs the patch exported, or Node cannot resolve it by subpath.
  if (typeof manifest.main === 'string' && manifest.main.startsWith('lib/')) {
    if (manifest.exports?.['./cordis.patch.yml'] === undefined) {
      fail(`${label}: main is a built path but exports["./cordis.patch.yml"] is not declared; a published bundle cannot resolve its patch by subpath without it`)
    }
  }

  // ── The patch contents ──────────────────────────────────────────────────────────────────────────
  const patchText = readFileSync(patchPath, 'utf8')
  const lines = significantLines(patchText)

  // An empty or comments-only patch parses to nothing, not to a list, and throws at boot.
  if (lines.length === 0) {
    fail(`${label}: ${patchName} is empty or comments-only; it parses to nothing and throws at boot. Use "[]" to disable the layer`)
  } else if (!lines[0].startsWith('- ') && lines[0] !== '[]') {
    fail(`${label}: ${patchName} must be a top-level YAML array; the first significant line is not a list item`)
  }

  // Rule 4: `!!js` is valid only under `config` (any depth) and as the value of `disabled`.
  //
  // Legality depends on the PATH from the entry root to the occurrence, not on the nearest key:
  // `config.verbosity: !!js …` is legal because `config` is an ancestor, even though the innermost key
  // is `verbosity`. Conversely `id: !!js …` is illegal — the entry metadata stays literal.
  //
  // The stack holds one {indent, key} per open mapping level at or above the current line.
  const LEGAL_OWNERS = new Set(['config', 'disabled'])
  /** @type {{indent: number, key: string}[]} */ const keyStack = []
  patchText.split('\n').forEach((raw, index) => {
    // Strip a trailing comment. Note this is a static approximation: a '#' inside a quoted !!js
    // expression would be truncated here, so the check errs toward silence rather than false failure.
    const withoutComment = raw.split('#')[0]
    if (withoutComment.trim() === '') return
    const indent = withoutComment.length - withoutComment.trimStart().length
    const body = withoutComment.trim()
    const match = /^(?:-\s+)?([A-Za-z_][\w-]*):/.exec(body)

    while (keyStack.length > 0 && keyStack[keyStack.length - 1].indent >= indent) keyStack.pop()
    if (match !== null) keyStack.push({ indent, key: match[1] })

    if (!withoutComment.includes('!!js')) return

    // Legal when this line's own key is config/disabled, or when any enclosing key is `config`.
    const ownsExpression = match !== null && LEGAL_OWNERS.has(match[1])
    const insideConfig = keyStack.some((frame) => frame.key === 'config')
    if (!ownsExpression && !insideConfig) {
      const where = match !== null ? `"${match[1]}"` : `"${keyStack[keyStack.length - 1]?.key ?? 'the patch root'}"`
      fail(`${label}:${index + 1}: !!js under ${where} is not interpolated there; it is valid only under config and as the value of disabled`)
    }
  })

  // Rule 3: a bare package name in a row must be declared in dependencies.
  const declared = new Set(Object.keys(manifest.dependencies ?? {}))
  const rowNames = [...patchText.matchAll(/^\s*-?\s*name:\s*['"]?([^'"\s#]+)['"]?/gm)].map((m) => m[1])
  for (const rowName of rowNames) {
    // A bundle naming ITSELF is the canonical case — a bundle patch mounts the package it ships in,
    // and a package does not depend on itself. This is what dsh-context-compressor's patch does.
    if (rowName === manifest.name) continue
    // A path-shaped name is legal to the Loader — `vendor/loader/src/config/tree.ts` imports it as
    // `new URL(name, baseUrl)` — and that is precisely the hazard. For a bundle patch, `baseUrl` is
    // set by app-boot to `dirname(absoluteConfigPath)`, which is the PROFILE directory, not this
    // package; so the row resolves somewhere the package is not and fails at boot, with nothing
    // pointing at the patch. This is the same baseUrl trap `kit/guides/skill-authoring.md` documents
    // for skill mounting. It was exempt here on the reasoning that "the dependencies rule does not
    // apply to a path", which is true and beside the point: no rule applied to it at all, while rule 2
    // of the shipped `cordis.patch.yml.template` declared this gate enforced it.
    if (rowName.startsWith('.') || rowName.startsWith('/')) {
      fail(`${label}: patch row names "${rowName}", which is a path — a path in a bundle patch resolves from the profile directory, not from this package, so the row fails at boot. Use the package name`)
      continue
    }
    // An in-box bundle name always resolves from the dsh installation itself.
    if (rowName.startsWith('@deepseek-ai/')) continue
    if (!declared.has(rowName)) {
      fail(`${label}: patch row names "${rowName}", which is not in package.json dependencies — the gate reports "must be declared in dependencies"`)
    }
  }

  // ── The plugin entry ────────────────────────────────────────────────────────────────────────────
  const entryCandidates = ['src/index.ts', 'index.js', 'index.mjs']
  const entry = entryCandidates.map((c) => join(dir, c)).find((p) => existsSync(p))
  if (entry === undefined) {
    fail(`${label}: no plugin entry found (looked for ${entryCandidates.join(', ')})`)
  } else {
    const source = readFileSync(entry, 'utf8')
    // A function plugin named-exports name/inject/Config/apply and has NO default export; mixing the
    // forms makes the Loader discard the function plugin's namespace.
    const isFunctionPlugin = /^export\s+(?:const|function)\s+(name|apply)\b/m.test(source)
    if (isFunctionPlugin && /^export\s+default\b/m.test(source)) {
      fail(`${label}: ${basename(entry)} is a function plugin (it exports name/apply) but also has a default export; the Loader discards the function plugin's namespace when the forms are mixed`)
    }
    if (isFunctionPlugin && !/^export\s+(?:const|function)\s+name\b/m.test(source)) {
      fail(`${label}: ${basename(entry)} exports apply but not name; the loader needs name for diagnostics`)
    }
  }

  // ── Presenter purity ────────────────────────────────────────────────────────────────────────────
  // Presenters run on live streaming AND on session-log replay, so an I/O call or a clock read inside
  // one makes replays nondeterministic.
  if (entry !== undefined) {
    const source = readFileSync(entry, 'utf8')
    const presenterBody = /present(?:Call|Result)\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/g
    for (const match of source.matchAll(presenterBody)) {
      const impure = /\b(Date\.now|Math\.random|readFileSync|writeFileSync|execSync|fetch\(|process\.env|new Date\()/.exec(match[1])
      if (impure !== null) {
        fail(`${label}: a presenter calls ${impure[1]}; presenters must be pure — they also run on replay`)
      }
    }
  }
}

/**
 * Walk every markdown file under `root` and check that each relative link target exists.
 *
 * Skips absolute URLs, in-page anchors, and anything inside a fenced code block — a link inside an example
 * is documentation about links, not a link.
 *
 * @param {string} root - the repository root.
 */
function verifyRelativeLinks(root) {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'coverage', 'examples'])
  /** @type {string[]} */
  const found = []
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(join(dir, entry.name))
      } else if (entry.name.endsWith('.md')) {
        found.push(join(dir, entry.name))
      }
    }
  }
  walk(root)

  for (const file of found) {
    const lines = readFileSync(file, 'utf8').split('\n')
    let inFence = false
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith('```')) { inFence = !inFence; return }
      if (inFence) return
      for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1]
        if (/^(?:[a-z]+:|\/|#)/i.test(target)) continue // absolute URL, root path, or anchor
        const path = decodeURIComponent(target.split('#')[0])
        if (path === '') continue
        if (!existsSync(resolve(dirname(file), path))) {
          fail(`${basename(root)}: ${file.slice(root.length + 1)}:${index + 1}: relative link does not resolve — ${target}`)
        }
      }
    })
  }
}

/**
 * Verify this kit's own structure.
 */
function verifyKit() {
  const required = [
    'HARNESS.md',
    'commands/plugin-anything.md',
    'commands/list.md',
    'commands/refine.md',
    'commands/test.md',
    'commands/validate.md',
    'templates/package.json.template',
    'templates/cordis.patch.yml.template',
    'templates/index.ts.template',
    'templates/provider.ts.template',
    'templates/tool.ts.template',
    'templates/tsconfig.json.template',
    'templates/tsdown.config.ts.template',
    'templates/SKILL.md.template',
    'guides/tool-contract.md',
    'guides/skill-authoring.md',
    'scripts/verify-plugin.mjs',
  ]
  for (const rel of required) {
    if (!existsSync(join(KIT_ROOT, rel))) fail(`kit: missing ${rel}`)
  }

  // The notes tree is the record of decisions the code cannot express. Its absence is a process failure,
  // not a formatting one, so it is checked rather than merely documented.
  const notesRoot = join(KIT_ROOT, '..', 'notes')
  if (!existsSync(notesRoot)) {
    fail('kit: missing notes/ — non-trivial decisions have nowhere to be recorded')
  } else if (!existsSync(join(notesRoot, 'README.md'))) {
    fail('kit: notes/README.md is missing; the layout convention is not documented where it is used')
  }

  // The repository declares MIT in its README, in the bundle it publishes, and in every manifest the
  // templates render. A declaration with no text behind it is the same class of gap the rest of this gate
  // exists to catch — and this one is worse than most, because GitHub's license detection reads this exact
  // path and nothing else: the repository would show no license to everyone except the people who could fix
  // it, and the published tarball would assert one it does not carry.
  //
  // The *content* is checked, not just the existence. A file named `LICENSE` holding some other license
  // passes an existence check while making the claim worse rather than better — the difference between an
  // unbacked assertion and a contradicted one. This is a shape check, not legal review: it can tell that the
  // text is MIT, and cannot tell whether the holder is the right one to grant it.
  const license = readIfPresent(join(REPO_ROOT, 'LICENSE')) ?? ''
  const licenseIsMit = /^MIT License$/m.test(license) && license.includes('WITHOUT WARRANTY OF ANY KIND')
  if (license === '') {
    fail('kit: LICENSE is missing; the repository declares MIT and ships no license text')
  } else if (!licenseIsMit) {
    fail('kit: LICENSE does not read as MIT, but the README and the published manifest both declare MIT')
  }

  // The declaration and the text live in different files, and only one of them ships. `bundle/package.json`
  // is in the tarball, so a mismatch here means a published package asserting a license it does not carry —
  // a contradiction no other check in this repository would see.
  const bundleManifest = join(REPO_ROOT, 'bundle', 'package.json')
  const declaredLicense = existsSync(bundleManifest)
    ? JSON.parse(readFileSync(bundleManifest, 'utf8')).license
    : undefined
  if (declaredLicense !== 'MIT') {
    fail(`kit: bundle/package.json declares ${JSON.stringify(declaredLicense)}; the LICENSE file is MIT`)
  }

  // Relative markdown links must resolve. This was added the moment it was needed: renaming a note left a
  // link pointing at the old name, which nothing else would have caught.
  verifyRelativeLinks(REPO_ROOT)

  // The guides are the progressive-disclosure half of the SOP. A guide that neither HARNESS.md nor the kit
  // README points at is disclosure that never happens, so it is reported rather than left to be noticed.
  const guideDir = join(KIT_ROOT, 'guides')
  const guides = existsSync(guideDir) ? readdirSync(guideDir).filter((f) => f.endsWith('.md')) : []
  const harness = readIfPresent(join(KIT_ROOT, 'HARNESS.md')) ?? ''
  // The kit is documented from the repository root, not from a README of its own: there is exactly one
  // README in this repository, and duplicating it inside the kit produced two places to keep in sync — which
  // is the drift this whole gate exists to catch.
  const rootReadme = readIfPresent(join(REPO_ROOT, 'README.md')) ?? ''
  if (rootReadme === '') fail('kit: the repository README.md is missing, so the kit is documented nowhere')
  for (const guide of guides) {
    if (!harness.includes(guide) && !rootReadme.includes(guide)) {
      warn(`kit: guides/${guide} is referenced by neither HARNESS.md nor README.md, so nothing loads it`)
    }
  }
}

const args = process.argv.slice(2)
if (args.length === 0) {
  process.stderr.write('usage: verify-plugin.mjs <plugin-dir>... | --kit\n')
  process.exit(2)
}

if (args.includes('--kit')) verifyKit()
for (const arg of args.filter((a) => a !== '--kit')) {
  const dir = resolve(arg)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(`${arg}: not a directory`)
    continue
  }
  verifyPlugin(dir)
}

for (const message of warnings) process.stderr.write(`warning: ${message}\n`)
if (errors.length > 0) {
  for (const message of errors) process.stderr.write(`error: ${message}\n`)
  process.stderr.write(`\n✗ ${errors.length} error(s) found.\n`)
  process.exit(1)
}
process.stdout.write('✓ All checks passed.\n')
