/**
 * The OpenAPI frontend: a machine-readable interface description compiled into Capability IR.
 *
 * This is the one target category where extraction is genuinely mechanical, and the reason is worth stating:
 * the hard part of extraction is deciding *which* of the things an interface can do are worth exposing. An
 * OpenAPI document has already made that decision — every documented operation is an intended capability,
 * with its inputs and outputs declared. Nothing is left to judgement, so a tool can do it.
 *
 * That is exactly why the other six categories get a recorded IR instead. A CLI's `--help` lists thirty
 * subcommands; which four matter is a reading, and a heuristic that guesses will be confidently wrong on
 * the target nobody anticipated. The distinction is the frontend boundary, not a difference in effort.
 *
 * @module dsh-plugin-anything-bundle/frontends/openapi
 */

import { IR_VERSION, type Capability, type CapabilitySet, type CapabilityInput, type CapabilityOutput } from '../ir.ts'

/** The subset of an OpenAPI 3 document this frontend reads. */
interface OpenApiDocument {
  readonly openapi?: string
  readonly info?: { readonly title?: string; readonly description?: string; readonly version?: string }
  readonly servers?: readonly { readonly url?: string }[]
  readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly components?: { readonly schemas?: Readonly<Record<string, unknown>> }
}

/** The HTTP methods OpenAPI documents operations under. */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

/**
 * Turn an operation id or a path into a kebab-case capability id.
 * @param operationId - the document's operation id, if it has one.
 * @param method - the HTTP method.
 * @param path - the path template.
 * @returns a kebab-case id.
 */
function capabilityId(operationId: string | undefined, method: string, path: string): string {
  const fromOperation = operationId === undefined ? '' : operationId
  const source = fromOperation !== ''
    ? fromOperation
    // Split camelCase, then let the common separators go.
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    : `${method}-${path}`
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? `${method}-root` : slug
}

/**
 * Map an OpenAPI parameter location onto the IR's notion of an input.
 *
 * The IR does not model locations — a capability either takes the value or it does not — so this drops the
 * distinction. What it keeps is whether the value is required, which a caller has to get right.
 *
 * @param parameter - one entry from `parameters`.
 * @returns the IR input, or undefined when the entry carries no name.
 */
function parameterToInput(parameter: unknown): CapabilityInput | undefined {
  if (typeof parameter !== 'object' || parameter === null) return undefined
  const record = parameter as {
    name?: unknown
    description?: unknown
    required?: unknown
    in?: unknown
    schema?: { type?: unknown; enum?: unknown }
  }
  if (typeof record.name !== 'string' || record.name === '') return undefined
  const schemaType = typeof record.schema?.type === 'string' ? record.schema.type : 'string'
  const type = ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(schemaType)
    ? schemaType as CapabilityInput['type']
    : 'string'
  const enumValues = Array.isArray(record.schema?.enum)
    ? record.schema.enum.filter((value): value is string => typeof value === 'string')
    : undefined
  return {
    name: record.name,
    description: typeof record.description === 'string' && record.description !== ''
      ? record.description
      : `${record.name} (${String(record.in ?? 'parameter')})`,
    type,
    required: record.required === true,
    ...(enumValues === undefined || enumValues.length === 0 ? {} : { enum: enumValues }),
  }
}

/**
 * Compile an OpenAPI document into Capability IR.
 *
 * @param text - the document, as JSON.
 * @param location - where it came from, recorded as provenance.
 * @returns the capability set.
 * @throws Error when the document is not parseable or declares no operations.
 */
export function compileOpenApi(text: string, location: string): CapabilitySet {
  let document: OpenApiDocument
  try {
    document = JSON.parse(text) as OpenApiDocument
  } catch (cause) {
    throw new Error(`the OpenAPI document is not valid JSON: ${(cause as Error).message}`)
  }
  if (typeof document.paths !== 'object' || document.paths === null) {
    throw new Error('the OpenAPI document declares no `paths`, so it describes no operations')
  }

  const baseUrl = document.servers?.[0]?.url ?? ''
  if (baseUrl === '') {
    // Named rather than defaulted: an invented base URL would produce a bundle whose every call goes
    // somewhere arbitrary, and nothing downstream could tell that it had been guessed.
    throw new Error('the OpenAPI document declares no `servers[0].url`, so there is no base to call')
  }

  const capabilities: Capability[] = []
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = operations[method]
      if (typeof operation !== 'object' || operation === null) continue
      const record = operation as {
        operationId?: unknown
        summary?: unknown
        description?: unknown
        parameters?: unknown
        requestBody?: unknown
        responses?: unknown
      }
      const id = capabilityId(typeof record.operationId === 'string' ? record.operationId : undefined, method, path)
      const description = typeof record.summary === 'string' && record.summary !== ''
        ? record.summary
        : typeof record.description === 'string' && record.description !== ''
          ? record.description
          : `${method.toUpperCase()} ${path}`

      const inputs = Array.isArray(record.parameters)
        ? record.parameters.map(parameterToInput).filter((input): input is CapabilityInput => input !== undefined)
        : []

      // The document declares responses; what a caller gets back is the body. Naming the declared content
      // type rather than the schema keeps this honest — the IR has no way to carry a JSON Schema, and
      // inventing an `object` output would compile to a tool that returns raw JSON without saying so.
      const outputs: CapabilityOutput[] = [{
        name: 'body',
        description: `The ${method.toUpperCase()} ${path} response body.`,
        type: 'string',
      }]

      capabilities.push({
        id,
        name: typeof record.operationId === 'string' ? record.operationId : `${method.toUpperCase()} ${path}`,
        description,
        source: {
          kind: 'openapi',
          location,
          ...(document.info?.version === undefined ? {} : { version: document.info.version }),
        },
        invocation: {
          type: 'http',
          // The path template keeps its `{{name}}` placeholders, which the capability's inputs bind.
          transport: `${baseUrl.replace(/\/+$/, '')}${path.replace(/\{([^}]+)\}/g, '{{$1}}')}`,
        },
        inputs,
        outputs,
        dependencies: [],
        environment: [],
        permissions: {
          filesystem: [],
          network: [hostOf(baseUrl)],
          process: false,
          secrets: [],
        },
        // The document is the evidence: it declared this operation. Nothing was run, so the confidence is
        // `observed` and never `confirmed` — a tool that claimed otherwise would be reporting a run it did
        // not perform, which `validateCapabilitySet` refuses anyway.
        evidence: [{ stage: 'inspect', observed: `${method.toUpperCase()} ${path} declared in ${location}` }],
        confidence: 'observed',
        lifecycle: {},
      })
    }
  }

  if (capabilities.length === 0) {
    throw new Error('the OpenAPI document declares no operations this frontend can read')
  }

  return {
    irVersion: IR_VERSION,
    target: {
      name: document.info?.title ?? 'openapi-service',
      description: document.info?.description ?? `An OpenAPI service at ${baseUrl}.`,
      source: { kind: 'openapi', location, ...(document.info?.version === undefined ? {} : { version: document.info.version }) },
    },
    capabilities,
  }
}

/**
 * Extract the host from a URL, for the permission declaration.
 * @param url - the base URL.
 * @returns the host, or the URL unchanged when it does not parse.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
