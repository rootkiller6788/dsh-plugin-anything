/**
 * Capability IR — the intermediate representation every frontend compiles into and the backend compiles out of.
 *
 * Without it the pipeline is not a pipeline: each run re-derives everything from scratch. `git` goes in, an
 * agent reads it and writes a plugin; `postgresql` goes in, an agent reads *it* and writes a plugin — and the
 * two share nothing but the agent's mood. "Anything" then means "anything, one bespoke run at a time",
 * which is a code generator with extra steps.
 *
 * With it, the shape is a compiler:
 *
 *     Frontends                IR                 Backend
 *     cli    ─┐                                  ┌─ dsh plugin
 *     http   ─┤                                  │
 *     mcp    ─┼──>  CapabilitySet  ──> policy ──>┤
 *     openapi─┤       (this file)                │
 *     repo   ─┘                                  └─ (future host)
 *
 * Two properties are load-bearing:
 *
 * 1. **The backend never learns which frontend ran.** It reads capabilities, not sources. Adding a frontend
 *    must not require touching the backend; the day it does, this file has stopped being an IR and become a
 *    serialization of one frontend's output.
 * 2. **`evidence` and `confidence` are first-class, not annotations.** A capability inferred from a
 *    subcommand's help text and one confirmed by running it are different facts, and the pipeline's honesty
 *    depends on being able to tell them apart. This project's other gates draw the same distinction between
 *    "passed" and "never ran" — an IR that flattens them would undo it.
 *
 * @module dsh-plugin-anything-bundle/ir
 */

/**
 * The IR's on-disk format version.
 *
 * Bumped only for a structural change, because frontends write it and the backend reads it, possibly across
 * versions. A reader that does not know a version must refuse the document rather than skip what it does not
 * recognise — the failure mode a version field exists to prevent.
 */
export const IR_VERSION = 1

/** Where a capability came from, and how far to trust that it is still true. */
export interface CapabilitySource {
  /** Which frontend produced this. */
  readonly kind: 'cli' | 'http' | 'mcp' | 'openapi' | 'python' | 'npm' | 'repo' | 'script' | 'dynamic'
  /** A stable locator: an absolute path, a command name, a URL, or a package specifier. */
  readonly location: string
  /** The target's own version, when it reports one. Absent is not the same as unknown-and-ignored. */
  readonly version?: string
}

/** How the capability is reached. */
export interface Invocation {
  /** The transport a backend must implement to reach it. */
  readonly type: 'exec' | 'http' | 'mcp' | 'in-process'
  /** For `exec`: the program. Resolved, not assumed. */
  readonly command?: string
  /** For `exec`: the argument template, with `{{name}}` placeholders bound to this capability's inputs. */
  readonly args?: readonly string[]
  /** For `exec`: text written to stdin, when the target takes its input that way. */
  readonly stdin?: string
  /** For `http`/`mcp`: the URL, or the MCP server name. */
  readonly transport?: string
}

/** One input a capability accepts. */
export interface CapabilityInput {
  /** Identifier, referenced by the argument template and by the tool's parameters. */
  readonly name: string
  /** One line, written for a model to read. */
  readonly description: string
  /** A primitive IR type. Kept small on purpose: the backend maps these onto the host's schema DSL. */
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  /** Whether the capability is meaningful without it. */
  readonly required: boolean
  /** Permitted values, when the interface enumerates them. */
  readonly enum?: readonly string[]
}

/** What a capability produces. */
export interface CapabilityOutput {
  /** Identifier, referenced by the renderer. */
  readonly name: string
  /** One line describing what the value means. */
  readonly description: string
  /** A primitive IR type. */
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
}

/** What the capability needs that the target does not supply itself. */
export interface CapabilityEnvironment {
  /** A variable name the target reads. */
  readonly name: string
  /** Whether the capability is usable without it. */
  readonly required: boolean
  /** Whether it is a secret — which decides how it is supplied, never whether it is logged. */
  readonly secret: boolean
  /** One line describing what it is for. */
  readonly description: string
}

