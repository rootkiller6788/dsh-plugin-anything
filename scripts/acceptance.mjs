#!/usr/bin/env node
/**
 * The runtime acceptance ladder, as far as it can be run without a model.
 *
 * `docs/runtime-acceptance.md` describes the full scenario. Steps 6–13 need a model in the loop, so this
 * script runs every deterministic rung and then reports precisely which steps remain, with the command to
 * run each. A script that claimed to cover the keyed steps without running them would be worse than one
 * that stops and says where it stopped.
 *
 * Usage: node scripts/acceptance.mjs [--profile <name>]
 * Exit codes: 0 every deterministic rung passed · 1 a rung failed · 2 could not run
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const BUNDLE = join(REPO, 'bundle')
const KIT = join(REPO, 'kit')

const profileIndex = process.argv.indexOf('--profile')
const PROFILE = profileIndex === -1 ? 'panything' : (process.argv[profileIndex + 1] ?? 'panything')

/** @type {{name: string, ok: boolean, detail: string}[]} */
const results = []

/**
 * Run one rung of the ladder.
 * @param {string} name - the rung's label.
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {string} cwd - working directory.
 * @param {(out: string) => boolean} [check] - assertion on captured output.
 * @param {{ignoreExit?: boolean}} [options] - `ignoreExit` makes `check` authoritative. The boot rung needs
 *   it: a keyless boot is *expected* to exit non-zero, and the evidence is where the output says the failure
 *   landed, not the exit code.
 * @returns {boolean} whether the rung passed.
 */
function rung(name, command, args, cwd, check, options = {}) {
  // On Windows a bare command name like `npx` is a `.cmd` and needs a shell, but an absolute path must NOT
  // go through one: `shell: true` splits `D:\Program Files\nodejs\node.exe` on the space. The first version
  // of this script set `shell` unconditionally and every `process.execPath` rung failed with
  // "'D:\Program' is not recognized".
  const needsShell = process.platform === 'win32' && !/[\\/]/.test(command)
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: needsShell })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const ok = (options.ignoreExit === true || result.status === 0) && (check === undefined || check(out))
  results.push({ name, ok, detail: ok ? '' : out.split('\n').slice(0, 6).join('\n') })
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}\n`)
  if (!ok) process.stdout.write(`${out.split('\n').slice(0, 10).map((l) => `    ${l}`).join('\n')}\n`)
  return ok
}

process.stdout.write(`runtime acceptance — repo ${REPO}, profile ${PROFILE}\n\n`)

// ── Rungs 1–2: static + link gate ───────────────────────────────────────────────────────────────────
rung('1  static + link gate (kit)', process.execPath, [join(KIT, 'scripts', 'verify-plugin.mjs'), '--kit'], REPO)
rung('1  static + link gate (bundle)', process.execPath, [join(KIT, 'scripts', 'verify-plugin.mjs'), 'bundle'], REPO)
const examplesDir = join(REPO, 'examples')
if (existsSync(examplesDir)) {
  rung('1  static + link gate (examples)', process.execPath, [join(KIT, 'scripts', 'verify-plugin.mjs'), join(examplesDir, 'dsh-plugin-git')], REPO)
}

// ── Rung 3: type gate ───────────────────────────────────────────────────────────────────────────────
const hasDeps = existsSync(join(BUNDLE, 'node_modules', '@deepseek-ai'))
if (!hasDeps) {
  process.stderr.write(`\ncannot continue: run \`pnpm install\` in ${BUNDLE} first.\n`)
  process.exit(2)
}
rung('3  type gate (bundle)', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], BUNDLE)
rung('3  type gate (generated example)', process.execPath,
  ['--experimental-strip-types', join(BUNDLE, 'scripts', 'typecheck-example.mjs')], BUNDLE)

// ── Rung 4: build gate ──────────────────────────────────────────────────────────────────────────────
rung('4  build gate', 'npx', ['tsdown'], BUNDLE)
rung('4  build produced the manifest artifact', process.execPath, ['-e', `
  const { readFileSync, existsSync } = require('node:fs')
  const main = JSON.parse(readFileSync('package.json','utf8')).main
  if (!existsSync(main)) { console.error(main + ' was not produced'); process.exit(1) }
  console.log('ok: ' + main)
`.trim()], BUNDLE)

// ── Rung 5: contract + replay gate ──────────────────────────────────────────────────────────────────
for (const suite of ['registration.test.mjs', 'promote.test.mjs', 'presenter-replay.test.mjs']) {
  rung(`5  ${suite.replace('.test.mjs', '')}`, process.execPath, ['--test', join(BUNDLE, 'tests', suite)], BUNDLE)
}
for (const suite of ['scaffold.test.mjs', 'pipeline.test.mjs', 'ir.test.mjs', 'inspect.test.mjs', 'compile.test.mjs', 'accept.test.mjs', 'pack.test.mjs', 'failure-injection.test.mjs', 'regressions.test.mjs']) {
  rung(`5  ${suite.replace('.test.mjs', '')}`, process.execPath,
    ['--experimental-strip-types', '--test', join(BUNDLE, 'tests', suite)], BUNDLE)
}
rung('5  paths', process.execPath, ['--test', join(BUNDLE, 'tests', 'paths.test.mjs')], BUNDLE)
rung('5  inspect (live)', process.execPath, ['--test', join(BUNDLE, 'tests', 'inspect-live.test.mjs')], BUNDLE)
rung('5  gate acceptance mutants', process.execPath, ['--test', join(KIT, 'tests', 'verify-plugin.test.mjs')], BUNDLE)

