/**
 * The pipeline, as data.
 *
 * This is the project's spine, and it is the thing to consult before adding, removing, or arguing about a
 * tool. The axis is **coverage of the pipeline**, not the number of tools: a stage whose owner is
 * `deterministic` must be mechanized or nothing guarantees it happens the same way twice, while a stage
 * whose owner is `agent` must *not* be mechanized or the intelligence it needs is lost.
 *
 * Two mistakes this file exists to prevent:
 *
 * 1. **Judging a tool by whether an agent could have used bash instead.** That measures the implementation,
 *    not whether the stage belongs to the pipeline. An agent that hand-rolls a stage in one run has not
 *    shown the stage is unnecessary; it has shown the stage is currently unmechanized.
 * 2. **Assuming every path runs every stage.** A path is a subgraph. A user who already has a working
 *    dynamic cordis package does not need detection, inspection, or scaffolding — they need promotion. The
 *    stages that never vary across paths are the acceptance contract at the end.
 *
 * @module dsh-plugin-anything-bundle/pipeline
 */

/**
 * Who must perform a stage.
 *
 * - `agent` — requires judgement: reading an interface, extracting what matters, deciding a mapping.
 *   Mechanizing it replaces intelligence with a heuristic, and the heuristic will be wrong on the target
 *   nobody anticipated. This is the whole reason the project exists rather than being a code generator.
 * - `deterministic` — must be mechanized. It either has a correct answer (does this compile, does this
 *   profile boot) or a contract that cannot be re-derived per run (the gate's checks; the manifest's rules).
 * - `runtime` — must go through a host service. The capability exists only inside a running harness, so no
 *   amount of shell access substitutes for it.
 * - `external` — owned by something outside this project, and named here so the pipeline has no silent hole.
 */
export type StageOwner = 'agent' | 'deterministic' | 'runtime' | 'external'

/** What is actually built for a stage today. */
export type StageStatus = 'implemented' | 'partial' | 'absent' | 'external'

/** One stage of the pipeline. */
export interface Stage {
  /** Stable id, used by paths and by reports. */
  readonly id: string
  /** Position in the canonical listing. Paths may skip stages; the number does not change. */
  readonly ordinal: number
  /** Human name. */
  readonly name: string
  /** Who must perform it. */
  readonly owner: StageOwner
  /** Why that owner, in one line. This is the field that settles arguments. */
  readonly rationale: string
  /** What it consumes, and what it produces. */
  readonly consumes: string
  readonly produces: string
  /** The tool that mechanizes it, when one exists. */
  readonly tool?: string
  /** What exists today. */
  readonly status: StageStatus
}

/**
 * The canonical pipeline.
 *
 * Order is informational: a path selects its own subsequence. The numbering is kept stable so a report can
 * say "stage 14 is uncovered" without the number moving.
 */
