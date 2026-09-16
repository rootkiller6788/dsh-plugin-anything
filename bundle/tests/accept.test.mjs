/**
 * Acceptance: the verdict, and the rule that makes it worth having.
 *
 * The tests below are mostly about **when the answer is not `accepted`**. That is deliberate: the value of
 * this module is not that it can say yes, it is that it refuses to say yes without evidence. An acceptance
 * that could have come from a run where nothing happened is the one a release decision gets made on.
 *
 * Run: node --experimental-strip-types --test tests/accept.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decide, judgeBoot, judgeFromLog, judgeReplay, loggedCalls, parseSessionLog,
} from '../src/accept.ts'

/** Build a stage outcome. */
const stage = (name, verdict, detail = 'x') => ({ stage: name, verdict, detail })

// ── The rule ─────────────────────────────────────────────────────────────────────────────────────────

test('every stage passing means accepted', () => {
  const result = decide([stage('build', 'pass'), stage('boot', 'pass')])
  assert.equal(result.verdict, 'accepted')
})

test('any failure means rejected, even alongside skips', () => {
  // A failure is a known defect; a skip is a known hole. The defect dominates.
  const result = decide([stage('build', 'pass'), stage('boot', 'fail'), stage('invoke', 'skip')])
  assert.equal(result.verdict, 'rejected')
  assert.match(result.reason, /boot/)
})

test('a skip with no failure is incomplete — never accepted', () => {
  // The whole point. `build` and `boot` passed; `discover` did not run. That is not an acceptance.
  const result = decide([stage('build', 'pass'), stage('boot', 'pass'), stage('discover', 'skip')])
  assert.equal(result.verdict, 'incomplete')
  assert.notEqual(result.verdict, 'accepted')
})

test('the reason names every stage that did not run', () => {
  // "some stages were skipped" is not actionable. A caller deciding whether to release needs the list.
  const result = decide([
    stage('build', 'pass'),
    stage('discover', 'skip'),
    stage('invoke', 'skip'),
    stage('replay', 'skip'),
  ])
  assert.match(result.reason, /discover/)
  assert.match(result.reason, /invoke/)
  assert.match(result.reason, /replay/)
  assert.match(result.reason, /not a pass/)
})

test('nothing run is incomplete, not accepted', () => {
  // The degenerate case that a naive `every(pass)` would call a pass by vacuous truth.
  assert.equal(decide([]).verdict, 'incomplete')
})

test('an accepted verdict carries every stage, not just the failures', () => {
  const stages = [stage('build', 'pass'), stage('compose', 'pass')]
  assert.deepEqual(decide(stages).stages, stages)
})

// ── Boot ─────────────────────────────────────────────────────────────────────────────────────────────

test('a load failure fails the boot stage and says whose fault it is', () => {
  const ours = judgeBoot('Error: plugin tree failed to load: duplicate loader entry id: code-runtime\nat widget-bundle', 'widget-bundle')
  assert.equal(ours.verdict, 'fail')
  assert.match(ours.detail, /names widget-bundle/)

  const theirs = judgeBoot('Error: plugin tree failed to load: duplicate loader entry id: code-runtime', 'widget-bundle')
  assert.equal(theirs.verdict, 'fail')
  assert.match(theirs.detail, /another layer/)
})

test('reaching the credential check passes boot, because it means the tree settled', () => {
  // The keyless signal: a keyless run is *expected* to exit non-zero, and where it stops is the evidence.
  const result = judgeBoot('dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route', 'widget-bundle')
  assert.equal(result.verdict, 'pass')
  assert.match(result.detail, /tree settled/)
})

test('silence is a skip, not a pass', () => {
  // No output means no evidence either way, and an empty run is exactly the case a careless check calls green.
  assert.equal(judgeBoot('', 'widget-bundle').verdict, 'skip')
})

// ── The session log ──────────────────────────────────────────────────────────────────────────────────

test('a malformed line does not make the whole log unreadable', () => {
  // A crash leaves a truncated final line, which is exactly when a reader is most needed.
  const log = [
    JSON.stringify({ type: 'tool/call', data: { callId: 'c1', name: 'widget_list', arguments: '{}' } }),
    '{"type":"tool/call","data":{"callId":"c2"',
  ].join('\n')
  assert.equal(parseSessionLog(log).length, 1)
})

/**
 * A `tool/result` event, in the shape a real session writes.
 *
 * Copied from an actual log, not composed from the reading code. The first version of this fixture used
 * `message.content[0].source.callId`, which is what the parser assumed and not what the log contains — so
 * the parser's tests passed while the parser paired nothing in production. A fixture drawn from a guess
 * agrees with the guess; a fixture drawn from a transcript can disagree with it.
 *
 * @param {string} callId - the call this answers.
 * @param {string} text - the model-facing text.
 * @returns {string} one JSONL line.
 */
function realResultLine(callId, text) {
  return JSON.stringify({
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
        role: 'user',
      },
      meta: { seen: callId },
    },
  })
}

