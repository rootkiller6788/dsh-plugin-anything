/**
 * Target classification: decide which of the three backend surfaces the target has, and gather the evidence
 * that proves it is callable.
 *
 * Phase 0 of the SOP is "establish that a callable surface exists and actually call it" — an assumed surface
 * is not an acquired one. This module produces the evidence the rest of the pipeline depends on.
 *
 * @module dsh-plugin-anything-bundle/probe
 */

import { isDirectory, isFile, listDirectory, makeRunner, readText, runCommand } from './backend.ts'
import type { Runner } from './inspect.ts'

/** Which of the three surfaces the target exposes. */
export type SurfaceKind = 'cli' | 'http' | 'mcp' | 'unknown'

/** One piece of evidence gathered about the target. */
export interface ProbeEvidence {
  /** What was observed. */
  readonly observation: string
  /** Whether the observation supports the classification. */
  readonly supports: boolean
}

/** The result of probing a target. */
export interface ProbeResult {
  /** The surface this target appears to expose. */
  readonly kind: SurfaceKind
  /** How the surface was determined, in the order it was gathered. */
  readonly evidence: readonly ProbeEvidence[]
  /**
   * For `cli`: the resolved executable. For `http`/`mcp`: the endpoint URL. Empty when unknown.
   */
  readonly endpoint: string
  /**
   * The first lines of the command's own help text, when it printed any. This is the raw material for
   * Phase 1's capability mapping.
   */
  readonly helpExcerpt: string
}

/**
 * Classify a target from its string form alone, without touching the system.
 *
 * Kept separate from {@link probeTarget} so the classification rules are testable without a live target.
 *
 * @param input - the user-supplied target.
 * @returns the surface it names, or `unknown`.
 */