export const STAGES: readonly Stage[] = [
  {
    id: 'detect',
    ordinal: 1,
    name: 'Detect',
    owner: 'deterministic',
    rationale: 'Classification from the target string plus filesystem/PATH facts. No judgement is involved, and getting it wrong sends the whole run down the wrong path.',
    consumes: 'a target: path, command name, URL, or repo',
    produces: 'a surface kind: cli | http | mcp | repo | package | unknown',
    tool: 'plugin_anything_probe',
    status: 'implemented',
  },
  {
    id: 'inspect',
    ordinal: 2,
    name: 'Inspect',
    owner: 'agent',
    rationale: 'Reading what an interface actually offers — subcommands, endpoints, schemas, entrypoints — needs judgement about what is signal. A heuristic enumerates; only a reader ranks.',
    consumes: 'the target, now classified',
    produces: 'inspection evidence: the raw material for capability extraction',
    // Agent-owned, but the gathering is mechanized: the tool collects bounded, reproducible evidence and
    // reports its own gaps. It deliberately does not summarise — that would be extraction wearing
    // inspection's name.
    tool: 'plugin_anything_inspect',
    status: 'implemented',
  },
  {
    id: 'extract',
    ordinal: 3,
    name: 'Capability extract',
    owner: 'agent',
    rationale: 'Deciding which of the things an interface can do are worth exposing, and grouping them, is the judgement the pipeline exists to preserve.',
    consumes: 'inspection evidence',
    produces: 'candidate capabilities (pre-IR)',
    status: 'absent',
  },
  {
    id: 'ir',
    ordinal: 4,
    name: 'Capability IR',
    owner: 'agent',
    rationale: 'The normalisation step. Its *output* is a contract, and it is the thing that makes the frontends interchangeable — but producing it from a novel interface is not mechanical.',
    consumes: 'candidate capabilities',
    produces: 'Capability IR (see ir.ts)',
    status: 'absent',
  },
  {
    id: 'plan',
    ordinal: 5,
    name: 'Plan / map',
    owner: 'agent',
    rationale: 'Mapping capabilities onto a dsh tool surface — how many tools, grouped how, with which render intents — is a design decision with no single right answer.',
    consumes: 'Capability IR',
    produces: 'a tool surface plan',
    status: 'absent',
  },
  {
    id: 'scaffold',
    ordinal: 6,
    name: 'Scaffold',
    owner: 'deterministic',
    rationale: 'The surrounding files are a fixed contract. Rendering them from templates keeps the shape identical across runs instead of re-derived and subtly different each time.',
    consumes: 'a tool surface plan',
    produces: 'bundle skeleton: manifest, patch, build config, skill',
    tool: 'plugin_anything_scaffold',
    status: 'implemented',
  },
  {
    id: 'implement',
    ordinal: 7,
    name: 'Implement',
    owner: 'deterministic',
    // This was `agent` until the IR existed, and reclassifying it is the point of having an IR. Every part of
    // a tool module — the invocation, the parameters, the canonical value, the egress — is already decided by
    // the time a capability reaches here. The judgement happened at extraction and planning; asking the
    // agent to write the file by hand after that is transcription, and transcription is where the details go
    // wrong.
    rationale: 'The adapter and presenters are fully described by the IR once extraction and planning are done. Writing them by hand after that is transcription, and the IR is what makes it mechanical.',
    consumes: 'Capability IR',
    produces: 'plugin source: provider, tool modules, entry, skill',
    tool: 'plugin_anything_compile',
    status: 'implemented',
  },
  {
    id: 'build',
    ordinal: 8,
    name: 'Build',
    owner: 'deterministic',
    rationale: 'Typecheck and compile either succeed or do not. It must also check that the artifact the manifest names is the artifact produced.',
    consumes: 'source',
    produces: 'lib/ + declarations',
    tool: 'plugin_anything_accept',
    status: 'implemented',
  },
  {
    id: 'verify',
    ordinal: 9,
    name: 'Verify',
    owner: 'deterministic',
    rationale: 'A gate whose checks cannot be re-derived per run. They were derived once, from the host contract, and every re-derivation is a chance to get them wrong.',
    consumes: 'a bundle',
    produces: 'static verdict',
    tool: 'plugin_anything_verify',
    status: 'implemented',
  },
  {
    id: 'install',
    ordinal: 10,
    name: 'Install',
    owner: 'deterministic',
    rationale: 'Installing into an isolated profile has a correct sequence and a reconciliation step that is easy to skip silently.',
    consumes: 'a built bundle',
    produces: 'a profile with the bundle installed',
    tool: 'plugin_anything_install',
    status: 'implemented',
  },
  {
    id: 'compose',
    ordinal: 11,
    name: 'Compose',
    owner: 'deterministic',
    rationale: 'Composition is where the bundle meets every other layer. It has a definitive answer and — as this project learned — a clean dump does not imply a boot, so it must be checked separately.',
    consumes: 'the profile',
    produces: 'the composed entry tree',
    tool: 'plugin_anything_accept',
    status: 'implemented',
  },
  {
    id: 'boot',
    ordinal: 12,
    name: 'Boot',
    owner: 'deterministic',
    rationale: 'The only step that detects duplicate entry ids, unresolved names, and load-time throws. Composition passing proves nothing about it.',
    consumes: 'the profile',
    produces: 'a settled plugin tree, or the reason it did not settle',
    tool: 'plugin_anything_accept',
    status: 'implemented',
  },
  {
    id: 'discover',
    ordinal: 13,
    name: 'Discover',
    owner: 'runtime',
    rationale: 'Whether the model can see a tool is known only to a running harness. The tool registry is a host service.',
    consumes: 'a booted profile',
    produces: 'the model-visible tool list',
    tool: 'plugin_anything_accept',
    status: 'implemented',
  },
  {
    id: 'invoke',
    ordinal: 14,
    name: 'Invoke',
    owner: 'runtime',
    rationale: 'A tool the model can see is not a tool it can call successfully. Only a real call distinguishes them.',
    consumes: 'a discovered tool',
    produces: 'a tool result, or a failure',
    tool: 'plugin_anything_accept',
    status: 'implemented',
  },
  {
    id: 'present',
    ordinal: 15,
    name: 'Present',
    owner: 'deterministic',
    rationale: 'The presenters are pure functions of args and result, so this is decidable without a model — given a logged result to replay.',
    consumes: 'a logged call and result',
    produces: 'the cards a user sees',
    tool: 'plugin_anything_accept',
    status: 'implemented',
  },
  {
    id: 'replay',
    ordinal: 16,
    name: 'Replay',
    owner: 'deterministic',
    rationale: 'Presenters also run on replay, so the same input must render identically and a foreign log must decline rather than throw. Both are mechanically checkable.',
    consumes: 'a session log',
    produces: 'replayed output, and a determinism verdict',
    tool: 'plugin_anything_accept',
    status: 'implemented',
  },
  {
    id: 'scan',
    ordinal: 17,
    name: 'Scan',
    owner: 'deterministic',
    rationale: 'The supply-chain surface is small and checkable, and a user should not have to read a manifest to find it. Folded into packaging rather than offered as a step: it exists to catch the case where nobody looked, and a check nobody is asked to run is the same as no check.',
    consumes: 'a bundle artifact and its manifest',
    produces: 'a supply-chain verdict, reported with the artifact',
    tool: 'plugin_anything_package',
    status: 'implemented',
  },
  {
    id: 'promote',
    ordinal: 18,
    name: 'Promote',
    owner: 'runtime',
    rationale: 'Reading a live dynamic package requires the host service that owns it. There is no filesystem path to a package that exists only in memory.',
    consumes: 'a live dynamic cordis package',
    produces: 'source on disk, and the trust escalation that comes with it',
    tool: 'plugin_anything_promote',
    status: 'implemented',
  },
  {
    id: 'package',
    ordinal: 19,
    name: 'Package',
    owner: 'deterministic',
    rationale: 'Producing the distribution artifact must be reproducible, and must contain the things the manifest promises — a mistake here is invisible until a user installs it.',
    consumes: 'a verified bundle',
    produces: 'a tarball, and a verdict on whether it carries what `files` promises',
    tool: 'plugin_anything_package',
    status: 'implemented',
  },
  {
    id: 'publish',
    ordinal: 20,
    name: 'Publish',
    owner: 'external',
    rationale: 'Registry submission is governed by the registry: its format, its age and commit requirements, its review. This project contributes an entry and validates it against those rules; it does not own them.',
    consumes: 'a packaged artifact',
    produces: 'a registry entry, then a listing',
    status: 'external',
  },
]

