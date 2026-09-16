/**
 * Self-contained build for this plugin.
 *
 * Deliberately NOT extending any config from a dsh checkout: a shared root config would pull in the
 * harness's type-graph generator and pin this plugin to being built inside a monorepo. A plugin that ships
 * from its own repository must build from its own repository alone.
 *
 * Two settings are load-bearing, and both were found by building:
 *
 * 1. **`fixedExtension: false`** — without it tsdown emits `lib/index.mjs`, which this package's
 *    `main: "lib/index.js"` never points at. The build reports success and produces an artifact nothing can
 *    load.
 * 2. **`deps.neverBundle`** rather than the deprecated `external` — `@deepseek-ai/*` are the host's own
 *    runtime packages, and bundling them would duplicate the service instances the host already provides.
 *
 * `lib/types/**` is emitted separately by `tsc -b .` (the `build:types` script); this config emits the
 * runtime JavaScript only, hence `dts: false`.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  // Emit `lib/index.js`, matching the manifest. See note 1 above.
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
  dts: false,
  clean: false,
})