/**
 * What the capability does to the machine it runs on.
 *
 * Declared, not discovered: a generated plugin runs unsandboxed, so a statement of what it touches is what
 * lets a user — or a policy stage — decide whether to accept it. A frontend that cannot determine this says
 * so in `evidence` rather than leaving the field empty, because an empty `permissions` reads as "touches
 * nothing" and that is the one reading that must never be wrong by accident.
 */
export interface Permissions {
  /** Paths read or written, as patterns. */
  readonly filesystem: readonly string[]
  /** Hosts contacted, as patterns. Empty means none. */
  readonly network: readonly string[]
  /** Whether the capability spawns a process. */
  readonly process: boolean
  /** Environment names or credential references it consumes. Mirrors `environment`, repeated here so a
   * policy stage can read the whole risk surface from one field. */
  readonly secrets: readonly string[]
}

/**
 * One observation supporting a capability.
 *
 * `observed` distinguishes what was seen from what was assumed: a line of `--help` output, an HTTP response,
 * a schema entry. This is the field that makes `confidence` auditable rather than a vibe.
 */
export interface Evidence {
  /** The stage that produced the observation. */
  readonly stage: 'detect' | 'inspect' | 'extract' | 'promote'
  /** What was observed, concretely enough to re-check. */
  readonly observed: string
}

/**
 * How much to trust a capability.
 *
 * - `confirmed` — exercised, and it worked. One step short of a real agent invocation, which the acceptance
 *   tail decides.
 * - `observed` — the interface declares it (help output, schema, tool list) but nothing ran it.
 * - `inferred` — derived from something adjacent: a name, a nearby flag, a convention.
 *
 * The pipeline treats `inferred` as a prompt to inspect further, not as a fact to compile. A backend that
 * cannot see the difference will confidently emit tools for capabilities that do not exist.
 */
export type Confidence = 'confirmed' | 'observed' | 'inferred'

/** How to bring the capability up and take it down around a call. */
export interface Lifecycle {
  /** Run once before first use, if the capability needs preparation. */
  readonly setup?: string
  /** Run after the last use. */
  readonly teardown?: string
}

/** One thing the target can do, in host-independent terms. */
export interface Capability {
  /** Stable within this set: lowercase, kebab-case, derived from the target and the operation. */
  readonly id: string
  /** Human name. */
  readonly name: string
  /** One line, written for a model to read — this becomes the tool description. */
  readonly description: string
  readonly source: CapabilitySource
  readonly invocation: Invocation
  readonly inputs: readonly CapabilityInput[]
  readonly outputs: readonly CapabilityOutput[]
  /** Other capabilities or binaries this one needs present. */
  readonly dependencies: readonly string[]
  readonly environment: readonly CapabilityEnvironment[]
  readonly permissions: Permissions
  readonly evidence: readonly Evidence[]
  readonly confidence: Confidence
  readonly lifecycle: Lifecycle
}

/** The whole compiled IR for one target. This is what a frontend emits and the backend consumes. */
export interface CapabilitySet {
  readonly irVersion: number
  /** What the target is, as established by inspection. */
  readonly target: {
    readonly name: string
    readonly description: string
    readonly source: CapabilitySource
  }
  readonly capabilities: readonly Capability[]
}

/**
 * Check a document against the IR's invariants.
 *
 * The IR is a boundary — frontends write it, the backend reads it — so it is validated on the way in rather
 * than trusted. This is also the one place where the "empty means unknown" trap can be caught: a capability
 * with no evidence and no inputs is far more likely to be a frontend bug than a genuinely nullary,
 * self-evident operation.
 *
 * @param value - the parsed document, of unknown shape.
 * @returns the problems found, empty when the document is valid.
 */
