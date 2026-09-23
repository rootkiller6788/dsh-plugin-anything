/**
 * Bundle scaffolding: turn a description of a target into the set of files a bundle consists of.
 *
 * Pure. Nothing here touches the filesystem — it returns a plan that `backend.writeBundle` executes. That
 * split is what makes the rendering testable without a temp directory.
 *
 * @module dsh-plugin-anything-bundle/scaffold
 */

import type { PlannedFile } from './backend.ts'

/**
 * The default `@deepseek-ai/dsh-*` range a generated bundle peers on.
 *
 * **The trailing prerelease tag is load-bearing, not decoration.** `dsh` publishes no stable release — every
 * published version is a prerelease (`0.1.5-rc.2`, `0.1.6-alpha.1`, …). Semver only lets a prerelease
 * version satisfy a range when a comparator in that range carries a prerelease tag with the same
 * `major.minor.patch` tuple. So:
 *
 *   `^0.1.5`        desugars to `>=0.1.5 <0.2.0` — no prerelease tag, so it matches NOTHING that exists.
 *   `^0.1.5-rc.2`   matches `0.1.5-rc.2`.
 *
 * A generated bundle with `^0.1.5` installs nowhere. Verified by resolving both against the registry:
 * `npm view @deepseek-ai/dsh-tools@^0.1.5 version` is a 404.
 *
 * Note the range is line-specific: `^0.1.5-rc.2` does NOT match `0.1.6-alpha.1`, because the patch tuple
 * differs. A bundle must track the `dsh` line its user runs, which is why `plugin_anything_scaffold`
 * accepts an explicit `dshRange`.
 */
export const DEFAULT_DSH_RANGE = '^0.1.5-rc.2'

/** One tool the bundle will expose. */
export interface ToolSpec {
  /** The tool name the model will call, snake_case. */
  readonly name: string
  /** The one-line description the model reads. */
  readonly description: string
  /** The subcommand this tool passes to the target. */
  readonly subcommand: string
}

/** Everything the renderer needs to produce a bundle. */
export interface BundleSpec {
  /** Lowercase kebab-case target slug, e.g. `git`. */
  readonly target: string
  /** One line describing what the plugin does, used as the package description. */
  readonly description: string
  /** The target's executable name. */
  readonly executable: string
  /** The `@deepseek-ai/dsh-*` range to peer on. */
  readonly dshRange: string
  /** The tools to expose. At least one. */
  readonly tools: readonly ToolSpec[]
}

/** The resolved template texts, keyed by template filename. */
export type TemplateSet = Readonly<Record<string, string>>

/**
 * Substitute `{{NAME}}` placeholders in a template.
 *
 * An unresolved placeholder becomes a visible `TODO` rather than shipping as literal braces: a bundle that
 * loads with `{{TOOL_DESCRIPTION}}` as a tool description is worse than one that plainly says what is
 * missing.
 *
 * @param template - the template text.
 * @param values - placeholder name to replacement.
 * @returns the rendered text.
 */
export function substitute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name: string) => {
    const value = values[name]
    return value === undefined ? `TODO(${name})` : value
  })
}

/**
 * Convert an identifier-ish name to PascalCase.
 *
 * Splits on every non-alphanumeric, so both `git_status` (a tool name) and `my-widget` (a target slug)
 * produce a usable identifier. Deriving identifiers by hand-substituting a raw snake_case name into a
 * template is how `applygit_statusTool` gets emitted — this exists so that cannot happen.
 *
 * @param name - the name to convert.
 * @returns the PascalCase form.
 */
