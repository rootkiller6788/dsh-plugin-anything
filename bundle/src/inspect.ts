/**
 * Inspection: gather what an interface actually offers, as normalised evidence.
 *
 * Pipeline stage 2. This is **not** capability extraction — that is stage 3, and it is judgement. Inspection
 * collects facts and says which facts it could not collect. The distinction matters: a tool that returned
 * "the capabilities are X" would be replacing the judgement the pipeline exists to preserve, and would be
 * confidently wrong on the target nobody anticipated.
 *
 * Three properties are load-bearing:
 *
 * 1. **Bounded.** Inspecting every subcommand of a large CLI means hundreds of processes. The budget is
 *    explicit, and truncation is reported rather than silently applied — a caller must be able to tell a
 *    complete inspection from a partial one, because an incomplete inspection that reads as complete is how
 *    a capability gets missed.
 * 2. **Reproducible.** The same target yields the same evidence, so a later stage can diff two inspections.
 *    Nothing here depends on the clock, the environment, or the order of a directory listing.
 * 3. **Honest about gaps.** `unknowns` is a first-class field. A target whose help output cannot be parsed
 *    produces an inspection that says so, instead of an inspection with no commands in it — those look the
 *    same downstream and mean opposite things.
 *
 * @module dsh-plugin-anything-bundle/inspect
 */

import type { CommandOutcome } from './backend.ts'

/**
 * What inspection needs from the outside world.
 *
 * Injected rather than imported so the parsing is testable against fixture help output, with no target
 * installed and no process spawned. The implementation in `backend.ts` is the only real one; tests pass a
 * stub. This is the same single-egress rule the generated bundles follow.
 */
export interface Runner {
  /**
   * Run a command.
   * @param command - the executable.
   * @param args - its arguments.
   * @param timeoutMs - cooperative budget for this one call.
   * @returns the outcome, including a non-zero exit.
   */
  run(command: string, args: readonly string[], timeoutMs: number): Promise<CommandOutcome>
}

/** One subcommand, with the material needed to judge it. */
export interface InspectedCommand {
  /** The subcommand as invoked, relative to the entrypoint. */
  readonly name: string
  /** Its one-line summary, as the interface itself describes it. Empty when the help output has none. */
  readonly summary: string
  /** The full help text, verbatim. The evidence `extract` reasons over. */
  readonly help: string
}

/** A flag the interface documents at the top level. */
export interface InspectedFlag {
  /** The flag as written, e.g. `--porcelain`. */
  readonly name: string
  /** Its description, verbatim. */
  readonly description: string
}

/** One command that was actually run, so the evidence can be re-derived. */
export interface InspectedProbe {
  /** The command line, as run. */
  readonly command: string
  /** The exit code, or null when killed by a signal. */
  readonly exitCode: number | null
  /** How much output it produced. Useful for spotting a command that printed nothing. */
  readonly bytes: number
}

/** Everything inspection established about a target. */
export interface InspectionEvidence {
  /** The entrypoint that was inspected, as resolved. */
  readonly entrypoint: string
  /** The target's own version string, when it reports one. */
  readonly version?: string
  /** The entrypoint's own help text, verbatim. */
  readonly entrypointHelp: string
  /** Subcommands found, in the order the interface listed them. */
  readonly commands: readonly InspectedCommand[]
  /** Top-level flags, when the help output documents them separately. */
  readonly globalFlags: readonly InspectedFlag[]
  /** Commands that were run, so the evidence can be reproduced. */
  readonly probes: readonly InspectedProbe[]
  /**
   * Whether the command budget cut the inspection short.
   *
   * Reported as its own field rather than left to be inferred from a count, because `commands.length`
   * hitting the cap and `commands.length` happening to equal the cap are indistinguishable, and one of
   * them means the inspection is incomplete.
   */
  readonly truncated: boolean
  /** What could not be determined. An empty array means "nothing was left unresolved", not "nothing to do". */
  readonly unknowns: readonly string[]
}

/** Bounds, because inspecting a large CLI means one process per subcommand. */
export interface InspectLimits {
  /** How many subcommands to inspect in depth. */
  readonly maxCommands: number
  /** Per-command timeout. */
  readonly timeoutMs: number
}

/** The defaults. Deliberately modest: a partial inspection that says it is partial beats a slow complete one. */
export const DEFAULT_LIMITS: InspectLimits = { maxCommands: 25, timeoutMs: 10_000 }

