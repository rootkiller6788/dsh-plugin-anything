/**
 * Tests for the bundle's pure logic: template substitution, placeholder derivation, file planning, and
 * target classification.
 *
 * These run without `@deepseek-ai/*` installed, because nothing under test imports them — that is the point
 * of keeping `scaffold.ts` and `classifyTarget` pure and free of the dsh runtime.
 *
 * Run: node --experimental-strip-types --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DSH_RANGE, substitute, deriveValues, renderBundle } from '../src/scaffold.ts'
import { classifyTarget } from '../src/probe.ts'

test('substitute replaces known placeholders', () => {
  assert.equal(substitute('a {{X}} b', { X: 'y' }), 'a y b')
})

test('substitute leaves a visible marker rather than literal braces', () => {
  // Shipping a bundle whose tool description is "{{TOOL_DESCRIPTION}}" is worse than one that says what is
  // missing, so an unresolved placeholder must be loud.
  const rendered = substitute('{{MISSING}}', {})
  assert.equal(rendered, 'TODO(MISSING)')
  assert.ok(!rendered.includes('{{'))
})

test('substitute replaces every occurrence, not just the first', () => {
  assert.equal(substitute('{{X}}-{{X}}', { X: 'a' }), 'a-a')
})

test('deriveValues derives the class-style names from the target', () => {
  const values = deriveValues({
    target: 'my-widget',
    description: 'd',
    executable: 'widget',
    dshRange: DEFAULT_DSH_RANGE,
    tools: [{ name: 'widget_list', description: 'l', subcommand: 'list' }],
  })
  assert.equal(values.TARGET, 'my-widget')
  assert.equal(values.TARGET_UPPER, 'MY_WIDGET')
  assert.equal(values.TARGET_CLASS, 'MyWidget')
  assert.equal(values.TARGET_EXECUTABLE, 'widget')
})

test('deriveValues derives the tool class from a snake_case tool name', () => {
  const values = deriveValues({
    target: 'w',
    description: 'd',
    executable: 'w',
    dshRange: DEFAULT_DSH_RANGE,
    tools: [{ name: 'w_fetch_all', description: 'f', subcommand: 'fetch' }],
  })
  assert.equal(values.TOOL_CLASS, 'WFetchAll')
})

test('deriveValues refuses a bundle with no tools', () => {
  // A plugin that registers nothing is not a plugin; failing here beats writing an empty bundle that passes
  // the static gate and does nothing.
  assert.throws(() => deriveValues({
    target: 'w', description: 'd', executable: 'w', dshRange: DEFAULT_DSH_RANGE, tools: [],
  }), /at least one tool/)
})

test('renderBundle plans every required artifact', () => {
  const templates = {
    'package.json.template': '{"name":"dsh-plugin-{{TARGET}}"}',
    'cordis.patch.yml.template': "- insert:\n    - id: {{TARGET}}\n      name: 'dsh-plugin-{{TARGET}}'\n",
    'index.ts.template': 'export const name = "{{TARGET}}"',
    'provider.ts.template': 'export function resolve{{TARGET_CLASS}}() {}',
    'tool.ts.template': 'export function apply{{TOOL_CLASS}}Tool() {}',
    'tsconfig.json.template': '{}',
    'tsdown.config.ts.template': 'export default {}',
  }
  const files = renderBundle({
    target: 'widget',
    description: 'Drive widgets.',
    executable: 'widget',
    dshRange: DEFAULT_DSH_RANGE,
    tools: [
      { name: 'widget_list', description: 'List widgets.', subcommand: 'list' },
      { name: 'widget_show', description: 'Show a widget.', subcommand: 'show' },
    ],
  }, templates)

  const paths = files.map((file) => file.path)
  for (const required of [
    'package.json',
    'cordis.patch.yml',
    'tsconfig.json',
    'tsdown.config.ts',
    'src/index.ts',
    'src/provider.ts',
    'skills/dsh-plugin-widget/SKILL.md',
    'README.md',
  ]) {
    assert.ok(paths.includes(required), `missing ${required}`)
  }

  // One module per tool, mirroring the split the dsh repo uses for a multi-tool plugin.
  assert.ok(paths.includes('src/widget_list.ts'))
  assert.ok(paths.includes('src/widget_show.ts'))
})

test('renderBundle fails loud when the kit is missing a template', () => {
  assert.throws(() => renderBundle({
    target: 'w', description: 'd', executable: 'w', dshRange: DEFAULT_DSH_RANGE,
    tools: [{ name: 'w_a', description: 'a', subcommand: 'a' }],
  }, { 'package.json.template': '{}' }), /missing template/)
})

test('renderBundle leaves no unresolved placeholder in the generated skill or README', () => {
  // These two are composed rather than substituted, so this guards against regressing them back to
  // placeholder substitution.
  const templates = {
    'package.json.template': '{}',
    'cordis.patch.yml.template': '[]',
    'index.ts.template': '',
    'provider.ts.template': '',
    'tool.ts.template': '',
    'tsconfig.json.template': '{}',
    'tsdown.config.ts.template': '',
  }
  const files = renderBundle({
    target: 'widget', description: 'Drive widgets.', executable: 'widget', dshRange: DEFAULT_DSH_RANGE,
    tools: [{ name: 'widget_list', description: 'List widgets.', subcommand: 'list' }],
  }, templates)
  for (const file of files) {
    if (!file.path.endsWith('.md')) continue
    assert.ok(!file.contents.includes('{{'), `${file.path} still contains a placeholder`)
  }
  const skill = files.find((file) => file.path.endsWith('SKILL.md'))
  // A skill with invalid frontmatter is skipped silently by the loader, so its shape is worth pinning.
  assert.match(skill.contents, /^---\nname: dsh-plugin-widget\ndescription: [^\n]+\n---\n/)
  assert.match(skill.contents, /widget_list/)
})

test('classifyTarget reads the surface out of the target string', () => {
  assert.equal(classifyTarget('https://api.example.com/v1'), 'http')
  assert.equal(classifyTarget('https://api.example.com/mcp'), 'mcp')
  assert.equal(classifyTarget('https://api.example.com/sse'), 'mcp')
  assert.equal(classifyTarget('mcp://server'), 'mcp')
  assert.equal(classifyTarget('/usr/local/bin/ffmpeg'), 'cli')
  assert.equal(classifyTarget('./some/repo'), 'cli')
  assert.equal(classifyTarget('   '), 'unknown')
  assert.equal(classifyTarget(''), 'unknown')
})

test('classifyTarget does not mistake a path containing "http" for an endpoint', () => {
  // The scheme anchor matters: a directory named httpd-utils is a CLI target, not a URL.
  assert.equal(classifyTarget('./httpd-utils'), 'cli')
  assert.equal(classifyTarget('/opt/http/bin/tool'), 'cli')
})
