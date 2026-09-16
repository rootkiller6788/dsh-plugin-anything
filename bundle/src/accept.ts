/**
 * Acceptance: the tail of the pipeline as one verdict.
 *
 * Stages 8 and 11–16 — build, compose, boot, discover, invoke, present, replay — are each a separate way to
 * be wrong, and running them as five manual steps means one gets skipped and nobody notices. This module
 * runs them and returns a single answer.
 *
 * **The rule that makes the answer worth having: a stage that did not run is never a pass.**
 *
 * `accepted` requires every stage to have passed with evidence. A stage that could not run — no session log,
 * no model key, no profile — yields `incomplete`, and the reason names what was missing. An `accepted` that
 * could have come from a run where nothing happened is worse than no verdict, because it is the one a
 * release decision gets made on. The dsh project's own submission gate draws the same line between a
 * rejection and an inconclusive probe, for the same reason.
 *
 * The other half is that the stages are not interchangeable. This project has found defects that pass every
 * stage before them: a composition dumps cleanly and fails to boot; a plugin loads and the model cannot see
 * it; the model sees a tool and cannot call it. So each stage checks the thing the stage before it cannot.
 *
 * @module dsh-plugin-anything-bundle/accept
 */

/** How one stage came out. */
export type StageVerdict = 'pass' | 'fail' | 'skip'

/** One stage's outcome, with the evidence for it. */
export interface AcceptanceStage {
  /** The pipeline stage id. See `pipeline.ts`. */
  readonly stage: string
  /** The outcome. `skip` means it did not run, which is never a pass. */
  readonly verdict: StageVerdict
  /** What was observed, concretely. A `pass` with nothing here is not evidence. */
  readonly detail: string
}

/** The overall answer. */
export interface Acceptance {
  /** `accepted` only when every stage passed; `incomplete` when any skipped. */
  readonly verdict: 'accepted' | 'rejected' | 'incomplete'
  /** One line a caller can act on. */
  readonly reason: string
  /** Every stage's outcome, including the ones that passed. */
  readonly stages: readonly AcceptanceStage[]
}

/** A tool call as it appears in a session log. */
export interface LoggedCall {
  /** The tool's name, as the model called it. */
  readonly name: string
  /** The arguments object, parsed from the logged JSON string. */
  readonly args: unknown
  /** Whether the call failed. */
  readonly isError: boolean
  /**
   * The presentation payload the tool projected into the result, if any.
   *
   * This is the only channel through which a card learns anything structured, so its presence is what makes
   * `present` checkable rather than assumed.
   */
  readonly meta: unknown
  /** The model-facing text of the result. */
  readonly text: string
}

/** One event extracted from a session log, in log order. */
export interface LoggedEvent {
  /** The event type, e.g. `tool/call`. */
  readonly type: string
  /** The event's `data`. */
  readonly data: Record<string, unknown>
}

/**
 * Parse a decompressed session log into its events.
 *
 * The log is JSONL with one event per line. Malformed lines are skipped rather than fatal: a truncated final
 * line is a normal artefact of a crash, and refusing the whole log because of it would make an interrupted
 * session unreadable.
 *
 * @param text - the decompressed log.
 * @returns the events that parsed.
 */
export function parseSessionLog(text: string): LoggedEvent[] {
  const events: LoggedEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; data?: unknown }
      if (typeof parsed.type === 'string' && typeof parsed.data === 'object' && parsed.data !== null) {
        events.push({ type: parsed.type, data: parsed.data as Record<string, unknown> })
      }
    } catch {
      // A partial final line, or a frame boundary. Neither makes the rest unreadable.
    }
  }
  return events
}

/**
 * Extract the tool calls a session made, pairing each with its result.
 *
 * Pairing is by the logged `callId`, not by position: a turn can interleave calls, and a positional pairing
 * would attribute one tool's result to another.
 *
 * The returned order is the order **results arrived**, not the order calls were made. A call is only
 * complete once its result lands, so `calls.at(-1)` means "the most recently completed invocation" — which
 * is what a caller asking for "the last call" wants. The first version of this function was documented as
 * call order and was not; the test that caught it is in `tests/accept.test.mjs`.
 *
 * @param events - the parsed log.
 * @returns the completed calls, in the order their results arrived.
 */
