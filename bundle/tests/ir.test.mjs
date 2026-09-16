/**
 * The Capability IR's invariants, and the validator that enforces them.
 *
 * The IR is a boundary: frontends write it, the backend reads it. A boundary validator that only ever
 * accepts is not a validator, so every rejection path below is exercised against a document that should
 * fail it — the same discipline the kit's gate tests use.
 *
 * Run: node --experimental-strip-types --test tests/ir.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IR_VERSION, validateCapabilitySet, serialize, parse } from '../src/ir.ts'
import { STAGES, PATHS, ACCEPTANCE_TAIL, coverage, stage } from '../src/pipeline.ts'

/**
 * A minimal valid capability, so each test can mutate exactly one field.
 * @param {object} [overrides] - fields to overlay onto the capability.
 * @returns {object} a capability set.
 */
function validSet(overrides = {}) {
  return {
    irVersion: IR_VERSION,
    target: {
      name: 'git',
      description: 'Distributed version control.',
      source: { kind: 'cli', location: '/usr/bin/git' },
    },
    capabilities: [{
      id: 'status',
      name: 'Status',
      description: 'Show the working tree status.',
      source: { kind: 'cli', location: '/usr/bin/git', version: '2.50.1' },
      invocation: { type: 'exec', command: '/usr/bin/git', args: ['status', '--porcelain'] },
      inputs: [],
      outputs: [{ name: 'stdout', description: 'Porcelain status lines.', type: 'string' }],
      dependencies: [],
      environment: [],
      permissions: { filesystem: ['**'], network: [], process: true, secrets: [] },
      evidence: [{ stage: 'inspect', observed: '`git status --porcelain` printed two modified paths' }],
      confidence: 'observed',
      lifecycle: {},
      ...overrides,
    }],
  }
}

test('accepts a well-formed capability set', () => {
  assert.deepEqual(validateCapabilitySet(validSet()), [])
})

test('round-trips through serialize and parse', () => {
  const set = validSet()
  assert.deepEqual(parse(serialize(set)), set)
})

test('refuses an unknown irVersion rather than skipping it', () => {
  // The failure mode a version field exists to prevent: a reader that ignores what it does not understand
  // emits a plugin missing capabilities, with nothing saying so.
  const problems = validateCapabilitySet({ ...validSet(), irVersion: IR_VERSION + 1 })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /refuses unknown versions/)
})

test('rejects a capability id that is not kebab-case, and a duplicate id', () => {
  assert.match(validateCapabilitySet(validSet({ id: 'Git Status' }))[0], /lowercase kebab-case/)
  const set = validSet()
  set.capabilities.push({ ...set.capabilities[0] })
  assert.ok(validateCapabilitySet(set).some((p) => /duplicated/.test(p)))
})

test('rejects "confirmed" confidence with no evidence', () => {
  // Claiming a run that was not recorded: the field that makes confidence auditable would otherwise be a
  // vibe.
  const problems = validateCapabilitySet(validSet({ confidence: 'confirmed', evidence: [] }))
  assert.ok(problems.some((p) => /"confirmed" but no evidence/.test(p)))
})

test('rejects permission claims with nothing to support them', () => {
  // Empty permissions read as "touches nothing", which is the one reading that must never be wrong by
  // accident — a generated plugin runs unsandboxed.
  const problems = validateCapabilitySet(validSet({
    permissions: { filesystem: [], network: [], process: false, secrets: [] },
    evidence: [],
  }))
  assert.ok(problems.some((p) => /permissions claims no/.test(p)))
})

test('accepts empty permissions when something supports the claim', () => {
  const problems = validateCapabilitySet(validSet({
    permissions: { filesystem: [], network: [], process: false, secrets: [] },
    evidence: [{ stage: 'inspect', observed: 'the subcommand reads stdin and writes stdout only' }],
  }))
  assert.deepEqual(problems, [])
})

test('rejects an argument template that references an undeclared input', () => {
  // Otherwise the tool calls the target with a literal `{{path}}` still in the command line.
  const problems = validateCapabilitySet(validSet({
    invocation: { type: 'exec', command: 'git', args: ['log', '--max-count', '{{limit}}'] },
    inputs: [],
  }))
  assert.ok(problems.some((p) => /references \{\{limit\}\}/.test(p)))
})

test('accepts an argument template whose inputs are declared', () => {
  const problems = validateCapabilitySet(validSet({
    invocation: { type: 'exec', command: 'git', args: ['log', '--max-count', '{{limit}}'] },
    inputs: [{ name: 'limit', description: 'How many commits.', type: 'integer', required: true }],
  }))
  assert.deepEqual(problems, [])
})

// ── The pipeline definition itself ──────────────────────────────────────────────────────────────────

test('every stage id is unique and every ordinal is stable', () => {
  const ids = STAGES.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate stage id')
  assert.deepEqual(
    STAGES.map((s) => s.ordinal),
    Array.from({ length: STAGES.length }, (_, i) => i + 1),
    'ordinals must be 1..n with no gaps — a report cites them by number',
  )
})

test('every path names stages that exist', () => {
  for (const path of PATHS) {
    for (const id of path.stages) {
      assert.ok(stage(id) !== undefined, `path "${path.input}" names unknown stage "${id}"`)
    }
  }
})

test('mcp is a terminal path, not a shortcut', () => {
  // An MCP target must stop rather than produce an artifact — generating a plugin duplicates a route that
  // already works. Encoding that here keeps a future refactor from "fixing" it.
  const mcp = PATHS.find((p) => p.input === 'mcp')
  assert.deepEqual(mcp.stages, ['detect'])
  assert.match(mcp.note, /TERMINAL/)
})

test('every non-terminal path ends in the acceptance tail', () => {
  // Whatever produced the artifact, an agent has to end up having used it. A path that stops earlier is an
  // unfinished run, not a shortcut.
  for (const path of PATHS.filter((p) => p.input !== 'mcp')) {
    const tail = path.stages.slice(-ACCEPTANCE_TAIL.length)
    assert.deepEqual(tail, [...ACCEPTANCE_TAIL], `path "${path.input}" does not end in the acceptance tail`)
  }
})

test('coverage groups partition the pipeline exactly once', () => {
  const { mechanized, owed, byAgent, supported, external } = coverage()
  assert.ok(mechanized.every((s) => s.owner !== 'agent' && s.owner !== 'external' && s.tool !== undefined))
  assert.ok(owed.every((s) => s.owner !== 'agent' && s.owner !== 'external' && s.tool === undefined))
  assert.ok(byAgent.every((s) => s.owner === 'agent' && s.tool === undefined))
  assert.ok(supported.every((s) => s.owner === 'agent' && s.tool !== undefined))
  assert.ok(external.every((s) => s.owner === 'external'))

  // The partition. An earlier version put every agent stage in one group and every tooled stage in another,
  // so `inspect` — agent-owned *and* tooled — was counted twice and the totals did not add up. That is how
  // the mistake surfaced, and it is why this asserts both the sum and the disjointness.
  const all = [...mechanized, ...owed, ...byAgent, ...supported, ...external]
  assert.equal(
    all.length,
    STAGES.length,
    `the coverage groups must partition the pipeline: ${all.length} !== ${STAGES.length}`,
  )
  const ids = all.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, `a stage appears in more than one group: ${ids.join(', ')}`)
  // Every stage is accounted for by id, not merely by count.
  assert.deepEqual([...ids].sort(), STAGES.map((s) => s.id).sort())
})
