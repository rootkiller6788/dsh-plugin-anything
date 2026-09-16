/**
 * Inspection: parsing, and the properties that make the evidence trustworthy.
 *
 * The `Runner` is injected, so every case below runs against fixture help output — no target installed, no
 * process spawned, and the shapes that matter (a bare command list, a named section, empty help, a CLI with
 * more subcommands than the budget) are all reachable without hunting for a binary that happens to exhibit
 * them.
 *
 * Run: node --experimental-strip-types --test tests/inspect.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectCli, parseSubcommands, parseGlobalFlags, renderInspection, DEFAULT_LIMITS } from '../src/inspect.ts'

/** git-style: the command list is the body, with no section header. */
const GIT_STYLE_HELP = `usage: git [-v | --version] [-h | --help] [-C <path>] <command> [<args>]

These are common Git commands used in various situations:

start a working area
   clone     Clone a repository into a new directory
   init      Create an empty Git repository or reinitialize an existing one

work on the current change
   add       Add file contents to the index
   mv        Move or rename a file, a directory, or a symlink
   restore   Restore working tree files
`

/** GNU-style: a named section introduces the list. */
const GNU_STYLE_HELP = `Usage: widget [OPTIONS] COMMAND [ARGS]...

Options:
  --verbose  Show more output.
  --config TEXT  Path to a config file.

Commands:
  build    Build the widget.
  inspect  Inspect a built widget.
  clean    Remove build output.
`

/**
 * A stub Runner that answers from a table and records what was asked.
 * @param {Record<string, string>} table - command line (space-joined, after the entrypoint) to output.
 * @returns {object} a Runner plus its call log.
 */
function stubRunner(table) {
  const calls = []
  return {
    calls,
    async run(command, args, timeoutMs) {
      const key = args.join(' ')
      calls.push({ command, args: [...args], timeoutMs })
      const stdout = table[key]
      if (stdout === undefined) return { ok: false, stdout: '', stderr: '', exitCode: 1 }
      return { ok: true, stdout, stderr: '', exitCode: 0 }
    },
  }
}

test('parses a bare command list with no section header', () => {
  // The case a header-requiring parser gets wrong: `git --help` lists its commands with no header at all,
  // and reporting a large CLI as having zero subcommands is the failure that matters.
  const found = parseSubcommands(GIT_STYLE_HELP)
  assert.deepEqual(found.map((c) => c.name), ['clone', 'init', 'add', 'mv', 'restore'])
  assert.equal(found[0].summary, 'Clone a repository into a new directory')
})

test('parses a named command section and stops at the next section', () => {
  const found = parseSubcommands(GNU_STYLE_HELP)
  assert.deepEqual(found.map((c) => c.name), ['build', 'inspect', 'clean'])
  // The option lines above the section must not be mistaken for commands.
  assert.ok(!found.some((c) => c.name.startsWith('-')))
})

test('does not invent commands from prose', () => {
  // `   verb   description` is the entry shape; a sentence in the body is not.
  const found = parseSubcommands('This tool does things.\n\nSee the manual for details.\n')
  assert.deepEqual(found, [])
})

test('parses global flags', () => {
  const flags = parseGlobalFlags(GNU_STYLE_HELP)
  assert.deepEqual(flags.map((f) => f.name), ['--verbose', '--config TEXT'])
})

test('inspects an entrypoint and each subcommand it lists', async () => {
  const runner = stubRunner({
    '--help': GNU_STYLE_HELP,
    '--version': 'widget 1.2.3\n',
    'build --help': 'Usage: widget build [--out DIR]',
    'inspect --help': 'Usage: widget inspect [--json]',
    // `clean --help` is absent from the table: it prints nothing, which is a fact worth keeping.
  })
  const evidence = await inspectCli(runner, 'widget')

  assert.equal(evidence.entrypoint, 'widget')
  assert.equal(evidence.version, 'widget 1.2.3')
  assert.deepEqual(evidence.commands.map((c) => c.name), ['build', 'inspect', 'clean'])
  assert.equal(evidence.commands[0].help, 'Usage: widget build [--out DIR]')
  assert.equal(evidence.commands[2].help, '', 'a subcommand that printed nothing is still an entry')
  assert.equal(evidence.truncated, false)
})