export function classifyTarget(input: string): SurfaceKind {
  const trimmed = input.trim()
  if (trimmed === '') return 'unknown'
  if (/^mcp\+|^mcp:\/\//i.test(trimmed)) return 'mcp'
  if (/^https?:\/\//i.test(trimmed)) {
    // A trailing /mcp or /sse is the convention both the MCP spec's examples and common servers follow.
    // It is a hint, not proof — the probe confirms it by actually talking to the endpoint.
    return /\/mcp\/?$|\/sse\/?$|\/message\/?$/i.test(trimmed) ? 'mcp' : 'http'
  }
  return 'cli'
}

/**
 * Probe a target and return the evidence for its classification.
 *
 * @param input - a path to an executable or a source tree, or an HTTP(S) URL.
 * @param options - probe controls.
 * @param options.cwd - working directory for any command run.
 * @param options.signal - the caller's abort signal; honored on every call.
 * @param options.timeoutMs - cooperative budget for the whole probe.
 * @returns the classification plus the evidence gathered.
 */
export async function probeTarget(
  input: string,
  options: { cwd: string; signal: AbortSignal; timeoutMs: number },
): Promise<ProbeResult> {
  const evidence: ProbeEvidence[] = []
  const kind = classifyTarget(input)

  if (kind === 'http' || kind === 'mcp') {
    evidence.push({ observation: `target parses as a ${kind} endpoint`, supports: true })
    return { kind, evidence, endpoint: input.trim(), helpExcerpt: '' }
  }

  // A CLI target: establish that something executable is actually there.
  if (kind === 'unknown') {
    evidence.push({ observation: 'no target was supplied', supports: false })
    return { kind, evidence, endpoint: '', helpExcerpt: '' }
  }

  // A bare command name is not a path, so `isFile` alone would report a PATH-installed tool as missing.
  // Resolve it first: this is the common case for a CLI target, and getting it wrong makes the probe
  // answer "not callable" for every correctly installed tool.
  const resolved = await resolveOnPath(input, makeRunner(options.signal, options.cwd), options.timeoutMs)
  if (resolved !== undefined && resolved !== input) {
    evidence.push({ observation: `${input} resolves to ${resolved} on PATH`, supports: true })
  }
  const path = resolved ?? input

  const asDirectory = await isDirectory(path)
  if (asDirectory) {
    // A source tree rather than a binary. Look for the markers that say a runnable surface exists.
    const entries = await listDirectory(path)
    const manifests = ['package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod']
    const found = manifests.filter((name) => entries.includes(name))
    evidence.push({
      observation: found.length > 0
        ? `directory with project manifest: ${found.join(', ')}`
        : 'directory with no recognised project manifest',
      supports: found.length > 0,
    })
    const binDirs = ['bin', 'cli', 'src']
    const present = binDirs.filter((name) => entries.includes(name))
    if (present.length > 0) {
      evidence.push({ observation: `source layout present: ${present.join(', ')}`, supports: true })
    }
    return {
      kind,
      evidence,
      endpoint: '',
      helpExcerpt: await firstHelpText(path, entries),
    }
  }

  const exists = await isFile(path)
  evidence.push({
    observation: exists ? `${path} is an existing file` : `${path} was not found on disk`,
    supports: exists,
  })

  if (!exists) return { kind, evidence, endpoint: '', helpExcerpt: '' }

  // Prove it is callable rather than merely present: ask it for its own help.
  //
  // `-h` first, then `--help`. On Git for Windows the long form prints nothing and opens the HTML docs in a
  // browser — so a probe that used it collected zero bytes and launched a tab, and the empty result then read
  // as "this tool printed no help" rather than "the wrong flag was used". Same fix `inspect` carries.
  const short = await runCommand(path, ['-h'], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  })
  const usedShort = `${short.stdout}${short.stderr}`.trim() !== ''
  const outcome = usedShort
    ? short
    : await runCommand(path, ['--help'], {
      cwd: options.cwd,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
  const flag = usedShort ? '-h' : '--help'
  const help = `${outcome.stdout}${outcome.stderr}`.trim()
  evidence.push({
    observation: outcome.ok
      ? `ran ${flag} successfully`
      : `ran ${flag} and exited ${outcome.exitCode ?? 'via signal'}`,
    // Many tools exit non-zero on a help flag, or have no such flag; printing usage at all is the real signal.
    supports: help !== '',
  })
  return { kind, evidence, endpoint: path, helpExcerpt: excerpt(help) }
}

/**
 * Resolve a bare command name through PATH.
 *
 * A target like `git` is not a path, so a filesystem check alone reports an installed tool as missing. This
 * is the common case — a real model turn asked the probe about `git` and got `callable: false` for exactly
 * this reason.
 *
 * @param input - the target as the user wrote it.
 * @param options - invocation controls.
 * @returns the resolved absolute path, or undefined when the name does not resolve (or the input was
 *   already a path).
 */
export async function resolveOnPath(
  input: string,
  runner: Runner,
  timeoutMs: number,
): Promise<string | undefined> {
  // Contains a separator => the caller meant a path, and resolving it through PATH would be wrong.
  if (input.includes('/') || input.includes('\\')) return undefined
  // The platform's own lookup, so we inherit its exact PATH semantics instead of reimplementing them.
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  try {
    const outcome = await runner.run(lookup, [input], timeoutMs)
    if (!outcome.ok) return undefined
    // `where` may print several matches; take the first.
    const first = outcome.stdout.split('\n').map((line) => line.trim()).find((line) => line !== '')
    return first
  } catch {
    // No lookup tool on PATH at all: not an error, just no extra evidence.
    return undefined
  }
}

/**
 * Look for a declared runnable entry inside a source tree.
 *
 * This reads what the project declares rather than executing it: a source tree's entry point usually needs
 * its dependencies installed, which a probe must not do.
 *
 * @param root - the source tree.
 * @param entries - the top-level entry names already listed.
 * @returns the declared entry, or the empty string when nothing runnable was declared.
 */
async function firstHelpText(root: string, entries: readonly string[]): Promise<string> {
  // A package.json `bin` is the strongest available signal for a Node project.
  if (entries.includes('package.json')) {
    try {
      const manifest = JSON.parse(await readText(`${root}/package.json`)) as { bin?: unknown }
      if (manifest.bin !== undefined) return `declares bin: ${JSON.stringify(manifest.bin)}`
    } catch {
      // A malformed manifest is not this module's problem to report; the probe continues without it.
    }
  }
  if (entries.includes('pyproject.toml')) {
    const text = await readText(`${root}/pyproject.toml`)
    const match = /\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/.exec(text)
    // The capture group always participates when the pattern matches, but it may be empty; the `?? ''`
    // keeps this honest under `noUncheckedIndexedAccess` rather than asserting it away.
    if (match !== null) return excerpt((match[1] ?? '').trim())
  }
  return ''
}

/**
 * Keep the head of a long help text, which is where the command list lives.
 * @param text - the full help output.
 * @returns at most the first 60 lines.
 */
function excerpt(text: string): string {
  return text.split('\n').slice(0, 60).join('\n')
}
