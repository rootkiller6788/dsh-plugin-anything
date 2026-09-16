/**
 * Model-facing tools that generate, promote, verify, and install DeepSeek Harness plugin bundles.
 *
 * This package owns the tool surface and the file plan. It never reimplements the kit's rules: the static
 * gate stays in `kit/scripts/verify-plugin.mjs`, and this plugin shells out to it, so
 * there is one implementation of each rule rather than two that drift.
 *
 * @module dsh-plugin-anything-bundle
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { fromPackageRoot } from './backend.ts'
import { registerPromoteTool } from './promote.ts'
import { registerTools, type ToolOptions } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'plugin-anything'

/** Services required by this plugin. `tools` is the registry everything here registers into. */
export const inject = ['tools']

/** Plugin config. Every field has a default, so a deployment states only what it overrides. */
export interface Config {
  /**
   * Absolute path to the kit's static gate.
   * Empty means "resolve it beside this package"; the verify tool reports plainly when it cannot be found
   * rather than reporting a pass it did not perform.
   */
  verifierPath?: string
  /** Root under which new bundles are written. */
  outputDir?: string
  /** The dsh profile `plugin_anything_install` operates on. */
  profile?: string
  /** Cooperative timeout budget for one backend call, in milliseconds. */
  timeoutMs?: number
}

/** Schemastery validation for {@link Config}. Not to be confused with a tool's parameter schema. */
export const Config: z<Config> = z.object({
  verifierPath: z.string().default(''),
  outputDir: z.string().default(''),
  profile: z.string().default('dev'),
  timeoutMs: z.number().default(120_000),
})

/** The config shape after Schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/**
 * Reject values that would fail silently later.
 * A non-positive timeout does not error at the call site; it makes the abort fire immediately, which reads
 * as a backend failure. Fail loud here instead.
 * @param value - the resolved timeout.
 * @throws Error when the timeout is not a positive finite number.
 */
function assertPositiveTimeout(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('dsh-plugin-anything: timeoutMs must be a positive finite number')
  }
}

/**
 * Register the plugin-authoring toolset.
 * @param ctx - the calling plugin's context; every registration below is owned by this fiber and disposed
 *   with it, so no manual cleanup is needed.
 * @param config - validated plugin config; Schemastery has already filled every defaulted field.
 * @throws Error when the config is invalid.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveTimeout(resolved.timeoutMs)

  const outputDir = resolved.outputDir === '' ? `${process.cwd()}/plugin-anything` : resolved.outputDir

  // The verifier path is left as configured and resolved inside the tool, which is already async: an
  // unresolved path there is a reportable finding, not a reason to refuse to load the whole toolset.
  //
  // The default is this package's OWN shipped copy, not a sibling checkout. Resolving to
  // `../kit/scripts/verify-plugin.mjs` worked only where the whole repository was
  // present; for anyone installing the bundle it pointed at nothing, so `verify` could never pass. The
  // copy is kept identical to the kit's original by `scripts/check-shipped-copies.mjs`.
  const options: ToolOptions = {
    verifierPath: resolved.verifierPath,
    defaultVerifierPath: fromPackageRoot('scripts', 'verify-plugin.mjs'),
    outputDir,
    profile: resolved.profile,
    timeoutMs: resolved.timeoutMs,
  }

  registerTools(ctx, options)

  // Registered only where the cordis runtime is mounted. `cordis-host-runner` lives in the `dsh-web-app`
  // bundle and is absent from `dsh-base`, so a headless profile has nothing for this tool to read.
  registerPromoteTool(ctx, options)
}