/**
 * Parse the subcommand list out of a help text.
 *
 * Two shapes cover most CLIs, and this handles both rather than picking one:
 *
 * - a dedicated section — `Commands:` / `COMMANDS:` / `Available commands:` — with one entry per line;
 * - a bare indented list, which is what `--help` output does when the command list *is* the body.
 *
 * Anything more exotic is left to the agent: `entrypointHelp` carries the verbatim text, so a parser that
 * returns nothing has not lost anything — it has declined to guess.
 *
 * @param help - the help text.
 * @returns the commands found, in listed order.
 */
export function parseSubcommands(help: string): { name: string; summary: string }[] {
  const lines = help.split('\n')
  /** @type {{ name: string; summary: string }[]} */
  const found: { name: string; summary: string }[] = []
  const seen = new Set<string>()

  /** A section header that introduces a command list. */
  const isCommandHeader = (line: string): boolean =>
    /^\s*(commands|available commands|subcommands)\s*:?\s*$/i.test(line.trim())

  /** `  name    description` — a command and its summary. */
  const parseEntry = (line: string): { name: string; summary: string } | undefined => {
    const match = /^\s{2,}([a-z0-9][a-z0-9:_.-]*)(?:\s{2,}|\s+-\s+)(.*)$/i.exec(line)
    if (match === null) return undefined
    const name = match[1] ?? ''
    // A single word on its own line is a heading or a stray, not a documented command.
    const summary = (match[2] ?? '').trim()
    if (name === '' || summary === '') return undefined
    return { name, summary }
  }

  let inSection = false
  for (const line of lines) {
    if (isCommandHeader(line)) { inSection = true; continue }
    // A new top-level section ends the command list.
    if (inSection && /^\S/.test(line) && line.trim() !== '') { inSection = false }

    const entry = parseEntry(line)
    // Outside a named section, an entry still counts: `git --help` lists its commands with no header at all,
    // and a parser that required one would report a large CLI as having no subcommands.
    if (entry === undefined) continue
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    found.push(entry)
    void inSection
  }
  return found
}

/**
 * Parse top-level flags out of a help text.
 *
 * Splits each indented line at its first run of two or more spaces rather than pattern-matching the flag
 * itself. The flag grammar is not one grammar: `--verbose`, `-v, --verbose`, `--config TEXT`, `-C <path>`,
 * `--out=DIR` are all common, and a regex over that shape either misses the value-taking forms or swallows
 * the description. The column gap is the one convention help output actually keeps.
 *
 * @param help - the help text.
 * @returns the flags found, in listed order.
 */
export function parseGlobalFlags(help: string): { name: string; description: string }[] {
  /** @type {{ name: string; description: string }[]} */
  const found: { name: string; description: string }[] = []
  const seen = new Set<string>()
  for (const line of help.split('\n')) {
    if (!/^\s{2,}/.test(line)) continue
    const split = /\s{2,}/.exec(line.trimStart())
    if (split === null) continue
    const name = line.trimStart().slice(0, split.index).trim()
    const description = line.trimStart().slice(split.index).trim()
    // The name column must look like a flag; otherwise this is an indented line of prose or a command.
    if (!name.startsWith('-') || description === '' || seen.has(name)) continue
    seen.add(name)
    found.push({ name, description })
  }
  return found
}

/**
 * Inspect a CLI target.
 *
 * Runs the entrypoint's help, parses the subcommands it lists, then asks each one for its own help — up to
 * the budget. Every command run is recorded, so a later stage can reproduce or audit the evidence.
 *
 * @param runner - how to run commands. The only outside-world dependency.
 * @param entrypoint - the resolved executable.
 * @param limits - the budget. Defaults to {@link DEFAULT_LIMITS}.
 * @returns the evidence, including what could not be determined.
 */
