# Backend: an HTTP/REST API

Same single-module rule as a CLI target: `src/provider.ts` is the only module that performs network I/O.

## Credentials are `Config`, never literals

A token in source is a credential leak the moment the plugin is published. Declare it as a config field and
let the deployment supply it — from the profile's `cordis.patch.yml`, from `$DSH_HOME/.credentials.yaml`, or
from the environment:

```ts
export interface Config {
  baseUrl?: string
  /** Token for the API. Supply from the environment; never commit it. */
  token?: string
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default('https://api.example.com'),
  token: z.string().default(''),
  timeoutMs: z.number().default(30_000),
})
```

In the patch row:

```yaml
      config:
        baseUrl: 'https://api.example.com'
        token: !!js process.env.EXAMPLE_TOKEN
```

Fail loud in `apply` when a required credential is absent, with a message naming the config field and the
env var — not with a 401 three tool calls later.

> `dsh` keeps managed credentials in `$DSH_HOME/.credentials.yaml` (owner-only, hot-reloaded), separate from
> `.env`. Prefer that over baking secrets into a committed patch.

## Always pass the signal

```ts
const response = await fetch(url, { signal: exec.signal, headers })
```

`exec.signal` is the model's cancellation. Dropping it means a cancelled turn leaves a request in flight.

## Treat the response as data, not as truth

The tool returns the canonical value your `output.schema` declares, so validate before returning: an API that
starts returning a string where you declared a number will otherwise produce a registration-time or
render-time failure far from the cause.

Do not return a raw JSON blob as the canonical value when the model only needs three fields from it. A
120-field object as the tool result burns context on every call and makes the value useless to Code Mode.

## Pagination

Do not hide pagination inside a tool that silently fetches everything — that turns one model call into an
unbounded number of requests. Either take a `limit` and report `truncated`, or expose a cursor the model
can advance deliberately.

## Render intent

An API call is not a shell command and usually not a diff, so the default `generic` card is correct. Give
it a real `title` and a `kind` so the UI can be useful:

```ts
presentCall(args) {
  return { card: 'generic', kind: 'fetch', title: `GET /widgets/${args.id}`, rawInput: { id: args.id } }
}
```

`rawInput` is *salient input for a detail view*, not the full args — do not paste the whole argument object
in, and never put the credential there.

If the endpoint returns a searchable collection, a `search` result card (`shape: 'matches' | 'paths'`) reads
better than a generic one.
