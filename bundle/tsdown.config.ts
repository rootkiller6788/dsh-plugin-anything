/**
 * Build for the native bundle.
 *
 * Two settings here are load-bearing, and both were found by building rather than by reading:
 *
 * 1. **`fixedExtension: false`** — without it tsdown emits `lib/index.mjs`, which the manifest's
 *    `main: "lib/index.js"` never points at. The build reports success and produces an artifact nothing can
 *    load. The first build of this package did exactly that. The dsh repo's own out-of-tree reference
 *    plugin (`dsh-context-compressor`) sets the same flag for the same reason.
 * 2. **`deps.neverBundle`** rather than the deprecated `external` — `@deepseek-ai/*` are the host's own
 *    runtime packages, and bundling them would duplicate the service instances the host already provides.
 *
 * `lib/types/**` is emitted separately by `tsc -b .` (the `build:types` script), so this config emits the
 * runtime JavaScript only and sets `dts: false`.
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
