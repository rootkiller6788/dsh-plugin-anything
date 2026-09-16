/**
 * The backend: Capability IR in, plugin source out.
 *
 * The tests fall into two groups. The first checks that compiling is *correct* — the declared inputs become
 * parameters, the invocation becomes a bound command line, the single-egress rule survives. The second
 * checks the invariant that makes the IR worth having at all: **the backend does not learn which frontend
 * ran.** If that one ever fails, this project is a code generator with a spec-shaped comment.
 *
 * Run: node --experimental-strip-types --test tests/compile.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileCapabilitySet, compilePackaging } from '../src/compile.ts'
import { IR_VERSION } from '../src/ir.ts'

/**
 * A capability set with one capability, so each test can mutate one thing.
 * @param {object} [capability] - fields to overlay onto the capability.
 * @param {object} [target] - fields to overlay onto the target.
 * @returns {object} a capability set.
 */
function set(capability = {}, target = {}) {
  return {
    irVersion: IR_VERSION,
    target: {
      name: 'widget',
      description: 'A widget toolchain.',
      source: { kind: 'cli', location: '/usr/bin/widget' },
      ...target,
    },
    capabilities: [{
      id: 'list-items',
      name: 'List items',
      description: 'List the widgets in a project.',
      source: { kind: 'cli', location: '/usr/bin/widget', version: '1.2.3' },
      invocation: { type: 'exec', command: '/usr/bin/widget', args: ['list', '--limit', '{{limit}}'] },
      inputs: [{ name: 'limit', description: 'How many to list.', type: 'integer', required: true }],
      outputs: [{ name: 'stdout', description: 'One widget per line.', type: 'string' }],
      dependencies: [],
      environment: [],
      permissions: { filesystem: ['/usr/bin/widget'], network: [], process: true, secrets: [] },
      evidence: [{ stage: 'inspect', observed: '`widget list --limit 3` printed three lines' }],
      confidence: 'observed',
      lifecycle: {},
      ...capability,
    }],
  }
}

/**
 * Find a compiled file by path.
 * @param {object} result - the compile result.
 * @param {string} path - the path to find.
 * @returns {string} the file's contents.
 */
function file(result, path) {
  const found = result.files.find((f) => f.path === path)
  assert.ok(found !== undefined, `no file at ${path}; got ${result.files.map((f) => f.path).join(', ')}`)
  return found.contents
}

test('compiles one tool module per capability', () => {
  const result = compileCapabilitySet(set())
  assert.ok(result.files.some((f) => f.path === 'src/list-items.ts'))
  assert.ok(result.files.some((f) => f.path === 'src/index.ts'))
  assert.ok(result.files.some((f) => f.path === 'src/provider.ts'))
})

test('declared inputs become parameters, with requiredness preserved', () => {
  const source = file(compileCapabilitySet(set()), 'src/list-items.ts')
  assert.match(source, /"limit": \{ type: 'integer', description: .*required: true \}/)
  // The description reaches the model, so it must be the IR's, not a placeholder.
  assert.match(source, /How many to list\./)
})

test('an optional input is not marked required', () => {
  const source = file(compileCapabilitySet(set({
    inputs: [{ name: 'limit', description: 'How many.', type: 'integer', required: false }],
  })), 'src/list-items.ts')
  assert.ok(!source.includes('required: true'), 'an optional input must not be marked required')
})

test('a string enum survives into the parameter schema', () => {
  const source = file(compileCapabilitySet(set({
    inputs: [{ name: 'format', description: 'Output format.', type: 'string', required: false, enum: ['text', 'json'] }],
  })), 'src/list-items.ts')
  assert.match(source, /enum: \["text", "json"\]/)
})

test('the tool name is the capability id with underscores', () => {
  // A model calls this; a hyphen in a function name is not universally callable.
  const source = file(compileCapabilitySet(set()), 'src/list-items.ts')
  assert.match(source, /name: TOOL_NAME/)
  assert.match(source, /export const TOOL_NAME = "list_items"/)
})

