#!/usr/bin/env node
/**
 * Golden E2E: every target category the project claims, each proved end to end.
 *
 * The claim in the name is "anything", and a claim like that is worth exactly what its weakest category is
 * worth. So each category is a **small but real** representative, run through the deterministic pipeline:
 *
 *   IR  →  compile  →  static gate  →  typecheck  →  package integrity
 *
 * and reported as one line. A category that cannot pass is the headline, not a footnote.
 *
 * **One category is special.** MCP is a terminal path: an MCP server already has a supported route into
 * dsh, and generating a plugin for it duplicates that route. So its golden case asserts the *opposite* of
 * the others — that the compiler refuses it, with the explanation a user needs — and that refusal is its
 * PASS. A category that "passed" by generating a redundant plugin would be a regression.
 *
 * Where the IR comes from differs by category, and the difference is the frontend boundary, not effort:
 *
 *   - `openapi` is **generated** by a frontend. A machine-readable interface description has already made
 *     the judgement that extraction exists to make: every documented operation is an intended capability.
 *   - the rest use a **recorded IR**. A CLI's `--help` lists thirty subcommands and which four matter is a
 *     reading; a heuristic that guessed would be confidently wrong on the target nobody anticipated. The
 *     recorded IR is the reviewed output of that reading, version-controlled like any other fixture.
 *
 * Usage: node --experimental-strip-types scripts/golden-e2e.mjs [--json]
 * Exit codes: 0 every category passed · 1 one did not · 2 could not run
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const BUNDLE = join(REPO, 'bundle')
const KIT = join(REPO, 'kit')
const GOLDEN = join(REPO, 'examples', 'golden')

if (!existsSync(join(BUNDLE, 'lib', 'index.js'))) {
  process.stderr.write('cannot run: build the bundle first (`cd bundle && npx tsdown`)\n')
  process.exit(2)
}

// Imported from source, not from the built entry: `lib/index.js` is the *plugin* entry and exports
// `name`/`inject`/`Config`/`apply`, not the internals. This script is a development harness, so it reads the
// modules directly — and runs under `--experimental-strip-types`.
const from = async (relative) => import(`file://${join(BUNDLE, relative).replaceAll('\\', '/')}`)

const scaffold = await from('src/scaffold.ts')
const { compileCapabilitySet, compilePackaging } = await from('src/compile.ts')
const { parse: parseIr, validateCapabilitySet } = await from('src/ir.ts')
const { judgePackage } = await from('src/pack.ts')
const { compileOpenApi } = await from('src/frontends/openapi.ts')

/**
 * The categories, and how each produces its IR.
 *
 * `terminal: true` marks the category whose correct outcome is a refusal.
 */
const CATEGORIES = [
  { id: 'git-cli', label: 'Git CLI', source: 'recorded' },
  { id: 'python-cli', label: 'Python CLI', source: 'recorded' },
  { id: 'npm-cli', label: 'npm CLI', source: 'recorded' },
  { id: 'local-script', label: 'Local Script', source: 'recorded' },
  { id: 'github-repo', label: 'GitHub Repository', source: 'recorded' },
  { id: 'openapi', label: 'OpenAPI', source: 'frontend' },
  { id: 'mcp-server', label: 'MCP Server', source: 'recorded', terminal: true },
]

/**
 * Run one step and capture it.
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {string} cwd - working directory.
 * @returns {{ok: boolean, stdout: string, output: string}} the outcome.
 */
function step(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32' && !/[\\/]/.test(command),
  })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

/**
 * Load a category's IR.
 * @param {{id: string, source: string}} category - the category.
 * @returns {object} the capability set.
 */
function loadIr(category) {
  const dir = join(GOLDEN, category.id)
  if (category.source === 'frontend') {
    const docPath = join(dir, 'openapi.json')
    return compileOpenApi(readFileSync(docPath, 'utf8'), `${category.id}/openapi.json`)
  }
  return parseIr(readFileSync(join(dir, 'ir.json'), 'utf8'))
}

/** @type {{id: string, label: string, status: 'PASS'|'FAIL', notes: string[]}[]} */
const results = []