export async function inspectCli(
  runner: Runner,
  entrypoint: string,
  limits: InspectLimits = DEFAULT_LIMITS,
): Promise<InspectionEvidence> {
  const probes: InspectedProbe[] = []
  const unknowns: string[] = []

  /** Run a command and record it. */
  const run = async (args: readonly string[]): Promise<CommandOutcome> => {
    const outcome = await runner.run(entrypoint, args, limits.timeoutMs)
    probes.push({
      command: [entrypoint, ...args].join(' '),
      exitCode: outcome.exitCode,
      bytes: outcome.stdout.length + outcome.stderr.length,
    })
    return outcome
  }

  /**
   * Ask for help, preferring `-h` over `--help`.
   *
   * Not a style preference: on Git for Windows, `git status --help` prints **nothing** and opens the HTML
   * documentation in a browser, while `git status -h` prints the usage to stdout. Inspecting a git checkout
   * therefore opened a browser tab per subcommand and collected zero bytes of evidence — and the tool
   * reported success, because "no help output" is a reported unknown rather than a failure.
   *
   * `-h` is the conservative first attempt because it is the more widely supported spelling; `--help` is the
   * fallback for the tools that want the long form. Whichever produces output wins, so a tool that treats
   * `-h` as something else is not misread.
   *
   * @param prefix - arguments before the help flag, e.g. `['status']`.
   * @returns the outcome that produced text, or the `--help` one when neither did.
   */
  const helpFor = async (prefix: readonly string[]): Promise<CommandOutcome> => {
    const short = await run([...prefix, '-h'])
    if (`${short.stdout}${short.stderr}`.trim() !== '') return short
    return await run([...prefix, '--help'])
  }

  const rootHelp = await helpFor([])
  const entrypointHelp = `${rootHelp.stdout}${rootHelp.stderr}`.trim()
  if (entrypointHelp === '') {
    unknowns.push('the entrypoint printed nothing for --help, so no subcommands could be listed')
  }

  // The version, separately: `--help` rarely carries it and `--version` sometimes does not exist.
  let version: string | undefined
  const versionOutcome = await run(['--version'])
  const versionText = `${versionOutcome.stdout}${versionOutcome.stderr}`.trim()
  if (versionText !== '') {
    // Take the first line that contains a digit, rather than the whole banner.
    const line = versionText.split('\n').map((l) => l.trim()).find((l) => /\d/.test(l))
    if (line !== undefined) version = line
  } else {
    unknowns.push('the target did not report a version')
  }

  const listed = parseSubcommands(entrypointHelp)
  const commands: InspectedCommand[] = []
  let truncated = false

  for (const [index, entry] of listed.entries()) {
    if (index >= limits.maxCommands) { truncated = true; break }
    const help = await helpFor([entry.name])
    const text = `${help.stdout}${help.stderr}`.trim()
    // A subcommand that prints nothing still belongs in the evidence: its existence is a fact, and the empty
    // help is why its inputs are unknown.
    commands.push({ name: entry.name, summary: entry.summary, help: text })
  }

  if (truncated) {
    unknowns.push(
      `only the first ${limits.maxCommands} of ${listed.length} listed subcommands were inspected; `
      + `the remainder are unexamined, not absent`,
    )
  }
  if (commands.some((command) => command.help === '')) {
    const blank = commands.filter((command) => command.help === '').map((command) => command.name)
    unknowns.push(`no help output from: ${blank.join(', ')} — their inputs and outputs are unknown`)
  }

  return {
    entrypoint,
    ...version === undefined ? {} : { version },
    entrypointHelp,
    commands,
    globalFlags: parseGlobalFlags(entrypointHelp),
    probes,
    truncated,
    unknowns,
  }
}

/**
 * Render evidence for a model to read.
 *
 * Verbatim help text is included rather than summarised. Summarising here would be capability extraction
 * wearing inspection's name — the judgement this stage is careful not to make.
 *
 * @param evidence - the inspection evidence.
 * @returns a text rendering.
 */
export function renderInspection(evidence: InspectionEvidence): string {
  const lines: string[] = [
    `entrypoint: ${evidence.entrypoint}`,
    `version: ${evidence.version ?? '(not reported)'}`,
    `subcommands: ${evidence.commands.length}${evidence.truncated ? ' (truncated — see unknowns)' : ''}`,
  ]

  if (evidence.globalFlags.length > 0) {
    lines.push('', 'global flags:')
    for (const flag of evidence.globalFlags) lines.push(`  ${flag.name}  ${flag.description}`)
  }

  lines.push('', 'subcommands:')
  for (const command of evidence.commands) {
    lines.push(`  ${command.name} — ${command.summary}`)
  }

  if (evidence.unknowns.length > 0) {
    // Named, not buried: an inspection with gaps must not read as a complete one.
    lines.push('', 'UNKNOWN — determine these yourself or say you could not:')
    for (const unknown of evidence.unknowns) lines.push(`  - ${unknown}`)
  }

  lines.push(
    '',
    'The verbatim help text for the entrypoint and every listed subcommand follows. Read it; do not infer a',
    'command\'s inputs from its name.',
    '',
    '--- entrypoint ---',
    evidence.entrypointHelp,
  )
  for (const command of evidence.commands) {
    lines.push('', `--- ${command.name} ---`, command.help)
  }
  return lines.join('\n')
}
