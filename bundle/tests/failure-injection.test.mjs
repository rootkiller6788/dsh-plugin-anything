/**
 * Failure injection: does the verdict reject what it should?
 *
 * `accept` can say `accepted`. A gate that can only say yes is not a gate, so this suite breaks the artifact
 * in nine specific ways and requires the specific verdict each break deserves. The mapping is not "anything
 * wrong ⇒ rejected", and that is the point:
 *
 *   PASS      → accepted    every stage ran and passed
 *   FAIL      → rejected    a stage ran and found a defect
 *   SKIPPED   → incomplete  a stage did not run, so the claim is unproven
 *   []        → incomplete  nothing ran, so nothing is proven
 *
 * **The invariant this suite exists to keep: absence of evidence is never evidence of acceptance.**
 *
 * The last case is the one that motivated it. `[].every(...)` is `true`, so a naive verdict function accepts
 * a run in which nothing happened — and that is precisely the acceptance a release decision gets made on.
 *
 * Run: node --experimental-strip-types --test tests/failure-injection.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, judgeBoot, judgeFromLog, judgeReplay } from '../src/accept.ts'
import { judgePackage } from '../src/pack.ts'

/** Build a stage outcome. */
const pass = (stage) => ({ stage, verdict: 'pass', detail: 'observed' })
const fail = (stage, detail = 'the defect was found') => ({ stage, verdict: 'fail', detail })
const skip = (stage, detail = 'it did not run') => ({ stage, verdict: 'skip', detail })

// ── The four rules, as an enumeration rather than as examples ────────────────────────────────────────

test('the four verdict rules hold for every combination of stage outcomes', () => {
  // Enumerated rather than sampled: a hand-picked example can miss the combination that breaks the rule,
  // and the whole value of the rule is that it holds for the one nobody thought of.
  const outcomes = ['pass', 'fail', 'skip']
  const stagesUnderTest = ['build', 'compose', 'boot']
  let combinations = 0

  // Every assignment of an outcome to each stage, including the empty one.
  const assignments = [[]]
  for (const stage of stagesUnderTest) {
    for (const partial of [...assignments]) assignments.push([...partial, stage])
  }

  for (let mask = 0; mask < outcomes.length ** stagesUnderTest.length; mask += 1) {
    const stages = stagesUnderTest.map((stage, index) =>
      ({ stage, verdict: outcomes[Math.floor(mask / outcomes.length ** index) % outcomes.length], detail: 'x' }))
    const verdict = decide(stages).verdict
    const hasFail = stages.some((s) => s.verdict === 'fail')
    const hasSkip = stages.some((s) => s.verdict === 'skip')
    const expected = hasFail ? 'rejected' : hasSkip ? 'incomplete' : 'accepted'
    assert.equal(verdict, expected, `stages ${JSON.stringify(stages.map((s) => s.verdict))} → ${verdict}`)
    combinations += 1
  }
  assert.equal(combinations, outcomes.length ** stagesUnderTest.length)
  void assignments

  // And the two degenerate cases the enumeration cannot express.
  assert.equal(decide([]).verdict, 'incomplete', 'nothing run is not an acceptance')
  assert.equal(decide([pass('build')]).verdict, 'accepted', 'one stage, passed, is an acceptance of that stage')
})

test('absence of evidence is never evidence of acceptance', () => {
  // The invariant, stated as its own assertion so the reason it exists is legible next to it.
  const nothingRan = decide([])
  assert.equal(nothingRan.verdict, 'incomplete')
  assert.match(nothingRan.reason, /no stage was run/)

  // Every shape of "some evidence, some silence" is incomplete rather than accepted.
  for (const stages of [
    [pass('build'), skip('compose')],
    [skip('build'), pass('compose')],
    [pass('build'), pass('compose'), skip('invoke')],
  ]) {
    assert.equal(decide(stages).verdict, 'incomplete', `${stages.length} stages with a skip`)
  }
})

// ── The nine injections ──────────────────────────────────────────────────────────────────────────────

test('injection 1 — wrong main: the build succeeds, the artifact is absent', () => {
  // The manifest names a file the build does not produce. Nothing else can see this: the build exits zero.
  const stages = [fail('build', 'the build succeeded but did not produce lib/index.js, which the manifest names')]
  assert.equal(decide(stages).verdict, 'rejected')
})

test('injection 2 — missing manifest file: the layer never activates', () => {
  // `dsh plugin add` installs the package as an inert dependency and prints a warning; nothing fails.
  assert.equal(decide([pass('build'), fail('compose', 'the manifest declares no dsh.bundle.patch')]).verdict, 'rejected')
})

test('injection 3 — broken peer dependency: the install fails', () => {
  assert.equal(decide([pass('build'), fail('compose', 'install failed: ERR_PNPM_NO_MATCHING_VERSION')]).verdict, 'rejected')
})