export function pascal(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * Derive the placeholder values a template needs from a bundle spec.
 * @param spec - the bundle spec.
 * @returns placeholder name to value.
 */
export function deriveValues(spec: BundleSpec): Record<string, string> {
  const primary = spec.tools[0]
  if (primary === undefined) throw new Error('a bundle needs at least one tool')
  return {
    TARGET: spec.target,
    TARGET_UPPER: spec.target.toUpperCase().replace(/[^A-Z0-9]/g, '_'),
    TARGET_CLASS: pascal(spec.target),
    TARGET_EXECUTABLE: spec.executable,
    ONE_LINE_DESCRIPTION: spec.description,
    DSH_RANGE: spec.dshRange,
    TOOL_NAME: primary.name,
    TOOL_MODULE: primary.name,
    TOOL_CLASS: pascal(primary.name),
    TOOL_DESCRIPTION: primary.description,
    TOOL_SUBCOMMAND: primary.subcommand,
    // Built from the whole tool list rather than fixed per-tool placeholders: a template with `{{TOOL_A}}`,
    // `{{TOOL_B}}`, `{{TOOL_C}}` cannot express one tool or five, and leaves TODO noise in the gaps.
    TOOL_IMPORTS: spec.tools
      .map((tool) => `import { apply${pascal(tool.name)}Tool } from './${tool.name}.ts'`)
      .join('\n'),
    TOOL_REGISTRATIONS: spec.tools
      .map((tool) => `  apply${pascal(tool.name)}Tool(ctx, options)`)
      .join('\n'),
  }
}

/**
 * Compose the `SKILL.md` for a bundle.
 *
 * Written fresh rather than substituted from the template, because this content is derived from the tool
 * list — the template's prose skeleton would only invite leaving placeholder text in a shipped skill.
 *
 * @param spec - the bundle spec.
 * @returns the skill document.
 */
function renderSkill(spec: BundleSpec): string {
  const rows = spec.tools.map((tool) => `| \`${tool.name}\` | ${tool.description} |`).join('\n')
  return `---
name: dsh-plugin-${spec.target}
description: Drive ${spec.target} from dsh: ${spec.description}
---

# ${spec.target}

This skill covers driving ${spec.target} through the \`dsh-plugin-${spec.target}\` tools.

## Prerequisites

- \`${spec.executable}\` is installed and on \`PATH\`, or its absolute path is supplied as the plugin's
  \`command\` config.

## Tools

| Tool | Use it for |
|---|---|
${rows}

## Notes

- Every tool passes its arguments to the real \`${spec.executable}\` binary. The plugin never reimplements it.
`
}

/**
 * Compose the bundle's `README.md`.
 * @param spec - the bundle spec.
 * @returns the README.
 */
function renderReadme(spec: BundleSpec): string {
  const rows = spec.tools.map((tool) => `| \`${tool.name}\` | ${tool.description} |`).join('\n')
  return `# dsh-plugin-${spec.target}

${spec.description}

## Prerequisites

- \`${spec.executable}\` on \`PATH\`, or set the \`command\` config to an absolute path.

## Install

\`\`\`sh
dsh plugin --profile <profile> add dsh-plugin-${spec.target}
dsh --profile <profile> --dump-config | grep -A3 '# == dsh-plugin-${spec.target}'
\`\`\`

## Tools

| Tool | Use it for |
|---|---|
${rows}

## Verify

The kit's static gate is not part of this bundle — copying it in would be a second copy to keep in step
with the kit's own. Run it from the kit that generated this bundle, or through the toolset, which runs
the same gate:

\`\`\`sh
node <path-to-kit>/scripts/verify-plugin.mjs .
# or, with plugin_anything installed:
#   plugin_anything_verify({ path: '.' })
\`\`\`

Then this bundle's own tests. \`test\` is this package's script, so the runner is whatever
\`package.json\` names rather than a second command written out here:

\`\`\`sh
pnpm test
\`\`\`
`
}

/**
 * Render the complete file plan for a bundle.
 * @param spec - the bundle spec.
 * @param templates - the kit's template texts.
 * @returns the files to write, relative to the bundle root.
 */
export function renderBundle(spec: BundleSpec, templates: TemplateSet): PlannedFile[] {
  const values = deriveValues(spec)
  /**
   * Render one template, failing loud when the kit does not ship it — a silently missing artifact would
   * produce a bundle that looks complete and is not.
   * @param name - the template filename.
   * @returns the rendered text.
   */
  const render = (name: string): string => {
    const template = templates[name]
    if (template === undefined) throw new Error(`missing template: ${name}`)
    return substitute(template, values)
  }

  const pkg = render('package.json.template')
  const files: PlannedFile[] = [
    { path: 'package.json', contents: pkg },
    { path: 'cordis.patch.yml', contents: render('cordis.patch.yml.template') },
    { path: 'tsconfig.json', contents: render('tsconfig.json.template') },
    { path: 'tsdown.config.ts', contents: render('tsdown.config.ts.template') },
    { path: 'src/index.ts', contents: render('index.ts.template') },
    { path: 'src/provider.ts', contents: render('provider.ts.template') },
    { path: 'skills/dsh-plugin-' + spec.target + '/SKILL.md', contents: renderSkill(spec) },
    { path: 'README.md', contents: renderReadme(spec) },
  ]

  // Every tool gets its own module, mirroring the split the dsh repo uses for a multi-tool plugin.
  for (const tool of spec.tools) {
    files.push({
      path: `src/${tool.name}.ts`,
      contents: substitute(templates['tool.ts.template'] ?? '', {
        ...values,
        TOOL_NAME: tool.name,
        TOOL_MODULE: tool.name,
        TOOL_DESCRIPTION: tool.description,
        TOOL_SUBCOMMAND: tool.subcommand,
        TOOL_CLASS: pascal(tool.name),
      }),
    })
  }
  return files
}
