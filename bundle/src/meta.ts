/**
 * Narrowing helpers for `ToolResult['meta']`.
 *
 * A presenter receives a `ToolResult` — `{ content, isError, meta? }` — not the tool's canonical value. The
 * canonical value is not on the wire, so any structured data a card needs must be projected into `meta` by
 * the definition's `presentationMeta` and narrowed back out here.
 *
 * Every helper declines to `undefined` rather than throwing. A log recorded by a different version of this
 * tool must render as the generic fallback, never crash a replay. The dsh repo's own `diffsFromMeta` and
 * `readMetaFromMeta` follow the same rule.
 *
 * @module dsh-plugin-anything-bundle/meta
 */

/**
 * Read a string field from an opaque meta payload.
 * @param meta - the result's presentation payload, as logged.
 * @param key - the field name.
 * @returns the string, or undefined when absent or not a string.
 */
function stringField(meta: unknown, key: string): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const value = (meta as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read an array-of-strings field from an opaque meta payload.
 * @param meta - the result's presentation payload, as logged.
 * @param key - the field name.
 * @returns the array, or undefined when absent, not an array, or not all strings.
 */
function stringArrayField(meta: unknown, key: string): string[] | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const value = (meta as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return undefined
  return value.every((entry) => typeof entry === 'string') ? value : undefined
}

/**
 * Read a boolean field from an opaque meta payload.
 * @param meta - the result's presentation payload, as logged.
 * @param key - the field name.
 * @returns the boolean, or undefined when absent or not a boolean.
 */
function booleanField(meta: unknown, key: string): boolean | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const value = (meta as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}

/** The payload `plugin_anything_probe` projects. */
export interface ProbeMeta {
  /** The classified surface. */
  readonly kind: string
  /** What the caller should do next. */
  readonly recommendation: string
}

/**
 * Narrow a probe result's meta.
 * @param meta - the result's presentation payload, as logged.
 * @returns the narrowed payload, or undefined when it does not match.
 */
export function probeMeta(meta: unknown): ProbeMeta | undefined {
  const kind = stringField(meta, 'kind')
  const recommendation = stringField(meta, 'recommendation')
  return kind === undefined || recommendation === undefined ? undefined : { kind, recommendation }
}

/** The payload `plugin_anything_scaffold` and `plugin_anything_promote` project. */
export interface FilesMeta {
  /** The bundle root the files were written under. */
  readonly root: string
  /** The paths written, relative to the root. */
  readonly written: readonly string[]
}

/**
 * Narrow a file-writing result's meta.
 * @param meta - the result's presentation payload, as logged.
 * @returns the narrowed payload, or undefined when it does not match.
 */
export function filesMeta(meta: unknown): FilesMeta | undefined {
  const root = stringField(meta, 'root')
  const written = stringArrayField(meta, 'written')
  return root === undefined || written === undefined ? undefined : { root, written }
}

/**
 * Narrow a verify result's meta.
 * @param meta - the result's presentation payload, as logged.
 * @returns whether the gate passed, or undefined when the payload does not match.
 */
export function passedMeta(meta: unknown): { ok: boolean } | undefined {
  const ok = booleanField(meta, 'ok')
  return ok === undefined ? undefined : { ok }
}

/**
 * Narrow an install result's meta.
 * @param meta - the result's presentation payload, as logged.
 * @returns the captured output, or undefined when the payload does not match.
 */
export function outputMeta(meta: unknown): { output: string } | undefined {
  const output = stringField(meta, 'output')
  return output === undefined ? undefined : { output }
}

/** The payload `plugin_anything_inspect` projects. */
export interface InspectMeta {
  /** The entrypoint inspected. */
  readonly entrypoint: string
  /** How many subcommands were read. */
  readonly commands: number
  /** Whether the budget cut the inspection short. */
  readonly truncated: boolean
}

/**
 * Narrow an inspect result's meta.
 * @param meta - the result's presentation payload, as logged.
 * @returns the narrowed payload, or undefined when it does not match.
 */
export function inspectMeta(meta: unknown): InspectMeta | undefined {
  const entrypoint = stringField(meta, 'entrypoint')
  const truncated = booleanField(meta, 'truncated')
  if (typeof meta !== 'object' || meta === null) return undefined
  const commands = (meta as Record<string, unknown>).commands
  if (entrypoint === undefined || truncated === undefined || typeof commands !== 'number') return undefined
  return { entrypoint, commands, truncated }
}

/** The payload `plugin_anything_accept` projects. */
export interface AcceptMeta {
  /** The one-word verdict. */
  readonly verdict: string
  /** Each stage as `name:verdict`, so a card can count failures without carrying the full detail. */
  readonly stages: readonly string[]
}

/**
 * Narrow an accept result's meta.
 * @param meta - the result's presentation payload, as logged.
 * @returns the narrowed payload, or undefined when it does not match.
 */
export function acceptMeta(meta: unknown): AcceptMeta | undefined {
  const verdict = stringField(meta, 'verdict')
  const stages = stringArrayField(meta, 'stages')
  return verdict === undefined || stages === undefined ? undefined : { verdict, stages }
}