test('a subcommand with no help output becomes a named unknown, not a silent gap', async () => {
  const runner = stubRunner({ '--help': GNU_STYLE_HELP, '--version': 'widget 1.0' })
  const evidence = await inspectCli(runner, 'widget')
  assert.ok(
    evidence.unknowns.some((u) => /no help output from: build, inspect, clean/.test(u)),
    `expected a named unknown, got: ${JSON.stringify(evidence.unknowns)}`,
  )
})

test('respects the command budget and says that it truncated', async () => {
  // The distinction that matters: `commands.length === maxCommands` and `truncated` are different facts, and
  // an incomplete inspection that reads as complete is how a capability gets missed.
  const runner = stubRunner({ '--help': GNU_STYLE_HELP, '--version': 'widget 1.0' })
  const evidence = await inspectCli(runner, 'widget', { maxCommands: 2, timeoutMs: 1_000 })
  assert.equal(evidence.commands.length, 2)
  assert.equal(evidence.truncated, true)
  assert.ok(evidence.unknowns.some((u) => /only the first 2 of 3/.test(u)))
})

test('reports an entrypoint that prints nothing rather than returning empty evidence', async () => {
  const runner = stubRunner({})
  const evidence = await inspectCli(runner, 'mystery')
  assert.equal(evidence.entrypointHelp, '')
  assert.deepEqual(evidence.commands, [])
  assert.ok(evidence.unknowns.some((u) => /printed nothing for --help/.test(u)))
  assert.ok(evidence.unknowns.some((u) => /did not report a version/.test(u)))
})

test('records every command it ran, so the evidence can be reproduced', async () => {
  const runner = stubRunner({ '--help': GNU_STYLE_HELP, '--version': 'widget 1.0' })
  const evidence = await inspectCli(runner, 'widget')
  assert.deepEqual(
    evidence.probes.map((p) => p.command.replace('widget ', '')),
    runner.calls.map((c) => c.args.join(' ')),
    'the probe log and the run log must agree',
  )
  // The recording keeps the exit code rather than assuming success: `--help` printing to stderr and exiting
  // non-zero is common, and a log that hid that would make the evidence look cleaner than it was.
  assert.ok(
    evidence.probes.every((p) => typeof p.exitCode === 'number' || p.exitCode === null),
    'every probe must record its exit code',
  )
  // The stub exits non-zero for the subcommands it has no output for, and that is recorded rather than
  // smoothed over — which is what this asserts.
  assert.ok(evidence.probes.some((p) => p.exitCode === 1), 'a failed probe must be recorded as failed')
})

test('two inspections of the same target produce identical evidence', async () => {
  // Reproducibility is what lets a later stage diff two inspections. Anything here depending on the clock,
  // the environment, or iteration order would break that.
  const table = { '--help': GNU_STYLE_HELP, '--version': 'widget 1.0', 'build --help': 'b', 'inspect --help': 'i', 'clean --help': 'c' }
  const first = await inspectCli(stubRunner(table), 'widget')
  const second = await inspectCli(stubRunner(table), 'widget')
  assert.deepEqual(second, first)
})

test('the default budget is bounded', () => {
  // A CLI with hundreds of subcommands means one process each. The default must not be "all of them".
  assert.ok(DEFAULT_LIMITS.maxCommands > 0 && DEFAULT_LIMITS.maxCommands <= 50)
  assert.ok(DEFAULT_LIMITS.timeoutMs > 0)
})

test('the rendering carries verbatim help and names its unknowns', async () => {
  const runner = stubRunner({ '--help': GNU_STYLE_HELP, '--version': 'widget 1.0', 'build --help': 'Usage: widget build' })
  const rendered = renderInspection(await inspectCli(runner, 'widget'))

  // Summarising would be extraction wearing inspection's name, so the raw help must survive into the text.
  assert.ok(rendered.includes('Usage: widget build'), 'verbatim subcommand help is missing')
  assert.ok(rendered.includes('UNKNOWN'), 'unknowns must be visible, not buried')
  assert.ok(rendered.includes('do not infer a'),
    'the rendering must tell the reader not to infer inputs from a command name')
})