test('calls are paired with their results by callId, not by position', () => {
  // A turn can interleave calls. Pairing by position would attribute one tool's result to another. The
  // results here arrive in the opposite order to the calls, so a positional pairing produces exactly the
  // wrong answer.
  const call = (callId, name) => JSON.stringify({ type: 'tool/call', data: { callId, name, arguments: '{"a":1}' } })
  const calls = loggedCalls(parseSessionLog([
    call('c1', 'first'), call('c2', 'second'), realResultLine('c2', 'two'), realResultLine('c1', 'one'),
  ].join('\n')))

  // Each name carries its own result, which is the pairing contract.
  const byName = Object.fromEntries(calls.map((c) => [c.name, c.text]))
  assert.deepEqual(byName, { first: 'one', second: 'two' })
  // And the documented order is result order, so `at(-1)` is the most recently completed call.
  assert.deepEqual(calls.map((c) => c.name), ['second', 'first'])
})

test('logged arguments are parsed, because that is what a presenter receives', () => {
  // The log stores a JSON string; the harness parses before presenting. A replay that skipped the parse
  // would feed presenters something they never see.
  const log = JSON.stringify({ type: 'tool/call', data: { callId: 'c1', name: 't', arguments: '{"limit":3}' } })
  const [call] = loggedCalls(parseSessionLog([log, realResultLine('c1', 'x')].join('\n')))
  assert.deepEqual(call.args, { limit: 3 })
  assert.equal(call.text, 'x')
})

test('a result whose text arrives as several blocks is joined', () => {
  // A real result can carry more than one text block; reading only the first would truncate the evidence a
  // presenter and a judge both work from.
  const log = JSON.stringify({ type: 'tool/call', data: { callId: 'c1', name: 't', arguments: '{}' } })
  const result = JSON.stringify({
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'c1' },
        content: [{ isError: false, content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }],
      },
    },
  })
  const [call] = loggedCalls(parseSessionLog([log, result].join('\n')))
  assert.equal(call.text, 'one\ntwo')
})

// ── Discover / invoke / present, from the log ───────────────────────────────────────────────────────

test('no call for the tool makes all three a skip, never a pass', () => {
  const stages = judgeFromLog([], 'widget_list')
  assert.deepEqual(stages.map((s) => s.verdict), ['skip', 'skip', 'skip'])
})

test('a successful logged call passes discover and invoke', () => {
  const stages = judgeFromLog([{ name: 'widget_list', args: {}, isError: false, meta: { value: 'ok' }, text: 'two items' }], 'widget_list')
  const byName = Object.fromEntries(stages.map((s) => [s.stage, s.verdict]))
  assert.equal(byName.discover, 'pass')
  assert.equal(byName.invoke, 'pass')
  assert.equal(byName.present, 'pass')
})

test('a failed logged call fails invoke', () => {
  const stages = judgeFromLog([{ name: 'widget_list', args: {}, isError: true, meta: undefined, text: 'boom' }], 'widget_list')
  assert.equal(stages.find((s) => s.stage === 'invoke').verdict, 'fail')
})

test('a result with no meta skips present rather than failing it', () => {
  // A tool with no presenters legitimately projects nothing. That is an absence of evidence, not a defect.
  const stages = judgeFromLog([{ name: 'widget_list', args: {}, isError: false, meta: undefined, text: 'ok' }], 'widget_list')
  assert.equal(stages.find((s) => s.stage === 'present').verdict, 'skip')
})

// ── Replay ───────────────────────────────────────────────────────────────────────────────────────────

test('a deterministic presenter replays', () => {
  const definition = {
    presentCall: (args) => ({ card: 'generic', title: `call ${args.x}` }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.meta.value }),
  }
  const result = judgeReplay(definition, { name: 't', args: { x: 1 }, isError: false, meta: { value: 'v' }, text: 't' })
  assert.equal(result.verdict, 'pass')
})

test('a presenter that reads a clock fails replay', () => {
  // The rule presenters exist under: they run on live streaming *and* on replay.
  let tick = 0
  const definition = { presentCall: () => ({ card: 'generic', title: `t${(tick += 1)}` }) }
  const result = judgeReplay(definition, { name: 't', args: {}, isError: false, meta: undefined, text: '' })
  assert.equal(result.verdict, 'fail')
  assert.match(result.detail, /not deterministic/)
})

test('a presenter that throws on a logged call fails replay', () => {
  // Display must never crash a replay — including a replay of a log from a different version.
  const definition = { presentResult: () => { throw new Error('cannot read properties of undefined') } }
  const result = judgeReplay(definition, { name: 't', args: {}, isError: false, meta: undefined, text: '' })
  assert.equal(result.verdict, 'fail')
  assert.match(result.detail, /threw on a logged call/)
})

test('a tool with no presenters skips replay rather than passing it', () => {
  const result = judgeReplay({}, { name: 't', args: {}, isError: false, meta: undefined, text: '' })
  assert.equal(result.verdict, 'skip')
})

test('key order does not make a deterministic presenter look nondeterministic', () => {
  // `JSON.stringify` preserves insertion order, so a naive comparison would fail a pure presenter that
  // happened to build its two views with keys in a different order.
  let flip = false
  const definition = {
    presentCall: () => {
      flip = !flip
      return flip ? { b: 1, a: 2 } : { a: 2, b: 1 }
    },
  }
  assert.equal(judgeReplay(definition, { name: 't', args: {}, isError: false, meta: undefined, text: '' }).verdict, 'pass')
})