test('every compiled module imports its egress from provider.ts and nowhere else', () => {
  // The rule this project holds its own bundle to, applied to what it generates.
  const cases = [
    { label: 'exec', capability: set(), egress: /node:child_process/ },
    {
      label: 'http',
      capability: set({
        invocation: { type: 'http', transport: 'https://example.test/api' },
        permissions: { filesystem: [], network: ['example.test'], process: false, secrets: [] },
      }),
      egress: /export async function invokeHttp/,
    },
  ]
  for (const { label, capability, egress } of cases) {
    const result = compileCapabilitySet(capability)
    for (const f of result.files.filter((x) => x.path.startsWith('src/'))) {
      const reachesOut = /from 'node:(child_process|fs|http|https)'|globalThis\.fetch|\bfetch\(/
      if (f.path === 'src/provider.ts') continue
      assert.ok(!reachesOut.test(f.contents), `${label}: ${f.path} reaches outside the process; only provider.ts may`)
    }
    // The egress the transport calls for is present; the one it does not is absent.
    assert.match(file(result, 'src/provider.ts'), egress, `${label}: wrong egress`)
  }
})

test('an http capability compiles to the http egress, not the exec one', () => {
  const result = compileCapabilitySet(set({
    invocation: { type: 'http', transport: 'https://example.test/api' },
    permissions: { filesystem: [], network: ['example.test'], process: false, secrets: [] },
  }))
  assert.match(file(result, 'src/list-items.ts'), /invokeHttp/)
  assert.match(file(result, 'src/provider.ts'), /export async function invokeHttp/)
  assert.ok(!file(result, 'src/provider.ts').includes('node:child_process'), 'an http-only set needs no child_process')
})

test('an exec-only set does not ship the http egress', () => {
  // Generating an unused network function would put a capability in the bundle that nothing asked for.
  const result = compileCapabilitySet(set())
  assert.ok(!file(result, 'src/provider.ts').includes('invokeHttp'))
})

test('an MCP capability is refused, because MCP is a terminal path', () => {
  // Compiling it would produce a plugin that duplicates the bridge dsh already has.
  assert.throws(
    () => compileCapabilitySet(set({ invocation: { type: 'mcp', transport: 'widget-server' } })),
    /MCP capabilities.*terminal path/s,
  )
})

test('the compiler names what it declined to invent', () => {
  const result = compileCapabilitySet(set({
    invocation: { type: 'http', transport: 'https://example.test' },
    // No network permission declared for an http invocation: one of the two is wrong and the IR cannot say which.
    permissions: { filesystem: [], network: [], process: false, secrets: ['API_TOKEN'] },
    outputs: [{ name: 'body', description: 'The response.', type: 'object' }],
  }))
  assert.ok(result.warnings.some((w) => /declares no network host/.test(w)))
  assert.ok(result.warnings.some((w) => /untyped object/.test(w)))
  assert.ok(result.warnings.some((w) => /consumes secrets/.test(w)))
  // Every warning names its capability, so a reader knows what to fix.
  assert.ok(result.warnings.every((w) => w.startsWith('list-items:')))
})

test('a clean set produces no warnings', () => {
  assert.deepEqual(compileCapabilitySet(set()).warnings, [])
})

// ── The invariant that makes the IR worth having ────────────────────────────────────────────────────

test('the backend does not learn which frontend ran', () => {
  // Two frontends describing the same capability, differing ONLY in provenance. Everything a backend may
  // read — invocation, inputs, outputs, permissions, lifecycle — is identical.
  const asCli = set({ source: { kind: 'cli', location: '/usr/bin/widget', version: '1.2.3' } })
  const asOpenapi = set({ source: { kind: 'openapi', location: 'https://widget.test/openapi.json' } })

  const a = compileCapabilitySet(asCli)
  const b = compileCapabilitySet(asOpenapi)

  /**
   * Remove recorded provenance, and nothing else.
   *
   * The contract is precise: the backend may *record* where a capability came from — a reviewer needs that —
   * but it may not *decide* from it. So every line that names the source is stripped, and the assertion is
   * that what remains is byte-identical.
   *
   * The first version of this test stripped only the JSDoc line and failed, because the README carries one
   * too. That was the test being right about the shape of the rule and wrong about where provenance appears.
   */
  const strip = (result) => result.files.map((f) => ({
    path: f.path,
    contents: f.contents
      .replace(/^ \* Provenance:.*$/gm, '')
      .replace(/^ \* Do not read the provenance above.*$/gm, '')
      // Everything from `Provenance:` to the end of its line. A per-token regex left the version suffix
      // behind (` (1.2.3).`) — provenance is a sentence, and half of one is still provenance.
      .replace(/Provenance:.*$/gm, ''),
  }))

  assert.deepEqual(
    strip(b),
    strip(a),
    'compiling the same capability from two frontends must produce identical source, modulo recorded '
    + 'provenance: the backend reads capabilities, not sources',
  )
})

test('the provenance is still recorded in the source', () => {
  // Not a dependency — a record. A reviewer needs to know where a compiled capability came from.
  const source = file(compileCapabilitySet(set()), 'src/list-items.ts')
  assert.match(source, /Provenance: cli at \/usr\/bin\/widget \(1\.2\.3\)/)
})

test('compiling is deterministic', () => {
  assert.deepEqual(compileCapabilitySet(set()), compileCapabilitySet(set()))
})

test('packaging comes from the templates, not from the IR', () => {
  // The manifest and the patch describe the packaging. Rendering them from the IR would put capability
  // details in files whose job is to describe a package.
  const templates = {
    'package.json.template': '{"name":"{{TARGET}}"}',
    'cordis.patch.yml.template': "- insert:\n    - id: {{TARGET}}\n      name: '{{TARGET}}'\n",
    'tsconfig.json.template': '{}',
    'tsdown.config.ts.template': '',
  }
  const files = compilePackaging(set(), templates, {
    TARGET: 'widget', TARGET_CLASS: 'Widget', TARGET_EXECUTABLE: 'widget',
    ONE_LINE_DESCRIPTION: 'd', DSH_RANGE: '^0.1.5-rc.2',
  })
  assert.equal(files.find((f) => f.path === 'package.json').contents, '{"name":"widget"}')
})