// ── Shipped copies: what the bundle carries must equal the kit's originals ─────────────────────────
rung('golden E2E: every category', process.execPath, ['--experimental-strip-types', join(REPO, 'scripts', 'golden-e2e.mjs')], REPO)
rung('README status table is current', process.execPath, ['--experimental-strip-types', join(REPO, 'scripts', 'check-readme-status.mjs')], REPO)
rung('shipped copies match the kit', process.execPath, [join(REPO, 'scripts', 'check-shipped-copies.mjs')], REPO)

// ── Registry: the entry against the list's own rules ────────────────────────────────────────────────
{
  const result = spawnSync(process.execPath, [join(REPO, 'scripts', 'validate-registry-entry.mjs')], {
    cwd: REPO, encoding: 'utf8',
  })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status === 2) {
    // Exit 2 is "cannot run": the upstream list is not checked out here. A skip, not a failure — the same
    // distinction the list's own submission gate draws between a rejection and an inconclusive result.
    results.push({ name: 'registry entry (upstream list absent)', ok: true, detail: '' })
    process.stdout.write('• registry entry: SKIPPED — no awesome-dsh-plugin checkout to read rules from\n')
  } else {
    rung('registry entry satisfies the list\'s rules', process.execPath,
      [join(REPO, 'scripts', 'validate-registry-entry.mjs')], REPO, (text) => text.includes('✓ the entry satisfies'))
  }
  void out
}

// ── Rungs 7–8: composition + boot gate ──────────────────────────────────────────────────────────────
//
// The LOCAL SOURCE dsh is preferred over the published one, deliberately. Two reasons, both learned the
// hard way: the source checkout carries the full package set and the monorepo's own gates, and mixing the
// two lines silently is how a version-skew bug reaches a user. The published CLI remains available as a
// release-compatibility reference via `--dsh published`.
//
// They need separate homes: the source build cannot parse a `.credentials.yaml` written by the published
// line (`the value for "version" ... must be a string`), which is itself the version skew made visible.
const dshIndex = process.argv.indexOf('--dsh')
const DSH_CHOICE = dshIndex === -1 ? 'local' : (process.argv[dshIndex + 1] ?? 'local')

const LOCAL_DSH_REPO = 'D:/Opencode/dsh-plugin/deepseek-harness-master'
const localDshAvailable = DSH_CHOICE === 'local' && existsSync(join(LOCAL_DSH_REPO, 'package.json'))

/**
 * How to invoke the chosen dsh, and which home it reads.
 *
 * The source build is invoked from its own directory rather than with `pnpm --dir`: that repo pins
 * `packageManager: pnpm@11.7.0`, and corepack refuses a `--dir` invocation with a different pnpm instead
 * of switching versions. Running with the repo as the working directory is what the repo's own docs use.
 */
const dsh = localDshAvailable
  ? {
      label: `local source (${LOCAL_DSH_REPO})`,
      env: { DSH_HOME: 'D:/Opencode/dsh-plugin/.dsh-local' },
      cwd: LOCAL_DSH_REPO,
      command: 'pnpm',
      prefix: ['dsh'],
    }
  : {
      label: 'published @deepseek-ai/dsh',
      env: { DSH_HOME: join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh') },
      cwd: REPO,
      command: 'npx',
      prefix: ['--yes', '@deepseek-ai/dsh'],
    }

process.stdout.write(`\ndsh under test: ${dsh.label}\n`)

const profileDir = join(dsh.env.DSH_HOME, 'profiles', PROFILE)
if (!existsSync(profileDir)) {
  process.stdout.write(`• 7-8 composition + boot gate: SKIPPED — no profile at ${profileDir}\n`)
  process.stdout.write(`    create it with: dsh plugin --profile ${PROFILE} add ${BUNDLE}\n`)
} else {
  // The two rungs must run against one home, so they carry the environment explicitly rather than relying
  // on whatever the invoking shell happened to export.
  const rungWithEnv = (name, args, check, options) => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dsh.env.DSH_HOME
    try { return rung(name, dsh.command, [...dsh.prefix, ...args], dsh.cwd, check, options) } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }

  rungWithEnv('7  composition: the bundle layer is in the tree', ['--profile', PROFILE, '--dump-config'],
    (out) => out.includes('dsh-plugin-anything-bundle'))
  // Note what rung 7 is and is not: --dump-config does NOT detect duplicate row ids, so a pass there is
  // necessary and not sufficient. This run is the rung that actually decides.
  rungWithEnv('8  boot: the profile settles and reaches the model request', ['--profile', PROFILE, 'hi'],
    (out) => /MISSING_CREDENTIAL/.test(out), { ignoreExit: true })
}

process.stdout.write('\nremaining steps (need a model in the loop — see docs/runtime-acceptance.md)\n')
process.stdout.write('  8   model lists the bundle\'s tools          dsh --profile ' + PROFILE + ' "list your plugin_anything* tools"\n')
process.stdout.write('  9   model calls plugin_anything_probe        dsh --profile ' + PROFILE + ' "call plugin_anything_probe on git"\n')
process.stdout.write('  10  cordis_define creates a real package     (needs cordis-host-runner mounted)\n')
process.stdout.write('  11  cordis_run activates it; model calls it\n')
process.stdout.write('  12  plugin_anything_promote reads it via inspectPackage\n')
process.stdout.write('  13  convert, install, RESTART, model calls the promoted capability\n')

const failed = results.filter((entry) => !entry.ok)
process.stdout.write(`\n${failed.length === 0 ? '✔' : '✖'} ${results.length - failed.length}/${results.length} deterministic rungs passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