export function loggedCalls(events: readonly LoggedEvent[]): LoggedCall[] {
  /** @type {Map<string, {name: string, args: unknown}>} */
  const pending = new Map<string, { name: string; args: unknown }>()
  const calls: LoggedCall[] = []

  for (const event of events) {
    if (event.type === 'tool/call') {
      const callId = event.data.callId
      const name = event.data.name
      if (typeof callId !== 'string' || typeof name !== 'string') continue
      let args: unknown = event.data.arguments
      // The log stores arguments as a JSON string; the harness parses before a presenter sees them, so a
      // replay must parse too or it would feed the presenter something it never receives.
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { /* leave it as the raw string */ }
      }
      pending.set(callId, { name, args })
      continue
    }
    if (event.type !== 'tool/result') continue

    // The shape as a real session logs it, read off a real log rather than assumed:
    //
    //   data.message.source.callId          the call this result answers
    //   data.message.content[0].isError     whether the call failed
    //   data.message.content[0].content[]   the model-facing blocks
    //   data.meta                           the payload the tool's presentationMeta projected
    //
    // The first version of this function read `message.content[0].source.callId` and paired nothing at all.
    // Its fixture had been written from the same assumption, so the tests passed and every real log yielded
    // zero calls — which is the failure mode this project keeps meeting: a fixture drawn from a guess agrees
    // with the guess.
    const message = event.data.message as {
      source?: { callId?: unknown }
      content?: { isError?: unknown; content?: { type?: unknown; text?: unknown }[] }[]
    } | undefined
    const callId = message?.source?.callId
    if (typeof callId !== 'string') continue
    const call = pending.get(callId)
    if (call === undefined) continue

    const block = message?.content?.[0]
    const text = (block?.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n')

    calls.push({
      name: call.name,
      args: call.args,
      isError: block?.isError === true,
      meta: event.data.meta,
      text,
    })
  }
  return calls
}

/**
 * Turn stage outcomes into one verdict.
 *
 * The precedence is the whole point, and it is deliberately not "any failure dominates": a run that fails a
 * stage *and* skipped another is `rejected`, because a failure is a known defect and a skip is a known hole.
 * But a run with no failures and one skip is `incomplete`, never `accepted`.
 *
 * @param stages - the stage outcomes.
 * @returns the verdict, with a reason that names what is missing.
 */
export function decide(stages: readonly AcceptanceStage[]): Acceptance {
  if (stages.length === 0) {
    return { verdict: 'incomplete', reason: 'no stage was run', stages }
  }
  const failed = stages.filter((stage) => stage.verdict === 'fail')
  if (failed.length > 0) {
    return {
      verdict: 'rejected',
      reason: `${failed.length} stage(s) failed: ${failed.map((stage) => stage.stage).join(', ')}`,
      stages,
    }
  }
  const skipped = stages.filter((stage) => stage.verdict === 'skip')
  if (skipped.length > 0) {
    // Named, never summarised as "some stages". A caller deciding whether to release needs to know exactly
    // which part of the claim is unproven.
    return {
      verdict: 'incomplete',
      reason:
        `${skipped.length} stage(s) did not run: ${skipped.map((stage) => stage.stage).join(', ')}. `
        + 'A stage that did not run is not a pass — this is not an acceptance.',
      stages,
    }
  }
  return { verdict: 'accepted', reason: `all ${stages.length} stages passed with evidence`, stages }
}

/**
 * Check whether a boot run's output shows the plugin tree settled.
 *
 * The signal is where the run stopped, not whether it succeeded. A keyless boot is *expected* to exit
 * non-zero — it reaches the model request and fails on the missing credential, which is proof that every
 * entry, this plugin among them, loaded and ran. A load failure stops earlier and names the plugin.
 *
 * @param output - the combined stdout and stderr of the run.
 * @param packageName - the package under acceptance, which must not appear in a load error.
 * @returns the stage outcome.
 */
export function judgeBoot(output: string, packageName: string): AcceptanceStage {
  const loadFailure = /plugin tree failed to load|duplicate loader entry id|failed to apply loader entry|Cannot find (module|package)/
  if (loadFailure.test(output)) {
    const line = output.split('\n').find((l) => loadFailure.test(l))?.trim() ?? output.slice(0, 200)
    // Whether the failure names this package decides whether it is this bundle's problem or another layer's.
    // Both reject the acceptance, but a reader needs to know which one to open.
    const ours = output.includes(packageName)
    return {
      stage: 'boot',
      verdict: 'fail',
      detail: ours
        ? `the tree did not settle, and the failure names ${packageName}: ${line}`
        : `the tree did not settle, in another layer rather than ${packageName}: ${line}`,
    }
  }
  // Reaching the credential check means the Loader mounted every entry.
  if (/MISSING_CREDENTIAL|no API key/.test(output)) {
    return {
      stage: 'boot',
      verdict: 'pass',
      detail: 'the tree settled and the run reached the model request, failing there on the missing credential',
    }
  }
  // A keyed run: it produced model output, which also means the tree settled.
  if (output.trim() !== '') {
    return {
      stage: 'boot',
      verdict: 'pass',
      detail: 'the tree settled and the run produced output',
    }
  }
  return {
    stage: 'boot',
    verdict: 'skip',
    detail: 'the run produced no output, so there is no evidence either way',
  }
}

/**
 * The slice of a tool definition the replay check needs.
 *
 * Structural rather than imported: a compiled bundle's definition is an ordinary object, and requiring the
 * concrete type here would make this module depend on the host's tool package for a check that only calls
 * two methods.
 */
export interface ReplayableDefinition {
  /** The call-time presenter, if the tool has one. */
  readonly presentCall?: (args: never) => unknown
  /** The result-time presenter, if the tool has one. */
  readonly presentResult?: (args: never, result: never) => unknown
}