test('injection 4 — duplicate loader id: it composes, and then will not boot', () => {
  // The defect a clean `--dump-config` cannot see, which is why boot is its own stage.
  const composed = pass('compose')
  const booted = judgeBoot('dsh: plugin tree failed to load: duplicate loader entry id: code-runtime', 'widget-bundle')
  assert.equal(booted.verdict, 'fail')
  assert.equal(decide([composed, booted]).verdict, 'rejected')
})

test('injection 5 — tool undiscoverable: the model never saw it', () => {
  // No logged call is not a failure — it is the absence of evidence, and it must not read as a pass.
  const stages = judgeFromLog([], 'widget_list')
  assert.deepEqual(stages.map((s) => s.verdict), ['skip', 'skip', 'skip'])
  assert.equal(decide([pass('build'), pass('compose'), pass('boot'), ...stages]).verdict, 'incomplete')
})

test('injection 6 — tool invocation failure: the model called it and it broke', () => {
  const stages = judgeFromLog([{ name: 'widget_list', args: {}, isError: true, meta: undefined, text: 'ENOENT' }], 'widget_list')
  assert.equal(stages.find((s) => s.stage === 'invoke').verdict, 'fail')
  assert.equal(decide([pass('build'), pass('boot'), ...stages]).verdict, 'rejected')
})

test('injection 7 — malformed presenter meta: the card has nothing to read', () => {
  // The tool worked and its result carried no presentation payload. That is a hole in the claim, not a defect
  // in the tool — so it is incomplete, and the distinction matters because the fixes are different.
  const stages = judgeFromLog([{ name: 'widget_list', args: {}, isError: false, meta: undefined, text: 'ok' }], 'widget_list')
  assert.equal(stages.find((s) => s.stage === 'present').verdict, 'skip')
  assert.equal(decide([pass('build'), pass('boot'), ...stages]).verdict, 'incomplete')
})

test('injection 8 — replay mismatch: the same call rendered differently twice', () => {
  let tick = 0
  const clockReadingPresenter = { presentCall: () => ({ card: 'generic', title: `t${(tick += 1)}` }) }
  const stage = judgeReplay(clockReadingPresenter, { name: 't', args: {}, isError: false, meta: undefined, text: '' })
  assert.equal(stage.verdict, 'fail')
  assert.match(stage.detail, /not deterministic/)
  assert.equal(decide([pass('build'), pass('boot'), stage]).verdict, 'rejected')
})

test('injection 9 — missing packaged template: it works here and fails for every user', () => {
  // The defect with no local symptom: the artifact omits a directory the code reads at runtime.
  const verdict = judgePackage(
    ['lib/index.js', 'templates'],
    [{ path: 'lib/index.js', size: 10 }, { path: 'package.json', size: 10 }],
  )
  assert.equal(verdict.verdict, 'fail')
  assert.deepEqual(verdict.missing, ['templates'])
  assert.equal(decide([pass('build'), fail('package', verdict.detail)]).verdict, 'rejected')
})

// ── The whole matrix, scored ─────────────────────────────────────────────────────────────────────────

test('every injected defect produces the verdict it deserves, and none of them is accepted', () => {
  /** @type {{name: string, stages: object[], expected: string}[]} */
  const injections = [
    { name: 'wrong main', stages: [fail('build')], expected: 'rejected' },
    { name: 'missing manifest file', stages: [pass('build'), fail('compose')], expected: 'rejected' },
    { name: 'broken peer dependency', stages: [pass('build'), fail('compose')], expected: 'rejected' },
    { name: 'duplicate loader id', stages: [pass('compose'), fail('boot')], expected: 'rejected' },
    { name: 'tool undiscoverable', stages: [pass('boot'), skip('discover'), skip('invoke'), skip('present')], expected: 'incomplete' },
    { name: 'tool invocation failure', stages: [pass('boot'), pass('discover'), fail('invoke')], expected: 'rejected' },
    { name: 'malformed presenter meta', stages: [pass('boot'), pass('discover'), pass('invoke'), skip('present')], expected: 'incomplete' },
    { name: 'replay mismatch', stages: [pass('boot'), pass('present'), fail('replay')], expected: 'rejected' },
    { name: 'missing packaged template', stages: [pass('build'), fail('package')], expected: 'rejected' },
    { name: 'nothing ran', stages: [], expected: 'incomplete' },
  ]

  for (const injection of injections) {
    const verdict = decide(injection.stages).verdict
    assert.equal(verdict, injection.expected, `${injection.name}: expected ${injection.expected}, got ${verdict}`)
    assert.notEqual(verdict, 'accepted', `${injection.name} was accepted`)
  }
})