export function validateCapabilitySet(value: unknown): string[] {
  const problems: string[] = []
  if (typeof value !== 'object' || value === null) return ['the document is not an object']
  const set = value as Partial<CapabilitySet>

  if (set.irVersion !== IR_VERSION) {
    // Refuse rather than skip: a reader that silently ignores what it does not understand produces a plugin
    // that is missing capabilities with nothing saying so.
    problems.push(`irVersion must be ${IR_VERSION}; got ${String(set.irVersion)} — this reader refuses unknown versions rather than skipping them`)
    return problems
  }
  if (typeof set.target?.name !== 'string' || set.target.name === '') problems.push('target.name is required')
  if (typeof set.target?.description !== 'string' || set.target.description === '') {
    problems.push('target.description is required — it reaches the model')
  }
  if (!Array.isArray(set.capabilities) || set.capabilities.length === 0) {
    problems.push('capabilities must be a non-empty array')
    return problems
  }

  // `Array.isArray` narrows to `any[]`, so the element type is restated here. Without it every field access
  // below is silently `any` and the validator would accept any shape at all — which is the one thing a
  // boundary validator must not do.
  const capabilities = set.capabilities as readonly Partial<Capability>[]

  const seen = new Set<string>()
  capabilities.forEach((capability, index) => {
    const at = `capabilities[${index}]`
    if (typeof capability?.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capability.id)) {
      problems.push(`${at}.id must be lowercase kebab-case`)
    } else if (seen.has(capability.id)) {
      problems.push(`${at}.id "${capability.id}" is duplicated`)
    } else {
      seen.add(capability.id)
    }
    if (typeof capability?.description !== 'string' || capability.description === '') {
      problems.push(`${at}.description is required — it becomes the tool description the model reads`)
    }
    // Confidence and evidence must agree. `confirmed` with nothing observed is a frontend claiming a run it
    // did not do; `inferred` with observations is a frontend being more modest than its own data.
    const evidence = capability?.evidence ?? []
    if (capability?.confidence === 'confirmed' && evidence.length === 0) {
      problems.push(`${at}: confidence is "confirmed" but no evidence is recorded — record what was run`)
    }
    if (capability?.confidence === 'inferred' && evidence.length === 0) {
      problems.push(`${at}: confidence is "inferred" with no evidence — say what it was inferred from`)
    }
    // The empty-permissions trap: an empty risk surface must be a decision, not an omission.
    const permissions = capability?.permissions
    if (permissions === undefined) {
      problems.push(`${at}.permissions is required — declare what it touches, even if the answer is nothing`)
    } else if (
      permissions.filesystem.length === 0 && permissions.network.length === 0
      && permissions.process === false && permissions.secrets.length === 0
      && evidence.length === 0
    ) {
      problems.push(`${at}.permissions claims no filesystem, network, process, or secrets access with no evidence — empty permissions read as "touches nothing", so they need support`)
    }
    // Inputs referenced by the argument template must be declared, or the tool will call the target with a
    // placeholder still in it.
    const declared = new Set((capability?.inputs ?? []).map((input) => input.name))
    for (const arg of capability?.invocation?.args ?? []) {
      for (const match of arg.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)) {
        const name = match[1] ?? ''
        if (!declared.has(name)) {
          problems.push(`${at}.invocation.args references {{${name}}}, which is not a declared input`)
        }
      }
    }
  })
  return problems
}

/**
 * Serialize a capability set.
 *
 * Pretty-printed because the IR is a reviewable artifact: a human reads it to check what the pipeline
 * believes about a target before any plugin exists.
 *
 * @param set - the capability set.
 * @returns the JSON document.
 */
export function serialize(set: CapabilitySet): string {
  return `${JSON.stringify(set, null, 2)}\n`
}

/**
 * Parse and validate a capability set.
 * @param text - the JSON document.
 * @returns the parsed set.
 * @throws Error listing every problem, when the document is not a valid IR.
 */
export function parse(text: string): CapabilitySet {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error(`the capability IR is not valid JSON: ${(cause as Error).message}`)
  }
  const problems = validateCapabilitySet(value)
  if (problems.length > 0) {
    throw new Error(`the capability IR is invalid:\n  ${problems.join('\n  ')}`)
  }
  return value as CapabilitySet
}