/** A way into the pipeline. Different inputs need different stages. */
export interface PipelinePath {
  /** The input this path serves. */
  readonly input: string
  /** Stage ids, in order. */
  readonly stages: readonly string[]
  /** Why this path skips what it skips. */
  readonly note: string
}

/**
 * The DAG's edges, one entry per input kind.
 *
 * These are the shapes that justify "not every path runs every stage". They converge on the same tail —
 * verify → install → compose → boot → discover → invoke — which is the acceptance contract: whatever you
 * start from, you are not done until an agent has used the thing.
 */
export const PATHS: readonly PipelinePath[] = [
  {
    input: 'cli',
    stages: ['detect', 'inspect', 'extract', 'ir', 'plan', 'scaffold', 'implement', 'build', 'verify', 'install', 'compose', 'boot', 'discover', 'invoke', 'present', 'replay'],
    note: 'The full path. A CLI has no machine-readable schema, so inspection is reading its help output.',
  },
  {
    input: 'http',
    stages: ['detect', 'inspect', 'extract', 'ir', 'plan', 'scaffold', 'implement', 'build', 'verify', 'install', 'compose', 'boot', 'discover', 'invoke', 'present', 'replay'],
    note: 'Same as cli, except inspection can often consume a machine-readable description (OpenAPI) instead of prose.',
  },
  {
    input: 'mcp',
    stages: ['detect'],
    note: 'A TERMINAL path. An MCP server already has a supported route into dsh; generating a plugin duplicates it. The correct output of this path is a config row, not an artifact.',
  },
  {
    input: 'dynamic-package',
    stages: ['promote', 'verify', 'install', 'compose', 'boot', 'discover', 'invoke', 'present', 'replay'],
    note: 'Something already works. Detection, inspection, and scaffolding would be re-deriving what the runtime can simply hand over — which is what promotion is for.',
  },
  {
    input: 'plugin-source',
    stages: ['verify', 'install', 'compose', 'boot', 'discover', 'invoke', 'present', 'replay'],
    note: 'A bundle already exists. Everything upstream would be regenerating work that is already done.',
  },
]