/**
 * Judge the replay stage by replaying a logged call through the bundle's own presenters.
 *
 * A presenter runs on live streaming *and* on replay, so the same input must render identically and a foreign
 * log must decline rather than throw. Both are checkable without a model: take the args and result a real
 * session logged, run them through the tool's presenters twice, and compare.
 *
 * @param definition - the tool's definition, loaded from the bundle under acceptance.
 * @param call - the logged call to replay.
 * @returns the stage outcome.
 */
export function judgeReplay(definition: ReplayableDefinition, call: LoggedCall): AcceptanceStage {
  const result = { content: [{ type: 'text', text: call.text }], isError: call.isError, meta: call.meta }
  const errors: string[] = []
  /** @type {unknown[]} */
  const views: unknown[] = []

  const invoke = (label: string, fn: (() => unknown) | undefined): void => {
    if (fn === undefined) return
    try {
      views.push(fn())
    } catch (cause) {
      errors.push(`${label} threw on a logged call: ${(cause as Error).message}`)
    }
  }

  invoke('presentCall', definition.presentCall === undefined
    ? undefined
    : () => (definition.presentCall as (args: unknown) => unknown)(call.args))
  invoke('presentResult', definition.presentResult === undefined
    ? undefined
    : () => (definition.presentResult as (a: unknown, r: unknown) => unknown)(call.args, result))

  if (errors.length > 0) {
    // Throwing on a replay is the failure the rule exists to prevent: display must never crash a replay.
    return { stage: 'replay', verdict: 'fail', detail: errors.join('; ') }
  }
  if (views.length === 0) {
    return { stage: 'replay', verdict: 'skip', detail: 'the tool declares no presenters, so there is nothing to replay' }
  }

  // The same input must render identically. A presenter that reads a clock, a counter, or I/O differs here.
  for (const label of ['presentCall', 'presentResult'] as const) {
    const fn = definition[label]
    if (fn === undefined) continue
    const once = (fn as (a: unknown, r: unknown) => unknown)(call.args, result)
    const twice = (fn as (a: unknown, r: unknown) => unknown)(call.args, result)
    if (stableStringify(once) !== stableStringify(twice)) {
      return { stage: 'replay', verdict: 'fail', detail: `${label} is not deterministic: the same call rendered differently twice` }
    }
  }
  return {
    stage: 'replay',
    verdict: 'pass',
    detail: `${views.length} presenter(s) replayed a logged call deterministically`,
  }
}

/**
 * Serialize a value for comparison, with keys in a stable order.
 *
 * `JSON.stringify` preserves insertion order, so two structurally equal objects built in different orders
 * compare unequal — which would report a deterministic presenter as non-deterministic.
 *
 * @param value - the value to serialize.
 * @returns a canonical string.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/**
 * Judge the discover, invoke, and present stages from a session's logged calls.
 *
 * These three are one scan of the same evidence because they are three questions about one call: was the
 * model told about the tool, did it call it, and did the result carry what a card needs. Splitting the scan
 * would let the three disagree about which call they are talking about.
 *
 * @param calls - the logged calls.
 * @param toolName - the tool under acceptance.
 * @returns one outcome per stage.
 */
export function judgeFromLog(calls: readonly LoggedCall[], toolName: string): AcceptanceStage[] {
  const matching = calls.filter((call) => call.name === toolName)
  if (matching.length === 0) {
    return [
      { stage: 'discover', verdict: 'skip', detail: `no logged call named ${toolName}` },
      { stage: 'invoke', verdict: 'skip', detail: `no logged call named ${toolName}` },
      { stage: 'present', verdict: 'skip', detail: `no logged call named ${toolName}` },
    ]
  }
  // `noUncheckedIndexedAccess` cannot narrow through `.length`, and asserting would hide a real edge. The
  // guard above already established there is at least one; `.at(-1)` with an explicit check says so.
  const last = matching.at(-1)
  if (last === undefined) {
    return [
      { stage: 'discover', verdict: 'skip', detail: `no logged call named ${toolName}` },
      { stage: 'invoke', verdict: 'skip', detail: `no logged call named ${toolName}` },
      { stage: 'present', verdict: 'skip', detail: `no logged call named ${toolName}` },
    ]
  }
  return [
    {
      stage: 'discover',
      verdict: 'pass',
      // A logged call is stronger evidence of discovery than a tool list would be: the model could not have
      // called something it was never told about.
      detail: `the model called ${toolName} ${matching.length} time(s), so it was told about it`,
    },
    last.isError
      ? { stage: 'invoke', verdict: 'fail', detail: `the last call failed: ${last.text.slice(0, 200)}` }
      : { stage: 'invoke', verdict: 'pass', detail: `the last call succeeded: ${last.text.slice(0, 200)}` },
    {
      stage: 'present',
      verdict: last.meta === undefined ? 'skip' : 'pass',
      detail: last.meta === undefined
        ? 'the logged result carries no meta, so a card had nothing structured to read'
        : 'the logged result carries the presentation payload a card reads',
    },
  ]
}