for (const category of CATEGORIES) {
  const notes = []
  const root = mkdtempSync(join(BUNDLE, `.golden-${category.id}-`))
  try {
    /** @type {object} */
    let ir
    try {
      ir = loadIr(category)
    } catch (cause) {
      // A recorded IR that will not parse is a defect in the fixture, and the fixture is what the category's
      // claim rests on — so it fails the category rather than being skipped.
      results.push({ id: category.id, label: category.label, status: 'FAIL', notes: [`IR: ${cause.message}`] })
      continue
    }

    const problems = validateCapabilitySet(ir)
    if (problems.length > 0) {
      results.push({ id: category.id, label: category.label, status: 'FAIL', notes: problems })
      continue
    }

    // ── The terminal category: the compiler must refuse, and say why. ────────────────────────────────
    if (category.terminal === true) {
      let refused = false
      let explanation = ''
      try {
        compileCapabilitySet(ir)
      } catch (cause) {
        refused = true
        explanation = cause.message
      }
      const correct = refused && /terminal path/.test(explanation) && /dsh-mcp-client/.test(explanation)
      results.push({
        id: category.id,
        label: category.label,
        status: correct ? 'PASS' : 'FAIL',
        notes: correct
          ? ['compiler refused it as a terminal path and named the route to use instead']
          : [refused ? `refused, but unhelpfully: ${explanation.slice(0, 160)}` : 'the compiler produced a plugin for an MCP server, duplicating a route that already works'],
      })
      continue
    }

    // ── Compile ──────────────────────────────────────────────────────────────────────────────────────
    const compiled = compileCapabilitySet(ir)
    if (compiled.warnings.length > 0) notes.push(`warnings: ${compiled.warnings.join('; ')}`)

    const templates = {}
    for (const name of ['package.json.template', 'cordis.patch.yml.template', 'tsconfig.json.template', 'tsdown.config.ts.template']) {
      templates[name] = readFileSync(join(BUNDLE, 'templates', name), 'utf8')
    }
    const values = scaffold.deriveValues({
      target: ir.target.name.replaceAll('.', '-').toLowerCase(),
      description: ir.target.description,
      executable: ir.capabilities.find((c) => c.invocation.type === 'exec')?.invocation.command ?? ir.target.name,
      dshRange: scaffold.DEFAULT_DSH_RANGE,
      tools: ir.capabilities.map((c) => ({ name: c.id, description: c.description, subcommand: '' })),
    })
    const files = [...compiled.files, ...compilePackaging(ir, templates, values)]
    for (const file of files) {
      const destination = join(root, file.path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, file.contents, 'utf8')
    }
    notes.push(`${ir.capabilities.length} capabilit${ir.capabilities.length === 1 ? 'y' : 'ies'} → ${files.length} files`)

    // ── Build ────────────────────────────────────────────────────────────────────────────────────────
    // Before packaging, because the manifest declares compiled outputs and  lists what EXISTS.
    // Skipping this made every category report a missing `lib/index.js` — a harness mistake that looked
    // exactly like a product defect until it was traced.
    // The bundle's own declared build, not a hand-picked command. Running only `tsdown` produced the JS
    // but not the declarations, and the manifest declares both — so every category failed a check that
    // was really testing the harness's choice of command.
    const build = step('npm', ['run', 'build'], root)
    if (!build.ok) {
      const firstLine = build.output.split('\n')[0]
      results.push({ id: category.id, label: category.label, status: 'FAIL', notes: [...notes, `build: ${firstLine}`] })
      continue
    }

    // ── Static gate ──────────────────────────────────────────────────────────────────────────────────
    const gate = step(process.execPath, [join(KIT, 'scripts', 'verify-plugin.mjs'), root], REPO)
    if (!gate.ok) {
      results.push({ id: category.id, label: category.label, status: 'FAIL', notes: [...notes, `gate: ${gate.output.split('\n')[0]}`] })
      continue
    }

    // ── Typecheck ────────────────────────────────────────────────────────────────────────────────────
    // Materialized under the bundle so node_modules resolves; a bundle that compiles nowhere is not a bundle.
    //
    // Nothing is patched first. An earlier version of this harness rewrote the generated tsconfig to add a
    // compiler option — which meant it was checking a bundle the generator had not produced. The template
    // carries that option already; a harness that fixes up its subject is not a check.
    const typecheck = step(process.execPath,
      [join(BUNDLE, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', join(root, 'tsconfig.json')], root)
    if (!typecheck.ok) {
      results.push({ id: category.id, label: category.label, status: 'FAIL', notes: [...notes, `typecheck: ${typecheck.output.split('\n')[0]}`] })
      continue
    }

    // ── Package integrity ────────────────────────────────────────────────────────────────────────────
    const packed = step('npm', ['pack', '--dry-run', '--json'], root)
    if (!packed.ok) {
      results.push({ id: category.id, label: category.label, status: 'FAIL', notes: [...notes, `pack: ${packed.output.split('\n')[0]}`] })
      continue
    }
    const listing = JSON.parse(packed.stdout)[0]
    const verdict = judgePackage(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files,
      listing.files.map((f) => ({ path: f.path, size: f.size ?? 0 })))
    if (verdict.verdict !== 'pass') {
      results.push({ id: category.id, label: category.label, status: 'FAIL', notes: [...notes, `package: ${verdict.detail}`] })
      continue
    }
    notes.push(`${listing.files.length} packaged files, all declared entries present`)

    results.push({ id: category.id, label: category.label, status: 'PASS', notes })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes('--readme')) {
  // The README's headline table, emitted rather than typed. A hand-maintained status table drifts, and a
  // drifted one is worse than none: it is read as current. `check-readme-status.mjs` asserts the file still
  // contains what this prints.
  const width = Math.max(...results.map((r) => r.label.length))
  const lines = [
    '```',
    ...results.map((r) => `  ${r.label.padEnd(width)}  ${r.status === 'PASS' ? '█'.repeat(10) : '░'.repeat(10)}  ${r.status}`),
    '```',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
} else if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(results, undefined, 2)}\n`)
} else {
  const width = Math.max(...results.map((r) => r.label.length))
  process.stdout.write('Golden E2E — one real representative per category\n\n')
  for (const result of results) {
    const bar = result.status === 'PASS' ? '█'.repeat(10) : '░'.repeat(10)
    process.stdout.write(`  ${result.label.padEnd(width)}  ${bar}  ${result.status}\n`)
    for (const note of result.notes) process.stdout.write(`  ${' '.repeat(width)}            ${note}\n`)
  }
  const passed = results.filter((r) => r.status === 'PASS').length
  process.stdout.write(`\n  ${passed}/${results.length} categories passed\n`)
}

process.exit(results.every((r) => r.status === 'PASS') ? 0 : 1)