/**
 * The stages every non-terminal path must pass through.
 *
 * This is the acceptance contract in one line: whatever produced the artifact, an agent has to end up
 * having used it. A path that reaches this tail and skips part of it is an unfinished run, not a shortcut.
 */
export const ACCEPTANCE_TAIL: readonly string[] = [
  'verify', 'install', 'compose', 'boot', 'discover', 'invoke', 'present', 'replay',
]

/**
 * Find a stage by id.
 * @param id - the stage id.
 * @returns the stage, or undefined.
 */
export function stage(id: string): Stage | undefined {
  return STAGES.find((entry) => entry.id === id)
}

/**
 * Report where the pipeline stands, as five mutually exclusive groups.
 *
 * The groups **partition** the stages: every stage is in exactly one. That is not cosmetic — an earlier
 * version put every `agent` stage in one group and every tooled stage in another, so a stage that was both
 * (inspect: agent-owned, with a tool that gathers its evidence) was counted twice and the totals did not
 * add up. A report whose numbers do not add up is a report nobody checks.
 *
 * @returns the five groups. `owed` is the work; `supported` is the judgement this tooling actually helps.
 */
export function coverage(): {
  /** Deterministic or runtime stages *with* a tool: mechanized. */
  mechanized: Stage[]
  /** Deterministic or runtime stages with no tool: nothing guarantees them. */
  owed: Stage[]
  /** Agent stages with no tool: judgement with no mechanized support. Correct, and worth seeing. */
  byAgent: Stage[]
  /** Agent stages *with* a tool: judgement whose evidence-gathering is mechanized. */
  supported: Stage[]
  /** Stages owned outside this project. */
  external: Stage[]
} {
  const isJudgement = (entry: Stage): boolean => entry.owner === 'agent'
  return {
    mechanized: STAGES.filter((entry) => !isJudgement(entry) && entry.owner !== 'external' && entry.tool !== undefined),
    owed: STAGES.filter((entry) => !isJudgement(entry) && entry.owner !== 'external' && entry.tool === undefined),
    byAgent: STAGES.filter((entry) => isJudgement(entry) && entry.tool === undefined),
    supported: STAGES.filter((entry) => isJudgement(entry) && entry.tool !== undefined),
    external: STAGES.filter((entry) => entry.owner === 'external'),
  }
}
